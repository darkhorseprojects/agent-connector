use std::{fs, process::Command};
use tempfile::TempDir;

fn package() -> TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("main.md"), "# Main\n").unwrap();
    fs::write(
        root.path().join("agent-connector.yaml"),
        format!(
            r#"version: 1
discord:
  application: "1"
  bot: "2"
policies:
  main:
    entry: main.md
    directory: {}
    memory: 1MiB
    timeout: 1s
users:
  "3": main
"#,
            root.path().display()
        ),
    )
    .unwrap();
    root
}

fn agc() -> Command {
    Command::new(env!("CARGO_BIN_EXE_agc"))
}

#[test]
fn help_version_and_arguments_are_exact() {
    assert!(agc().arg("--help").output().unwrap().status.success());
    assert_eq!(
        agc().arg("--version").output().unwrap().stdout,
        format!("agc {}\n", env!("CARGO_PKG_VERSION")).as_bytes()
    );
    assert!(
        !agc()
            .args(["one", "two"])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert!(
        !agc()
            .args(["auto", "maybe"])
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[test]
fn detects_only_the_current_agent_directory() {
    let root = package();
    let home = tempfile::tempdir().unwrap();
    let output = agc()
        .current_dir(root.path())
        .env("HOME", home.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("Config:     valid"));

    let child = root.path().join("child");
    fs::create_dir(&child).unwrap();
    let output = agc()
        .current_dir(child)
        .env("HOME", home.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("DIRECTORY is required"));
}
