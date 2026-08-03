use super::ServiceStatus;
use crate::config::Deployment;
use anyhow::{Context, Result, ensure};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

fn name(deployment: &Deployment) -> String {
    format!("agent-connector-{}.service", &deployment.identity.0[..32])
}

fn path(deployment: &Deployment) -> Result<PathBuf> {
    Ok(home::home_dir()
        .context("home directory is unavailable")?
        .join(".config/systemd/user")
        .join(name(deployment)))
}

pub fn enable(deployment: &Deployment, executable: &Path) -> Result<()> {
    let path = path(deployment)?;
    fs::create_dir_all(path.parent().expect("service path has parent"))?;
    let unit = unit(deployment, executable)?;
    let temporary = path.with_extension("tmp");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(unit.as_bytes())?;
    file.sync_all()?;
    fs::rename(temporary, &path)?;
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", "--now", &name(deployment)])
}

pub fn disable(deployment: &Deployment) -> Result<()> {
    let path = path(deployment)?;
    if path.exists() {
        systemctl(&["disable", "--now", &name(deployment)])?;
        fs::remove_file(path)?;
        systemctl(&["daemon-reload"])?;
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

fn systemctl(arguments: &[&str]) -> Result<()> {
    let output = Command::new("systemctl")
        .arg("--user")
        .args(arguments)
        .output()
        .context("cannot execute systemctl")?;
    ensure!(
        output.status.success(),
        "systemctl failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

fn unit(deployment: &Deployment, executable: &Path) -> Result<String> {
    Ok(format!(
        "[Unit]\nDescription=Agent Connector {}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart={} run {}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n",
        &deployment.identity.0[..32],
        quote(executable)?,
        quote(&deployment.root)?,
    ))
}

fn quote(path: &Path) -> Result<String> {
    let path = path.to_str().context("service paths must be UTF-8")?;
    ensure!(
        !path.chars().any(char::is_control),
        "service paths may not contain control characters"
    );
    Ok(format!(
        "\"{}\"",
        path.replace('%', "%%")
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    ))
}

#[cfg(test)]
mod tests {
    use super::unit;
    use crate::config::{Config, Deployment, Discord, Identity};
    use std::{
        collections::BTreeMap,
        path::{Path, PathBuf},
    };

    #[test]
    fn unit_has_exact_direct_execution() {
        let deployment = Deployment {
            root: PathBuf::from("/agent dir/%i"),
            identity: Identity("a".repeat(64)),
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
        };
        let value = unit(&deployment, Path::new("/bin/agc")).unwrap();
        assert!(value.contains("ExecStart=\"/bin/agc\" run \"/agent dir/%%i\""));
        assert!(!value.contains("discord-token"));
    }
}
