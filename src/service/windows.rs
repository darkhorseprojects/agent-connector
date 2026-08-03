use super::ServiceStatus;
use crate::config::Deployment;
use anyhow::{Context, Result, ensure};
use std::{path::Path, process::Command};

fn name(deployment: &Deployment) -> String {
    format!("Agent Connector {}", &deployment.identity.0[..32])
}

pub fn enable(deployment: &Deployment, executable: &Path) -> Result<()> {
    let executable = service_path(executable)?;
    let root = service_path(&deployment.root)?;
    let action = format!("\"{executable}\" run \"{root}\"");
    schtasks(&[
        "/Create",
        "/SC",
        "ONLOGON",
        "/TN",
        &name(deployment),
        "/TR",
        &action,
        "/F",
    ])
}

pub fn disable(deployment: &Deployment) -> Result<()> {
    if status(deployment)? == ServiceStatus::Enabled {
        schtasks(&["/Delete", "/TN", &name(deployment), "/F"])?;
    }
    Ok(())
}

pub fn status(deployment: &Deployment) -> Result<ServiceStatus> {
    let output = Command::new("schtasks.exe")
        .args(["/Query", "/TN", &name(deployment)])
        .output()
        .context("cannot execute schtasks")?;
    Ok(if output.status.success() {
        ServiceStatus::Enabled
    } else {
        ServiceStatus::Disabled
    })
}

fn service_path(path: &Path) -> Result<&str> {
    let value = path.to_str().context("service paths must be UTF-8")?;
    ensure!(
        !value.chars().any(char::is_control),
        "service paths may not contain control characters"
    );
    Ok(value)
}

fn schtasks(arguments: &[&str]) -> Result<()> {
    let output = Command::new("schtasks.exe")
        .args(arguments)
        .output()
        .context("cannot execute schtasks")?;
    ensure!(
        output.status.success(),
        "schtasks failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}
