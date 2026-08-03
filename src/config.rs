use anyhow::{Context, Result, bail, ensure};
use saphyr_parser::{Event, Parser};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    env, fs,
    path::{Component, Path, PathBuf},
    process::Command,
    time::Duration,
};

pub const CONFIG_FILE: &str = "agent-connector.yaml";
const MAX_CONFIG: u64 = 64 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Identity(pub String);

#[derive(Clone, Debug)]
pub struct Deployment {
    pub root: PathBuf,
    pub identity: Identity,
    pub config: Config,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub discord: Discord,
    pub policies: BTreeMap<String, Policy>,
    pub users: BTreeMap<u64, String>,
    pub channels: BTreeMap<u64, String>,
    pub guilds: BTreeMap<u64, String>,
}

#[derive(Clone, Debug)]
pub struct Discord {
    pub application: u64,
    pub bot: u64,
}

#[derive(Clone, Debug)]
pub struct Policy {
    pub entry: String,
    pub authority: Vec<String>,
    pub directory: PathBuf,
    pub memory: String,
    pub timeout: String,
    pub timeout_value: Duration,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    version: u8,
    discord: RawDiscord,
    policies: BTreeMap<String, RawPolicy>,
    #[serde(default)]
    users: BTreeMap<String, String>,
    #[serde(default)]
    channels: BTreeMap<String, String>,
    #[serde(default)]
    guilds: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDiscord {
    application: String,
    bot: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPolicy {
    entry: String,
    #[serde(default)]
    authority: Vec<String>,
    directory: PathBuf,
    memory: String,
    timeout: String,
}

pub fn resolve_directory(directory: Option<PathBuf>) -> Result<PathBuf> {
    let directory = match directory {
        Some(value) => value,
        None => {
            let cwd = env::current_dir().context("current directory is unavailable")?;
            ensure!(
                cwd.join(CONFIG_FILE).is_file(),
                "DIRECTORY is required outside an Agent directory"
            );
            cwd
        }
    };
    let root = directory
        .canonicalize()
        .with_context(|| format!("cannot open Agent directory {}", directory.display()))?;
    ensure!(root.is_dir(), "Agent directory is not a directory");
    Ok(root)
}

pub fn load(directory: Option<PathBuf>) -> Result<Deployment> {
    let root = resolve_directory(directory)?;
    let path = root.join(CONFIG_FILE);
    let metadata =
        fs::symlink_metadata(&path).with_context(|| format!("cannot open {}", path.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "configuration is not a physical file"
    );
    ensure!(metadata.len() <= MAX_CONFIG, "configuration exceeds 64 KiB");
    let source = fs::read_to_string(&path).context("configuration must be UTF-8")?;
    validate_yaml(&source)?;
    let value: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(&source).context("invalid configuration")?;
    validate_id_types(&value)?;
    let raw: RawConfig = serde_yaml_ng::from_value(value).context("invalid configuration")?;
    validate(&root, raw)
}

enum Container {
    Mapping { keys: HashSet<String>, key: bool },
    Sequence,
}

fn validate_yaml(source: &str) -> Result<()> {
    let mut stack = Vec::new();
    let mut documents = 0usize;
    for item in Parser::new_from_str(source).keep_tags(true) {
        let (event, _) = item.context("invalid YAML")?;
        match event {
            Event::DocumentStart(_) => {
                documents += 1;
                ensure!(
                    documents == 1,
                    "configuration must contain one YAML document"
                );
            }
            Event::Alias(_) => bail!("YAML aliases are not allowed"),
            Event::Scalar(value, _, anchor, tag) => {
                ensure!(anchor == 0, "YAML anchors are not allowed");
                ensure!(tag.is_none(), "YAML tags are not allowed");
                ensure!(value.len() <= 8 * 1024, "YAML scalar exceeds 8 KiB");
                if let Some(Container::Mapping { keys, key }) = stack.last_mut() {
                    if *key {
                        ensure!(value != "<<", "YAML merge keys are not allowed");
                        ensure!(keys.insert(value.into_owned()), "duplicate YAML key");
                        *key = false;
                    } else {
                        *key = true;
                    }
                }
            }
            Event::SequenceStart(anchor, tag) => {
                consume_container(&mut stack)?;
                ensure!(anchor == 0, "YAML anchors are not allowed");
                ensure!(tag.is_none(), "YAML tags are not allowed");
                stack.push(Container::Sequence);
                ensure!(stack.len() <= 16, "YAML nesting exceeds 16 levels");
            }
            Event::MappingStart(anchor, tag) => {
                consume_container(&mut stack)?;
                ensure!(anchor == 0, "YAML anchors are not allowed");
                ensure!(tag.is_none(), "YAML tags are not allowed");
                stack.push(Container::Mapping {
                    keys: HashSet::new(),
                    key: true,
                });
                ensure!(stack.len() <= 16, "YAML nesting exceeds 16 levels");
            }
            Event::SequenceEnd | Event::MappingEnd => {
                stack.pop();
            }
            _ => {}
        }
    }
    ensure!(
        documents == 1,
        "configuration must contain one YAML document"
    );
    Ok(())
}

fn consume_container(stack: &mut [Container]) -> Result<()> {
    if let Some(Container::Mapping { key, .. }) = stack.last_mut() {
        ensure!(!*key, "YAML mapping keys must be scalar");
        *key = true;
    }
    Ok(())
}

fn validate_id_types(value: &serde_yaml_ng::Value) -> Result<()> {
    let root = value
        .as_mapping()
        .context("configuration root must be a mapping")?;
    let discord = yaml_get(root, "discord")
        .and_then(serde_yaml_ng::Value::as_mapping)
        .context("discord must be a mapping")?;
    for name in ["application", "bot"] {
        ensure!(
            yaml_get(discord, name).is_some_and(serde_yaml_ng::Value::is_string),
            "discord {name} ID must be quoted text"
        );
    }
    let policies = yaml_get(root, "policies")
        .and_then(serde_yaml_ng::Value::as_mapping)
        .context("policies must be a mapping")?;
    ensure!(
        policies.keys().all(serde_yaml_ng::Value::is_string),
        "policy names must be text"
    );
    for policy in policies.values() {
        let policy = policy.as_mapping().context("policy must be a mapping")?;
        for name in ["entry", "directory", "memory", "timeout"] {
            if let Some(value) = yaml_get(policy, name) {
                ensure!(value.is_string(), "policy {name} must be text");
            }
        }
        if let Some(authority) = yaml_get(policy, "authority") {
            ensure!(
                authority
                    .as_sequence()
                    .is_some_and(|values| values.iter().all(serde_yaml_ng::Value::is_string)),
                "policy authority must contain text paths"
            );
        }
    }
    for name in ["users", "channels", "guilds"] {
        if let Some(routes) = yaml_get(root, name) {
            let routes = routes
                .as_mapping()
                .with_context(|| format!("{name} must be a mapping"))?;
            ensure!(
                routes
                    .iter()
                    .all(|(id, policy)| id.is_string() && policy.is_string()),
                "{name} routes must map quoted IDs to policy names"
            );
        }
    }
    Ok(())
}

fn yaml_get<'a>(
    mapping: &'a serde_yaml_ng::Mapping,
    name: &str,
) -> Option<&'a serde_yaml_ng::Value> {
    mapping.get(serde_yaml_ng::Value::String(name.into()))
}

fn validate(root: &Path, raw: RawConfig) -> Result<Deployment> {
    ensure!(raw.version == 1, "unsupported configuration version");
    ensure!(
        !raw.policies.is_empty() && raw.policies.len() <= 64,
        "policies must contain 1 to 64 entries"
    );

    let mut policies = BTreeMap::new();
    for (name, raw) in raw.policies {
        ensure!(valid_policy_name(&name), "invalid policy name {name:?}");
        let entry = package_path(root, &raw.entry, &["md", "lua"], "entry")?;
        let mut seen = BTreeSet::new();
        ensure!(
            raw.authority.len() <= 256,
            "policy {name} has too many authority paths"
        );
        let mut authority = Vec::new();
        for value in raw.authority {
            let value = package_path(root, &value, &["lua"], "authority")?;
            ensure!(
                seen.insert(value.clone()),
                "policy {name} repeats authority {value}"
            );
            authority.push(value);
        }
        ensure!(
            raw.directory.is_absolute(),
            "policy {name} directory must be absolute"
        );
        let directory = raw
            .directory
            .canonicalize()
            .with_context(|| format!("policy {name} directory does not exist"))?;
        ensure!(
            directory.is_dir(),
            "policy {name} directory is not a directory"
        );
        let memory = parse_size::parse_size(&raw.memory)
            .with_context(|| format!("invalid memory for policy {name}"))?;
        let memory_bytes = usize::try_from(memory).context("memory does not fit this platform")?;
        let timeout_value = humantime::parse_duration(&raw.timeout)
            .with_context(|| format!("invalid timeout for policy {name}"))?;
        ensure!(
            memory_bytes > 0 && !timeout_value.is_zero(),
            "policy {name} limits must be positive"
        );
        policies.insert(
            name,
            Policy {
                entry,
                authority,
                directory,
                memory: raw.memory,
                timeout: raw.timeout,
                timeout_value,
            },
        );
    }

    let users = routes(raw.users, &policies, "users")?;
    let channels = routes(raw.channels, &policies, "channels")?;
    let guilds = routes(raw.guilds, &policies, "guilds")?;
    ensure!(
        !users.is_empty() || !channels.is_empty() || !guilds.is_empty(),
        "at least one route is required"
    );
    let application = snowflake(&raw.discord.application, "application")?;
    let bot = snowflake(&raw.discord.bot, "bot")?;
    let identity = identity(root);
    Ok(Deployment {
        root: root.to_owned(),
        identity,
        config: Config {
            discord: Discord { application, bot },
            policies,
            users,
            channels,
            guilds,
        },
    })
}

fn identity(root: &Path) -> Identity {
    let mut hash = Sha256::new();
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        hash.update(root.as_os_str().as_bytes());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        for value in root.as_os_str().encode_wide() {
            hash.update(value.to_le_bytes());
        }
    }
    Identity(hex::encode(hash.finalize()))
}

fn package_path(root: &Path, value: &str, extensions: &[&str], kind: &str) -> Result<String> {
    ensure!(
        !value.is_empty() && value.len() <= 1024,
        "invalid {kind} path"
    );
    ensure!(
        !value.contains('\\'),
        "{kind} paths must use forward slashes"
    );
    let path = Path::new(value);
    ensure!(!path.is_absolute(), "{kind} path must be relative");
    ensure!(
        path.components()
            .all(|part| matches!(part, Component::Normal(_))),
        "invalid {kind} path {value:?}"
    );
    ensure!(
        extensions
            .iter()
            .any(|extension| path.extension().is_some_and(|actual| actual == *extension)),
        "invalid {kind} extension for {value}"
    );
    let actual = root
        .join(path)
        .canonicalize()
        .with_context(|| format!("{kind} path does not exist: {value}"))?;
    ensure!(
        actual.is_file() && actual.starts_with(root),
        "{kind} path escapes the Agent directory: {value}"
    );
    Ok(value.to_owned())
}

fn routes(
    raw: BTreeMap<String, String>,
    policies: &BTreeMap<String, Policy>,
    name: &str,
) -> Result<BTreeMap<u64, String>> {
    ensure!(raw.len() <= 4096, "{name} has too many routes");
    raw.into_iter()
        .map(|(id, policy)| {
            ensure!(
                policies.contains_key(&policy),
                "{name} route {id} references unknown policy {policy}"
            );
            Ok((snowflake(&id, name)?, policy))
        })
        .collect()
}

fn snowflake(value: &str, field: &str) -> Result<u64> {
    ensure!(
        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()),
        "{field} ID must be decimal text"
    );
    let id = value
        .parse::<u64>()
        .with_context(|| format!("invalid {field} ID"))?;
    ensure!(id > 0, "{field} ID must be positive");
    ensure!(
        value == id.to_string(),
        "{field} ID must be canonical decimal text"
    );
    Ok(id)
}

fn valid_policy_name(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || index > 0 && matches!(byte, b'_' | b'-')
        })
}

pub fn find_agent() -> Result<PathBuf> {
    let path = env::var_os("PATH").context("PATH is unavailable")?;
    for directory in env::split_paths(&path) {
        #[cfg(windows)]
        let candidates = [directory.join("agent.exe"), directory.join("agent")];
        #[cfg(not(windows))]
        let candidates = [directory.join("agent")];
        for candidate in candidates {
            if candidate.is_file() {
                return candidate
                    .canonicalize()
                    .context("cannot resolve agent executable");
            }
        }
    }
    bail!("agent executable was not found on PATH")
}

pub fn check(deployment: &Deployment, agent: &Path) -> Result<()> {
    let mut entries = BTreeSet::new();
    for policy in deployment.config.policies.values() {
        if entries.insert(&policy.entry) {
            let output = Command::new(agent)
                .args(["check", "--directory"])
                .arg(&deployment.root)
                .args(["--entry", &policy.entry])
                .output()
                .context("failed to execute agent check")?;
            ensure!(
                output.status.success(),
                "agent check failed for {}: {}",
                policy.entry,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
    }
    Ok(())
}
