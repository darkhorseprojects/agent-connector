use crate::{
    config::Deployment,
    credentials::Token,
    discord::{self, RuntimeState},
};
use anyhow::{Context, Result, bail, ensure};
use fs4::fs_std::FileExt;
use process_wrap::std::CommandWrap;
#[cfg(unix)]
use process_wrap::std::ProcessSession;

use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, atomic::Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::watch,
};

#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

#[cfg(unix)]
struct ControlEndpoint(UnixListener);
#[cfg(windows)]
struct ControlEndpoint(NamedPipeServer);

const CONTROL_MAX: u64 = 4096;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Descriptor {
    version: u8,
    identity: String,
    endpoint: String,
    secret: String,
    pid: u32,
}

#[derive(Deserialize, Serialize)]
struct Request {
    version: u8,
    identity: String,
    secret: String,
    command: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Status {
    pub state: String,
    pub pid: u32,
    pub active: usize,
    pub queued: usize,
    pub started_at: u64,
}

#[derive(Deserialize, Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<Status>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct Instance {
    descriptor: PathBuf,
    #[cfg(unix)]
    socket: PathBuf,
    _lock: File,
}

impl Drop for Instance {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.descriptor);
        #[cfg(unix)]
        let _ = fs::remove_file(&self.socket);
    }
}

pub async fn run(deployment: Arc<Deployment>, token: Token, agent: PathBuf) -> Result<()> {
    let (instance, descriptor, endpoint) = acquire(&deployment)?;
    let state = Arc::new(RuntimeState::default());
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut control = tokio::spawn(control_server(
        endpoint,
        descriptor.clone(),
        state.clone(),
        started_at,
        shutdown_tx.clone(),
        shutdown_rx.clone(),
    ));
    let discord = discord::serve(deployment, token, agent, shutdown_rx, state);
    tokio::pin!(discord);
    enum End {
        Discord(Result<()>),
        Control(Result<Result<()>, tokio::task::JoinError>),
        Signal(Result<(), std::io::Error>),
    }
    let end = tokio::select! {
        result = &mut discord => End::Discord(result),
        result = &mut control => End::Control(result),
        signal = shutdown_signal() => End::Signal(signal),
    };
    let _ = shutdown_tx.send(true);
    let outcome = match end {
        End::Discord(result) => {
            control.await.context("control server failed")??;
            result
        }
        End::Control(result) => {
            result.context("control server failed")??;
            let _ = discord.await;
            bail!("control server stopped unexpectedly")
        }
        End::Signal(result) => {
            result.context("cannot wait for interrupt")?;
            let result = discord.await;
            control.await.context("control server failed")??;
            result
        }
    };
    drop(instance);
    outcome
}

#[cfg(unix)]
async fn shutdown_signal() -> std::io::Result<()> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => result,
        _ = terminate.recv() => Ok(()),
    }
}

#[cfg(windows)]
async fn shutdown_signal() -> std::io::Result<()> {
    tokio::signal::ctrl_c().await
}

pub async fn status(deployment: &Deployment) -> Result<Option<Status>> {
    let path = descriptor_path(deployment)?;
    if !path.is_file() {
        return Ok(None);
    }
    let descriptor = read_descriptor(&path)?;
    ensure!(
        descriptor.identity == deployment.identity.0,
        "runtime descriptor belongs to another Agent"
    );
    let response = request(&descriptor, "status").await?;
    ensure!(
        response.ok,
        "control rejected status: {}",
        response.error.unwrap_or_default()
    );
    Ok(response.status)
}

pub async fn down(deployment: &Deployment) -> Result<()> {
    let descriptor = read_descriptor(&descriptor_path(deployment)?)?;
    let response = request(&descriptor, "shutdown").await?;
    ensure!(
        response.ok,
        "control rejected shutdown: {}",
        response.error.unwrap_or_default()
    );
    let maximum = deployment
        .config
        .policies
        .values()
        .map(|policy| policy.timeout_value)
        .max()
        .unwrap_or_default()
        .saturating_add(Duration::from_secs(10));
    tokio::time::timeout(maximum, async {
        while descriptor_path(deployment)?.exists() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("Agent Connector did not stop before its active invocation deadline")??;
    Ok(())
}

pub async fn up(deployment: &Deployment) -> Result<()> {
    ensure!(
        status(deployment).await.ok().flatten().is_none(),
        "Agent Connector is already running"
    );
    let executable = std::env::current_exe().context("cannot resolve agc executable")?;
    let log = log_path(deployment)?;
    if let Some(parent) = log.parent() {
        private_directory(parent)?;
    }
    let stdout = private_log(&log)?;
    let stderr = stdout.try_clone()?;
    let root = deployment.root.clone();
    let mut command = CommandWrap::with_new(executable, move |command| {
        command
            .arg("run")
            .arg(root)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0000_0008 | 0x0000_0200);
        }
    });
    #[cfg(unix)]
    command.wrap(ProcessSession);
    let mut child = command.spawn().context("cannot start Agent Connector")?;
    for _ in 0..300 {
        if status(deployment)
            .await
            .ok()
            .flatten()
            .is_some_and(|status| status.state == "ready")
        {
            return Ok(());
        }
        if let Some(result) = child.try_wait()? {
            bail!("Agent Connector exited before readiness with {result}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill();
    bail!("Agent Connector did not become ready within 30 seconds")
}

async fn control_server(
    endpoint: ControlEndpoint,
    descriptor: Descriptor,
    state: Arc<RuntimeState>,
    started_at: u64,
    shutdown: watch::Sender<bool>,
    mut stopped: watch::Receiver<bool>,
) -> Result<()> {
    #[cfg(unix)]
    {
        let listener = endpoint.0;
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (stream, _) = accepted?;
                    if let Err(error) = serve_control(stream, &descriptor, &state, started_at, &shutdown).await {
                        eprintln!("control request failed: {error:#}");
                    }
                }
                changed = stopped.changed() => if changed.is_err() || *stopped.borrow() { break },
            }
        }
    }
    #[cfg(windows)]
    {
        let mut server = endpoint.0;
        loop {
            tokio::select! {
                connected = server.connect() => {
                    connected?;
                    if let Err(error) = serve_control(server, &descriptor, &state, started_at, &shutdown).await {
                        eprintln!("control request failed: {error:#}");
                    }
                    server = ServerOptions::new().create(&descriptor.endpoint)?;
                }
                changed = stopped.changed() => if changed.is_err() || *stopped.borrow() { break },
            }
        }
    }
    Ok(())
}

async fn serve_control<S>(
    stream: S,
    descriptor: &Descriptor,
    state: &RuntimeState,
    started_at: u64,
    shutdown: &watch::Sender<bool>,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::time::timeout(
        Duration::from_secs(2),
        exchange_control(stream, descriptor, state, started_at, shutdown),
    )
    .await
    .context("control request timed out")?
}

async fn exchange_control<S>(
    stream: S,
    descriptor: &Descriptor,
    state: &RuntimeState,
    started_at: u64,
    shutdown: &watch::Sender<bool>,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (read, mut write) = tokio::io::split(stream);
    let mut line = String::new();
    BufReader::new(read)
        .take(CONTROL_MAX + 1)
        .read_line(&mut line)
        .await?;
    let request: Request =
        serde_json::from_str(line.trim_end()).context("invalid control request")?;
    let authorized = request.version == 1
        && request.identity == descriptor.identity
        && request.secret == descriptor.secret;
    let response = if !authorized {
        Response {
            ok: false,
            status: None,
            error: Some("unauthorized".into()),
        }
    } else if request.command == "status" {
        Response {
            ok: true,
            status: Some(Status {
                state: if state.ready.load(Ordering::Acquire) {
                    "ready"
                } else {
                    "starting"
                }
                .into(),
                pid: descriptor.pid,
                active: state.active.load(Ordering::Acquire),
                queued: state.queued.load(Ordering::Acquire),
                started_at,
            }),
            error: None,
        }
    } else if request.command == "shutdown" {
        let _ = shutdown.send(true);
        Response {
            ok: true,
            status: None,
            error: None,
        }
    } else {
        Response {
            ok: false,
            status: None,
            error: Some("unknown command".into()),
        }
    };
    write
        .write_all(serde_json::to_string(&response)?.as_bytes())
        .await?;
    write.write_all(b"\n").await?;
    write.shutdown().await?;
    Ok(())
}

async fn request(descriptor: &Descriptor, command: &str) -> Result<Response> {
    tokio::time::timeout(Duration::from_secs(2), request_inner(descriptor, command))
        .await
        .context("control response timed out")?
}

async fn request_inner(descriptor: &Descriptor, command: &str) -> Result<Response> {
    let request = Request {
        version: 1,
        identity: descriptor.identity.clone(),
        secret: descriptor.secret.clone(),
        command: command.into(),
    };
    #[cfg(unix)]
    let stream = UnixStream::connect(&descriptor.endpoint)
        .await
        .context("Agent Connector is not reachable")?;
    #[cfg(windows)]
    let stream = ClientOptions::new()
        .open(&descriptor.endpoint)
        .context("Agent Connector is not reachable")?;
    let (read, mut write) = tokio::io::split(stream);
    write
        .write_all(serde_json::to_string(&request)?.as_bytes())
        .await?;
    write.write_all(b"\n").await?;
    write.shutdown().await?;
    let mut line = String::new();
    BufReader::new(read)
        .take(CONTROL_MAX + 1)
        .read_line(&mut line)
        .await?;
    serde_json::from_str(line.trim_end()).context("invalid control response")
}

fn acquire(deployment: &Deployment) -> Result<(Instance, Descriptor, ControlEndpoint)> {
    let directory = runtime_directory(deployment)?;
    private_directory(&directory)?;
    let lock_path = directory.join("lock");
    let lock = private_file(&lock_path, false)?;
    lock.try_lock_exclusive()
        .context("Agent Connector is already running")?;
    let descriptor_path = directory.join("control.json");
    let _ = fs::remove_file(&descriptor_path);
    #[cfg(unix)]
    let endpoint = directory.join("control.sock");
    #[cfg(unix)]
    {
        let _ = fs::remove_file(&endpoint);
        ensure!(
            endpoint.as_os_str().as_encoded_bytes().len() < 100,
            "control socket path is too long"
        );
    }
    #[cfg(windows)]
    let endpoint = PathBuf::from(format!(
        r"\\.\pipe\agent-connector-{}",
        deployment.identity.0
    ));
    #[cfg(unix)]
    let control = {
        let listener = UnixListener::bind(&endpoint).context("cannot bind control socket")?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&endpoint, fs::Permissions::from_mode(0o600))?;
        ControlEndpoint(listener)
    };
    #[cfg(windows)]
    let control = ControlEndpoint(
        ServerOptions::new()
            .first_pipe_instance(true)
            .create(endpoint.as_os_str())?,
    );
    let mut random = [0u8; 32];
    rand::rng().fill_bytes(&mut random);
    let descriptor = Descriptor {
        version: 1,
        identity: deployment.identity.0.clone(),
        endpoint: endpoint.to_string_lossy().into_owned(),
        secret: hex::encode(random),
        pid: std::process::id(),
    };
    write_private_json(&descriptor_path, &descriptor)?;
    Ok((
        Instance {
            descriptor: descriptor_path,
            #[cfg(unix)]
            socket: endpoint,
            _lock: lock,
        },
        descriptor,
        control,
    ))
}

fn runtime_directory(deployment: &Deployment) -> Result<PathBuf> {
    #[cfg(test)]
    let base = std::env::temp_dir().join("agent-connector-tests");
    #[cfg(all(unix, not(test)))]
    let base = home::home_dir()
        .context("home directory is unavailable")?
        .join(".agents/run/agent-connector");
    #[cfg(all(windows, not(test)))]
    let base =
        PathBuf::from(std::env::var_os("LOCALAPPDATA").context("LOCALAPPDATA is unavailable")?)
            .join("Agent Connector")
            .join("run");
    Ok(base.join(&deployment.identity.0[..32]))
}

fn descriptor_path(deployment: &Deployment) -> Result<PathBuf> {
    Ok(runtime_directory(deployment)?.join("control.json"))
}

fn log_path(deployment: &Deployment) -> Result<PathBuf> {
    Ok(runtime_directory(deployment)?.join("connector.log"))
}

fn read_descriptor(path: &Path) -> Result<Descriptor> {
    private_metadata(path)?;
    ensure!(
        fs::metadata(path)?.len() <= CONTROL_MAX,
        "runtime descriptor is too large"
    );
    serde_json::from_slice(&fs::read(path)?).context("invalid runtime descriptor")
}

fn write_private_json(path: &Path, value: &Descriptor) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = private_file(&temporary, true)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    #[cfg(unix)]
    File::open(path.parent().expect("descriptor path has parent"))?.sync_all()?;
    Ok(())
}

fn private_log(path: &Path) -> Result<File> {
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    windows_acl(path)?;
    Ok(file)
}

fn private_file(path: &Path, truncate: bool) -> Result<File> {
    let mut options = fs::OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .truncate(truncate);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    windows_acl(path)?;
    Ok(file)
}

fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "runtime path is not a physical directory"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    windows_acl(path)?;
    Ok(())
}

fn private_metadata(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("Agent Connector is not running: {}", path.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "runtime descriptor is not a physical file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "runtime descriptor is not private"
        );
    }
    #[cfg(windows)]
    windows_acl(path)?;
    Ok(())
}

#[cfg(windows)]
fn windows_acl(path: &Path) -> Result<()> {
    let domain = std::env::var("USERDOMAIN").context("USERDOMAIN is unavailable")?;
    let user = std::env::var("USERNAME").context("USERNAME is unavailable")?;
    let reset = std::process::Command::new("icacls.exe")
        .arg(path)
        .arg("/reset")
        .output()
        .context("cannot reset runtime ACL")?;
    ensure!(
        reset.status.success(),
        "cannot reset runtime ACL: {}",
        String::from_utf8_lossy(&reset.stderr).trim()
    );
    let secured = std::process::Command::new("icacls.exe")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!(r"{domain}\{user}:(F)"))
        .arg("*S-1-5-18:(F)")
        .output()
        .context("cannot secure runtime ACL")?;
    ensure!(
        secured.status.success(),
        "cannot secure runtime ACL: {}",
        String::from_utf8_lossy(&secured.stderr).trim()
    );
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::{RuntimeState, acquire, control_server, request, runtime_directory, status};
    use crate::config::{Config, Deployment, Discord, Identity};
    use std::{
        collections::BTreeMap,
        path::PathBuf,
        sync::{Arc, atomic::Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::sync::watch;

    fn deployment() -> Deployment {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Deployment {
            root: PathBuf::from("/agent"),
            identity: Identity(format!("{unique:064x}")),
            config: Config {
                discord: Discord {
                    application: 1,
                    bot: 2,
                },
                policies: BTreeMap::new(),
                users: BTreeMap::new(),
                channels: BTreeMap::new(),
                guilds: BTreeMap::new(),
            },
        }
    }

    #[tokio::test]
    async fn control_is_authenticated_and_single_instance() {
        let deployment = deployment();
        let (instance, descriptor, endpoint) = acquire(&deployment).unwrap();
        let state = Arc::new(RuntimeState::default());
        let (shutdown, stopped) = watch::channel(false);
        let task = tokio::spawn(control_server(
            endpoint,
            descriptor.clone(),
            state.clone(),
            7,
            shutdown,
            stopped,
        ));
        let starting = status(&deployment).await.unwrap().unwrap();
        assert_eq!(starting.state, "starting");
        state.ready.store(true, Ordering::Release);
        assert_eq!(status(&deployment).await.unwrap().unwrap().state, "ready");
        let mut invalid = descriptor.clone();
        invalid.secret = "wrong".into();
        assert!(!request(&invalid, "status").await.unwrap().ok);
        assert!(request(&descriptor, "shutdown").await.unwrap().ok);
        task.await.unwrap().unwrap();
        drop(instance);
        assert!(status(&deployment).await.unwrap().is_none());
        std::fs::remove_dir_all(runtime_directory(&deployment).unwrap()).unwrap();
    }
}
