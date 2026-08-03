use agent_connector::config;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use tempfile::TempDir;

fn package(change: impl FnOnce(String) -> String) -> TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("main.md"), "# Main\n").unwrap();
    fs::write(root.path().join("trusted.lua"), "return nil\n").unwrap();
    let source = format!(
        r#"version: 1
discord:
  application: "1"
  bot: "2"
policies:
  zinc:
    entry: main.md
    authority:
      - trusted.lua
    directory: {}
    memory: 96MiB
    timeout: 30s
users:
  "3": zinc
channels: {{}}
guilds: {{}}
"#,
        root.path().display()
    );
    fs::write(root.path().join("agent-connector.yaml"), change(source)).unwrap();
    root
}

#[test]
fn loads_an_explicit_agent_directory() {
    let root = package(|source| source);
    let deployment = config::load(Some(root.path().into())).unwrap();
    assert_eq!(deployment.root, root.path().canonicalize().unwrap());
    assert_eq!(deployment.config.discord.application, 1);
    assert_eq!(deployment.config.users.get(&3).unwrap(), "zinc");
    let policy = deployment.config.policies.get("zinc").unwrap();
    assert_eq!(policy.entry, "main.md");
    assert_eq!(policy.authority, ["trusted.lua"]);
}

#[test]
fn rejects_unknown_duplicate_alias_and_numeric_ids() {
    let cases = [
        Box::new(|source: String| source.replace("version: 1", "version: 1\nextra: true"))
            as Box<dyn Fn(String) -> String>,
        Box::new(|source: String| source.replace("version: 1", "version: 1\nversion: 1")),
        Box::new(|source: String| {
            source.replace("memory: 96MiB", "memory: &size 96MiB\n    extra: *size")
        }),
        Box::new(|source: String| source.replace("application: \"1\"", "application: 1")),
        Box::new(|source: String| source.replace("application: \"1\"", "application: \"01\"")),
        Box::new(|source: String| source.replace("\"3\": zinc", "\"3\": 7")),
    ];
    for change in cases {
        let root = package(change);
        assert!(config::load(Some(root.path().into())).is_err());
    }
}

#[test]
fn rejects_escaping_and_implicit_paths() {
    let root = package(|source| source.replace("entry: main.md", "entry: ../main.md"));
    assert!(config::load(Some(root.path().into())).is_err());
    let root = package(|source| source.replace("    directory: ", "    directory: relative # "));
    assert!(config::load(Some(root.path().into())).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_a_linked_configuration() {
    use std::os::unix::fs::symlink;
    let root = package(|source| source);
    let config = root.path().join("agent-connector.yaml");
    fs::rename(&config, root.path().join("actual.yaml")).unwrap();
    symlink("actual.yaml", &config).unwrap();
    assert!(config::load(Some(root.path().into())).is_err());
}

#[cfg(unix)]
#[test]
fn checks_each_explicit_entry_with_portable_agents() {
    let root = package(|source| source);
    let deployment = config::load(Some(root.path().into())).unwrap();
    let agent = root.path().join("agent");
    fs::write(&agent, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\n").unwrap();
    fs::set_permissions(&agent, fs::Permissions::from_mode(0o700)).unwrap();
    config::check(&deployment, &agent).unwrap();
    assert_eq!(
        fs::read_to_string(agent.with_extension("args"))
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        [
            "check",
            "--directory",
            root.path().to_str().unwrap(),
            "--entry",
            "main.md"
        ]
    );
}
