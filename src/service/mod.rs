use crate::config::Deployment;
use anyhow::Result;
use std::path::Path;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServiceStatus {
    Enabled,
    Disabled,
}

pub fn enable(deployment: &Deployment, executable: &Path) -> Result<()> {
    platform::enable(deployment, executable)
}

pub fn disable(deployment: &Deployment) -> Result<()> {
    platform::disable(deployment)
}

pub fn status(deployment: &Deployment) -> Result<ServiceStatus> {
    platform::status(deployment)
}
