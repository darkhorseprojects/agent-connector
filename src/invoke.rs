use crate::config::{Deployment, Policy};
use anyhow::{Context, Result, bail, ensure};
#[cfg(windows)]
use process_wrap::tokio::JobObject;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{CommandWrap, KillOnDrop};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const STDOUT_MAX: usize = 8_000;
const STDERR_MAX: usize = 65_536;
const OUTER_GRACE: Duration = Duration::from_secs(5);

pub struct Invocation<'a> {
    pub deployment: &'a Deployment,
    pub policy: &'a Policy,
    pub actor: u64,
    pub input: &'a str,
}

#[cfg(unix)]
struct GroupGuard(Option<i32>);

#[cfg(unix)]
impl Drop for GroupGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}

pub async fn execute(agent: &Path, request: Invocation<'_>) -> Result<String> {
    let root = request.deployment.root.clone();
    let entry = request.policy.entry.clone();
    let authority = request.policy.authority.clone();
    let memory = request.policy.memory.clone();
    let deadline = request.policy.timeout.clone();
    let directory = request.policy.directory.clone();
    let actor = request.actor.to_string();
    let input = request.input.as_bytes().to_vec();

    let mut command = CommandWrap::with_new(agent, move |command| {
        command
            .args(["run", "--directory"])
            .arg(root)
            .args(["--entry", &entry]);
        for path in authority {
            command.args(["--authority", &path]);
        }
        command
            .args(["--memory", &memory, "--timeout", &deadline, "--", &actor])
            .current_dir(directory)
            .env_remove("DISCORD_TOKEN")
            .env_remove("AGC_DISCORD_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
    });
    #[cfg(unix)]
    command.wrap(ProcessGroup::leader());
    #[cfg(windows)]
    command.wrap(JobObject);
    command.wrap(KillOnDrop);

    let mut child = command.spawn().context("failed to start agent")?;
    #[cfg(unix)]
    let mut group = GroupGuard(Some(i32::try_from(
        child.id().context("agent has no process ID")?,
    )?));
    let mut stdin = child.stdin().take().context("agent stdin is unavailable")?;
    let stdout = child
        .stdout()
        .take()
        .context("agent stdout is unavailable")?;
    let stderr = child
        .stderr()
        .take()
        .context("agent stderr is unavailable")?;
    let stdout_task = tokio::spawn(read_bounded(stdout, STDOUT_MAX));
    let stderr_task = tokio::spawn(read_bounded(stderr, STDERR_MAX));
    let input_task = tokio::spawn(async move {
        stdin.write_all(&input).await?;
        stdin.shutdown().await
    });

    let timeout = request.policy.timeout_value.saturating_add(OUTER_GRACE);
    let completed = tokio::time::timeout(timeout, async {
        let (status, (), stdout, stderr) = tokio::try_join!(
            async { child.wait().await.context("failed to wait for agent") },
            async {
                input_task.await.context("agent stdin task failed")??;
                Ok::<_, anyhow::Error>(())
            },
            async { stdout_task.await.context("agent stdout task failed")? },
            async { stderr_task.await.context("agent stderr task failed")? },
        )?;
        Ok::<_, anyhow::Error>((status, stdout, stderr))
    })
    .await;
    let (status, stdout, _stderr) = match completed {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            let _ = std::pin::Pin::from(child.kill()).await;
            return Err(error);
        }
        Err(_) => {
            let _ = std::pin::Pin::from(child.kill()).await;
            bail!("agent invocation exceeded its outer deadline");
        }
    };
    #[cfg(unix)]
    {
        group.0 = None;
    }
    ensure!(status.success(), "agent exited with {status}");
    ensure!(!stdout.is_empty(), "agent returned an empty result");
    ensure!(!stdout.contains(&0), "agent result contains NUL");
    let output = String::from_utf8(stdout).context("agent result is not UTF-8")?;
    ensure!(
        output.chars().count() <= 2_000,
        "agent result exceeds one Discord message"
    );
    Ok(output)
}

async fn read_bounded(stream: impl AsyncRead + Unpin, maximum: usize) -> Result<Vec<u8>> {
    let mut output = Vec::with_capacity(maximum.min(4096));
    stream
        .take((maximum + 1) as u64)
        .read_to_end(&mut output)
        .await?;
    ensure!(
        output.len() <= maximum,
        "agent output exceeded {maximum} bytes"
    );
    Ok(output)
}
