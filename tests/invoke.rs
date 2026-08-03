#![cfg(unix)]

use agent_connector::{
    config::{Config, Deployment, Discord, Identity, Policy},
    invoke::{self, Invocation},
};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};

fn deployment(root: &std::path::Path, work: &std::path::Path, timeout: Duration) -> Deployment {
    let policy = Policy {
        entry: "main.md".into(),
        authority: vec!["trusted.lua".into()],
        directory: work.into(),
        memory: "1MiB".into(),
        timeout: humantime::format_duration(timeout).to_string(),
        timeout_value: timeout,
    };
    Deployment {
        root: root.into(),
        identity: Identity("test".into()),
        config: Config {
            discord: Discord {
                application: 1,
                bot: 2,
            },
            policies: BTreeMap::from([("main".into(), policy)]),
            users: BTreeMap::new(),
            channels: BTreeMap::new(),
            guilds: BTreeMap::new(),
        },
    }
}

fn script(directory: &std::path::Path, source: &str) -> std::path::PathBuf {
    let path = directory.join("agent");
    fs::write(&path, format!("#!/bin/sh\n{source}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

#[tokio::test]
async fn preserves_input_cwd_and_exact_arguments() {
    let root = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let agent = script(
        root.path(),
        r#"printf '%s\n' "$@" > "$0.args"
pwd > "$0.cwd"
[ -z "${DISCORD_TOKEN+x}" ]
[ -z "${AGC_DISCORD_TOKEN+x}" ]
cat"#,
    );
    let deployment = deployment(root.path(), work.path(), Duration::from_secs(1));
    let policy = deployment.config.policies.get("main").unwrap();
    let output = invoke::execute(
        &agent,
        Invocation {
            deployment: &deployment,
            policy,
            actor: 42,
            input: " exact\nrequest ",
        },
    )
    .await
    .unwrap();
    assert_eq!(output, " exact\nrequest ");
    assert_eq!(
        fs::read_to_string(agent.with_extension("cwd"))
            .unwrap()
            .trim(),
        work.path().to_str().unwrap()
    );
    assert_eq!(
        fs::read_to_string(agent.with_extension("args"))
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        [
            "run",
            "--directory",
            root.path().to_str().unwrap(),
            "--entry",
            "main.md",
            "--authority",
            "trusted.lua",
            "--memory",
            "1MiB",
            "--timeout",
            "1s",
            "--",
            "42",
        ]
    );
}

#[tokio::test]
async fn rejects_invalid_and_oversized_results() {
    let root = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let deployment = deployment(root.path(), work.path(), Duration::from_secs(1));
    let policy = deployment.config.policies.get("main").unwrap();
    let invalid = script(root.path(), "printf '\\377'");
    assert!(
        invoke::execute(
            &invalid,
            Invocation {
                deployment: &deployment,
                policy,
                actor: 1,
                input: ""
            }
        )
        .await
        .is_err()
    );
    let large = script(root.path(), "head -c 8001 /dev/zero | tr '\\0' x");
    assert!(
        invoke::execute(
            &large,
            Invocation {
                deployment: &deployment,
                policy,
                actor: 1,
                input: ""
            }
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn cancelled_invocation_terminates_the_complete_process_group() {
    let root = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let marker = root.path().join("cancelled-orphan");
    let source = format!(
        "(sleep 1; printf orphan > '{}') &\nsleep 30",
        marker.display()
    );
    let agent = script(root.path(), &source);
    let deployment = deployment(root.path(), work.path(), Duration::from_secs(30));
    let task = tokio::spawn(async move {
        let policy = deployment.config.policies.get("main").unwrap();
        invoke::execute(
            &agent,
            Invocation {
                deployment: &deployment,
                policy,
                actor: 1,
                input: "",
            },
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    task.abort();
    let _ = task.await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(!marker.exists());
}

#[tokio::test]
async fn overflow_terminates_the_complete_process_group() {
    let root = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let marker = root.path().join("orphan");
    let source = format!(
        "(sleep 1; printf orphan > '{}') &\ntrap '' PIPE\nhead -c 9000 /dev/zero | tr '\\0' x\nsleep 30",
        marker.display()
    );
    let agent = script(root.path(), &source);
    let deployment = deployment(root.path(), work.path(), Duration::from_secs(30));
    let policy = deployment.config.policies.get("main").unwrap();
    let start = Instant::now();
    assert!(
        invoke::execute(
            &agent,
            Invocation {
                deployment: &deployment,
                policy,
                actor: 1,
                input: ""
            }
        )
        .await
        .is_err()
    );
    assert!(start.elapsed() < Duration::from_secs(3));
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(!marker.exists());
}
