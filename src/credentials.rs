use crate::config::Deployment;
use anyhow::{Context, Result, ensure};
use rand::RngCore;
use serenity::http::Http;
#[cfg(windows)]
use std::env;
#[cfg(unix)]
use std::fs::File;
use std::{fmt, fs, io::Write, path::PathBuf};
use zeroize::Zeroizing;

pub struct Token(Zeroizing<String>);

impl Token {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Token([REDACTED])")
    }
}

pub fn path(deployment: &Deployment) -> Result<PathBuf> {
    #[cfg(unix)]
    let directory = home::home_dir()
        .context("home directory is unavailable")?
        .join(".agents/credentials");
    #[cfg(windows)]
    let directory =
        PathBuf::from(env::var_os("LOCALAPPDATA").context("LOCALAPPDATA is unavailable")?)
            .join("Agent Connector")
            .join("credentials");
    Ok(directory.join(format!("{}.discord-token", deployment.identity.0)))
}

pub fn load(deployment: &Deployment) -> Result<Token> {
    let path = path(deployment)?;
    private(&path).with_context(|| {
        format!(
            "credential is unavailable; run `agc connect {}`",
            deployment.root.display()
        )
    })?;
    let value = fs::read_to_string(&path).with_context(|| {
        format!(
            "cannot read credential {}; run `agc connect`",
            path.display()
        )
    })?;
    ensure!(
        !value.is_empty() && !value.contains(['\r', '\n', '\0']),
        "Discord credential is invalid"
    );
    Ok(Token(Zeroizing::new(value)))
}

pub async fn connect(deployment: &Deployment) -> Result<String> {
    let value =
        rpassword::prompt_password("Discord bot token: ").context("cannot read Discord token")?;
    ensure!(
        !value.is_empty() && !value.contains(['\r', '\n', '\0']),
        "Discord token is invalid"
    );
    let token = Token(Zeroizing::new(value));
    validate(deployment, &token).await?;
    store_path(&path(deployment)?, &token)?;
    oauth_url(deployment)
}

pub async fn validate(deployment: &Deployment, token: &Token) -> Result<()> {
    let http = Http::new(token.expose());
    let (user, application) =
        tokio::try_join!(http.get_current_user(), http.get_current_application_info())
            .context("Discord rejected the credential")?;
    ensure!(
        user.id.get() == deployment.config.discord.bot,
        "Discord token belongs to bot {}, not configured bot {}",
        user.id,
        deployment.config.discord.bot
    );
    ensure!(user.bot, "Discord token does not belong to a bot user");
    ensure!(
        application.id.get() == deployment.config.discord.application,
        "Discord token belongs to application {}, not configured application {}",
        application.id,
        deployment.config.discord.application
    );
    Ok(())
}

pub fn oauth_url(deployment: &Deployment) -> Result<String> {
    let mut url = url::Url::parse("https://discord.com/oauth2/authorize")?;
    url.query_pairs_mut()
        .append_pair(
            "client_id",
            &deployment.config.discord.application.to_string(),
        )
        .append_pair("scope", "bot")
        .append_pair("permissions", "274877910016");
    Ok(url.into())
}

fn store_path(path: &std::path::Path, token: &Token) -> Result<()> {
    let directory = path.parent().expect("credential path has parent");
    create_private_directory(directory)?;
    let mut random = [0u8; 16];
    rand::rng().fill_bytes(&mut random);
    let temporary = directory.join(format!(".credential-{}", hex::encode(random)));
    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(&temporary)
            .context("cannot create credential")?;
        file.write_all(token.expose().as_bytes())?;
        file.sync_all()?;
        replace(&temporary, path).context("cannot commit credential")?;
        private(path)?;
        #[cfg(unix)]
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn replace(source: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
fn replace(source: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn create_private_directory(directory: &std::path::Path) -> Result<()> {
    fs::create_dir_all(directory).context("cannot create credential directory")?;
    let metadata = fs::symlink_metadata(directory)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "credential directory is not a physical directory"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    windows_acl(directory)?;
    Ok(())
}

fn private(path: &std::path::Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("credential does not exist: {}", path.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "credential is not a physical file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "credential permissions must be 0600"
        );
    }
    #[cfg(windows)]
    windows_acl(path)?;
    Ok(())
}

#[cfg(windows)]
fn windows_acl(path: &std::path::Path) -> Result<()> {
    use std::process::Command;
    let domain = env::var("USERDOMAIN").context("USERDOMAIN is unavailable")?;
    let user = env::var("USERNAME").context("USERNAME is unavailable")?;
    let account = format!(r"{domain}\{user}:(F)");
    let reset = Command::new("icacls.exe")
        .arg(path)
        .arg("/reset")
        .output()
        .context("cannot reset credential ACL")?;
    ensure!(
        reset.status.success(),
        "cannot reset credential ACL: {}",
        String::from_utf8_lossy(&reset.stderr).trim()
    );
    let secured = Command::new("icacls.exe")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(account)
        .arg("*S-1-5-18:(F)")
        .output()
        .context("cannot secure credential ACL")?;
    ensure!(
        secured.status.success(),
        "cannot secure credential ACL: {}",
        String::from_utf8_lossy(&secured.stderr).trim()
    );
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::{Token, private, store_path};
    use std::{fs, os::unix::fs::PermissionsExt};
    use zeroize::Zeroizing;

    #[test]
    fn stores_and_replaces_private_credentials() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("credentials/token");
        store_path(&path, &Token(Zeroizing::new("first".into()))).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        store_path(&path, &Token(Zeroizing::new("second".into()))).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(private(&path).is_err());
    }
}
