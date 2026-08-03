pub mod config;
pub mod credentials;
pub mod discord;
pub mod invoke;
pub mod lifecycle;
pub mod service;

use anyhow::{Context, Result, bail, ensure};
use config::Deployment;
use std::{ffi::OsString, path::PathBuf, sync::Arc};

pub async fn dispatch(arguments: Vec<OsString>) -> Result<()> {
    if arguments
        .first()
        .is_some_and(|value| value == "--help" || value == "-h")
    {
        ensure!(arguments.len() == 1, "unexpected argument\n{USAGE}");
        println!("{USAGE}");
        return Ok(());
    }
    if arguments
        .first()
        .is_some_and(|value| value == "--version" || value == "-V")
    {
        ensure!(arguments.len() == 1, "unexpected argument\n{USAGE}");
        println!("agc {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let command = arguments
        .first()
        .and_then(|value| value.to_str())
        .filter(|value| matches!(*value, "connect" | "check" | "run" | "up" | "down" | "auto"));
    match command {
        None => {
            ensure!(arguments.len() <= 1, "unexpected arguments\n{USAGE}");
            show(config::load(arguments.first().map(PathBuf::from))?).await
        }
        Some("auto") => {
            ensure!(
                (2..=3).contains(&arguments.len()),
                "auto requires on or off\n{USAGE}"
            );
            let action = arguments[1].to_str().context("auto action must be UTF-8")?;
            let deployment = config::load(arguments.get(2).map(PathBuf::from))?;
            match action {
                "on" => {
                    preflight(&deployment).await?;
                    let token = credentials::load(&deployment)?;
                    credentials::validate(&deployment, &token).await?;
                    let executable =
                        std::env::current_exe().context("cannot resolve agc executable")?;
                    service::enable(&deployment, &executable)?;
                    println!("Autostart enabled.");
                    Ok(())
                }
                "off" => {
                    if lifecycle::status(&deployment)
                        .await
                        .ok()
                        .flatten()
                        .is_some()
                    {
                        lifecycle::down(&deployment).await?;
                    }
                    service::disable(&deployment)?;
                    println!("Autostart disabled.");
                    Ok(())
                }
                _ => bail!("auto action must be on or off\n{USAGE}"),
            }
        }
        Some(command) => {
            ensure!(arguments.len() <= 2, "unexpected arguments\n{USAGE}");
            let deployment = config::load(arguments.get(1).map(PathBuf::from))?;
            match command {
                "connect" => {
                    preflight(&deployment).await?;
                    let url = credentials::connect(&deployment).await?;
                    println!("Discord connected.\nInstall: {url}");
                    Ok(())
                }
                "check" => {
                    preflight(&deployment).await?;
                    let token = credentials::load(&deployment)?;
                    credentials::validate(&deployment, &token).await?;
                    println!("Agent Connector is valid.");
                    Ok(())
                }
                "run" => {
                    let agent = preflight(&deployment).await?;
                    let token = credentials::load(&deployment)?;
                    credentials::validate(&deployment, &token).await?;
                    lifecycle::run(Arc::new(deployment), token, agent).await
                }
                "up" => {
                    preflight(&deployment).await?;
                    credentials::load(&deployment)?;
                    lifecycle::up(&deployment).await?;
                    println!("Agent Connector is ready.");
                    Ok(())
                }
                "down" => {
                    lifecycle::down(&deployment).await?;
                    println!("Agent Connector stopped.");
                    Ok(())
                }
                _ => unreachable!(),
            }
        }
    }
}

async fn preflight(deployment: &Deployment) -> Result<PathBuf> {
    let agent = config::find_agent()?;
    config::check(deployment, &agent)?;
    Ok(agent)
}

async fn show(deployment: Deployment) -> Result<()> {
    let credential = if credentials::load(&deployment).is_ok() {
        "connected"
    } else {
        "disconnected"
    };
    let runtime = lifecycle::status(&deployment).await?;
    let auto = match service::status(&deployment)? {
        service::ServiceStatus::Enabled => "enabled",
        service::ServiceStatus::Disabled => "disabled",
    };
    println!("Agent:      {}", deployment.root.display());
    println!("Config:     valid");
    println!("Credential: {credential}");
    println!(
        "Runtime:    {}",
        runtime
            .as_ref()
            .map_or("stopped", |status| status.state.as_str())
    );
    println!("Autostart:  {auto}");
    if let Some(status) = runtime {
        println!("Active:     {}", status.active);
        println!("Queued:     {}", status.queued);
    }
    Ok(())
}

pub const USAGE: &str = "usage: agc [DIRECTORY]\n       agc connect [DIRECTORY]\n       agc check [DIRECTORY]\n       agc run [DIRECTORY]\n       agc up [DIRECTORY]\n       agc down [DIRECTORY]\n       agc auto on|off [DIRECTORY]\n\nDIRECTORY may be omitted only when the current directory contains agent-connector.yaml.";
