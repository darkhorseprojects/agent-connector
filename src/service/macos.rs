use super::ServiceStatus;
use crate::config::Deployment;
use anyhow::{Context, Result, ensure};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn label(deployment: &Deployment) -> String {
    format!(
        "dev.portable-agents.connector.{}",
        &deployment.identity.0[..32]
    )
}

fn path(deployment: &Deployment) -> Result<PathBuf> {
    Ok(home::home_dir()
        .context("home directory is unavailable")?
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", label(deployment))))
}

pub fn enable(deployment: &Deployment, executable: &Path) -> Result<()> {
    let path = path(deployment)?;
    fs::create_dir_all(path.parent().expect("service path has parent"))?;
    let executable = service_path(executable)?;
    let root = service_path(&deployment.root)?;
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{}</string>
<key>ProgramArguments</key><array><string>{}</string><string>run</string><string>{}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
"#,
        xml(&label(deployment)),
        xml(executable),
        xml(root)
    );
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, plist)?;
    fs::rename(temporary, &path)?;
    launchctl(&[
        "bootstrap",
        &format!("gui/{}", uid()),
        path.to_str().context("service path is not UTF-8")?,
    ])
}

pub fn disable(deployment: &Deployment) -> Result<()> {
    let path = path(deployment)?;
    if path.exists() {
        launchctl(&["bootout", &format!("gui/{}/{}", uid(), label(deployment))])?;
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn status(deployment: &Deployment) -> Result<ServiceStatus> {
    Ok(if path(deployment)?.is_file() {
        ServiceStatus::Enabled
    } else {
        ServiceStatus::Disabled
    })
}

fn launchctl(arguments: &[&str]) -> Result<()> {
    let output = Command::new("launchctl")
        .args(arguments)
        .output()
        .context("cannot execute launchctl")?;
    ensure!(
        output.status.success(),
        "launchctl failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

fn uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn service_path(path: &Path) -> Result<&str> {
    let value = path.to_str().context("service paths must be UTF-8")?;
    ensure!(
        !value.chars().any(char::is_control),
        "service paths may not contain control characters"
    );
    Ok(value)
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
