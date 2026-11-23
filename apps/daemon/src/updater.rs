//! Root-only, fixed-purpose updater. No shell commands or caller-selected filesystem paths.
use anyhow::{Context, Result, bail, ensure};
use ed25519_dalek::{Signature, VerifyingKey};
use fs2::FileExt;
use reqwest::{blocking::Client, redirect::Policy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[path = "layout.rs"]
mod layout;
pub use layout::{layout_check, migrate_layout, recover as recover_migration};
use layout::{layout_lock, recover_layout, unified};

const CONFIG: &str = "/etc/ephor/updater.json";
const STATE: &str = "/var/lib/ephor-updater";
const BINARY: &str = "/usr/local/bin/ephord";
const MAX_BINARY: u64 = 32 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    panel: String,
    credential: String,
    public_key: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    manifest: String,
    signature: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema: u8,
    version: String,
    build_id: String,
    protocol: u8,
    updater_protocol: u8,
    channel: String,
    expires_at: u64,
    artifacts: BTreeMap<String, Artifact>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    url: String,
    sha256: String,
    size: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    envelope: Envelope,
    expires_at: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    job: Job,
    #[serde(default)]
    components: Vec<ComponentBackup>,
    #[serde(default)]
    shared: bool,
    previous_hash: String,
    previous_version: String,
    status: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Component {
    Monitoring,
    Deployments,
    Security,
    Protections,
    Updater,
}
const COMPONENTS: [Component; 5] = [
    Component::Monitoring,
    Component::Deployments,
    Component::Security,
    Component::Protections,
    Component::Updater,
];
impl Component {
    fn name(self) -> &'static str {
        match self {
            Self::Monitoring => "monitoring",
            Self::Deployments => "deployments",
            Self::Security => "security",
            Self::Protections => "protections",
            Self::Updater => "updater",
        }
    }
    fn legacy_path(self) -> &'static str {
        match self {
            Self::Monitoring => BINARY,
            Self::Deployments => "/usr/local/libexec/ephor-services",
            Self::Security => "/usr/local/libexec/ephor-security",
            Self::Protections => "/usr/local/libexec/ephor-protections",
            Self::Updater => "/usr/local/libexec/ephor-updater",
        }
    }
    fn path(self) -> &'static str {
        if unified() {
            BINARY
        } else {
            self.legacy_path()
        }
    }
    fn unit(self) -> &'static str {
        match self {
            Self::Monitoring => "ephord.service",
            Self::Deployments => "ephor-services.service",
            Self::Security => "ephor-security.service",
            Self::Protections => "ephor-protections.service",
            Self::Updater => "ephor-updater.service",
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComponentBackup {
    component: Component,
    hash: String,
    active: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComponentStatus {
    id: Component,
    installed: bool,
    version: Option<String>,
    build_id: Option<String>,
    active: bool,
}
fn component_installed(component: Component) -> Result<bool> {
    let path = if unified() && component != Component::Monitoring {
        format!("/etc/systemd/system/{}", component.unit())
    } else {
        component.legacy_path().into()
    };
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            ensure!(
                meta.is_file() && meta.uid() == 0 && meta.permissions().mode() & 0o022 == 0,
                "Unsafe component executable"
            );
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
fn output(program: &str, args: &[&str]) -> Result<Vec<u8>> {
    use std::process::Stdio;
    let mut child = Command::new(program)
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = child.stdout.take().context("Missing output")?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(8193).read_to_end(&mut bytes).map(|_| bytes)
    });
    let mut success = false;
    for _ in 0..50 {
        if let Some(status) = child.try_wait()? {
            success = status.success();
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    let bytes = reader
        .join()
        .map_err(|_| anyhow::anyhow!("Component output failed"))??;
    ensure!(
        success && bytes.len() <= 8192,
        "Component command failed or timed out"
    );
    Ok(bytes)
}
fn active(component: Component) -> bool {
    output("/usr/bin/systemctl", &["is-active", component.unit()]).is_ok()
}
fn build_info(component: Component) -> Option<serde_json::Value> {
    serde_json::from_slice(&output(component.path(), &["--build-info"]).ok()?).ok()
}
fn inventory() -> Result<Vec<ComponentStatus>> {
    COMPONENTS
        .iter()
        .map(|&component| {
            let present = component_installed(component)?;
            let info = if present { build_info(component) } else { None };
            let version = info
                .as_ref()
                .and_then(|i| i["version"].as_str())
                .map(str::to_owned)
                .or_else(|| {
                    if !present {
                        return None;
                    }
                    let text =
                        String::from_utf8(output(component.path(), &["--version"]).ok()?).ok()?;
                    let v = text.trim().strip_prefix("ephord ")?;
                    version(v).ok()?;
                    Some(v.into())
                });
            Ok(ComponentStatus {
                id: component,
                installed: present,
                version,
                build_id: info
                    .as_ref()
                    .and_then(|i| i["buildId"].as_str())
                    .map(str::to_owned),
                active: present && (component == Component::Updater || active(component)),
            })
        })
        .collect()
}
fn component_health(
    component: Component,
    manifest: &Manifest,
    expected_hash: &str,
    was_active: bool,
) -> bool {
    let Some(info) = build_info(component) else {
        return false;
    };
    if info["version"] != manifest.version || info["buildId"] != manifest.build_id {
        return false;
    }
    if component == Component::Updater {
        return output(component.path(), &["update-check"]).is_ok();
    }
    if !was_active {
        return true;
    }
    if !active(component) {
        return false;
    }
    // Monitoring runs under a different UID; the capability-free updater cannot
    // inspect its /proc executable. Fresh signed-build telemetry verifies it below.
    if component == Component::Monitoring {
        return true;
    }
    // Confirm the running process uses the verified binary, not merely that the unit is active.
    let Ok(pid) = output(
        "/usr/bin/systemctl",
        &["show", "--property=MainPID", "--value", component.unit()],
    ) else {
        return false;
    };
    let Ok(pid) = String::from_utf8(pid) else {
        return false;
    };
    let Ok(pid) = pid.trim().parse::<u32>() else {
        return false;
    };
    if pid == 0 {
        return false;
    }
    match read_limited(Path::new(&format!("/proc/{pid}/exe")), MAX_BINARY) {
        Ok(bytes) => digest(&bytes) == expected_hash,
        Err(e)
            if e.downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied) =>
        {
            // Linux ptrace restrictions also apply between root processes with
            // different capability sets. Do not grant the updater CAP_SYS_PTRACE.
            // systemd has just stopped/restarted this fixed unit; verify its
            // executed path, exact role arguments and PID through the manager.
            output(
                "/usr/bin/systemctl",
                &["show", "--property=ExecStart", "--value", component.unit()],
            )
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .is_some_and(|s| expected_start(&s, component, pid))
        }
        Err(_) => false,
    }
}
fn expected_start(value: &str, component: Component, pid: u32) -> bool {
    let mode = match component {
        Component::Deployments => "service-worker",
        Component::Security => "security-worker",
        Component::Protections => "protection-worker",
        _ => return false,
    };
    // Legacy unit definitions remain valid through root-owned migration aliases.
    [component.path(), component.legacy_path()]
        .into_iter()
        .any(|path| {
            value
                .trim()
                .starts_with(&format!("{{ path={path} ; argv[]={path} {mode} ; "))
                && value.matches('{').count() == 1
                && value
                    .split(" ; ")
                    .any(|field| field == format!("pid={pid}"))
        })
}
pub fn check() -> Result<()> {
    root()?;
    private_file(Path::new(CONFIG))?;
    let settings: Settings = serde_json::from_slice(&read_limited(Path::new(CONFIG), 4096)?)?;
    decode::<32>(&settings.public_key)?;
    crate::config::panel_url(&settings.panel)?;
    ensure!(
        settings.panel.starts_with("https://") && crate::config::token(&settings.credential),
        "Invalid updater identity"
    );
    let path = Path::new(STATE).join("journal.json");
    if path.exists() {
        private_file(&path)?;
        let _: Journal = serde_json::from_slice(&read_limited(&path, 30000)?)?;
    }
    Ok(())
}

pub fn maintenance_lease(start: bool) -> Result<()> {
    check()?;
    let mut token = String::new();
    std::io::stdin().take(66).read_to_string(&mut token)?;
    let token = token.trim();
    ensure!(crate::config::token(token), "Invalid maintenance grant");
    let settings: Settings = serde_json::from_slice(&read_limited(Path::new(CONFIG), 4096)?)?;
    post(
        &super::client()?,
        &settings,
        if start {
            "maintenance-start"
        } else {
            "maintenance-end"
        },
        serde_json::json!({"token":token}),
    )?;
    Ok(())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn decode<const N: usize>(value: &str) -> Result<[u8; N]> {
    ensure!(
        value.len() == N * 2
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid hexadecimal value"
    );
    let mut out = [0; N];
    for (i, item) in out.iter_mut().enumerate() {
        *item = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)?;
    }
    Ok(out)
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn version(value: &str) -> Result<[u32; 3]> {
    let parts: Vec<&str> = value.split('.').collect();
    ensure!(parts.len() == 3, "Invalid version");
    let mut out = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        ensure!(
            !part.is_empty()
                && part.len() <= 6
                && part.bytes().all(|b| b.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0')),
            "Invalid version"
        );
        out[i] = part.parse()?;
    }
    Ok(out)
}
fn verify(envelope: &Envelope, key: &str, installed: &str) -> Result<Manifest> {
    ensure!(envelope.manifest.len() <= 12000, "Manifest too large");
    VerifyingKey::from_bytes(&decode::<32>(key)?)?
        .verify_strict(
            envelope.manifest.as_bytes(),
            &Signature::from_bytes(&decode::<64>(&envelope.signature)?),
        )
        .context("Release signature rejected")?;
    let manifest: Manifest = serde_json::from_str(&envelope.manifest)?;
    ensure!(
        manifest.schema == 1
            && manifest.protocol == 1
            && [1, 2, 3].contains(&manifest.updater_protocol)
            && manifest.channel == "stable"
            && manifest.expires_at > now(),
        "Expired or incompatible release"
    );
    ensure!(
        version(&manifest.version)? > version(installed)?
            || (manifest.updater_protocol >= 2
                && version(&manifest.version)? == version(installed)?),
        "Downgrade or same-version update rejected"
    );
    ensure!(
        (40..=64).contains(&manifest.build_id.len())
            && manifest.build_id.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid build identity"
    );
    for (arch, artifact) in &manifest.artifacts {
        ensure!(
            ["x86_64", "aarch64"].contains(&arch.as_str()),
            "Unsupported architecture"
        );
        decode::<32>(&artifact.sha256)?;
        ensure!(
            artifact.size > 0 && artifact.size <= MAX_BINARY,
            "Invalid artifact size"
        );
        let url = reqwest::Url::parse(&artifact.url)?;
        ensure!(
            url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none(),
            "Invalid artifact URL"
        );
    }
    Ok(manifest)
}
fn private_file(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_file() && meta.uid() == 0 && meta.permissions().mode() & 0o077 == 0,
        "Expected a root-owned private regular file"
    );
    Ok(())
}
fn directory(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::create_dir(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_dir() && meta.uid() == 0 && meta.permissions().mode() & 0o022 == 0,
        "Unsafe updater directory"
    );
    Ok(())
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension("new");
    // Only root can write the containing directory. Reject unexpected existing temp files.
    if temp.exists() {
        private_file(&temp)?;
        fs::remove_file(&temp)?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temp, path)?;
    File::open(path.parent().context("Missing parent")?)?.sync_all()?;
    Ok(())
}
fn systemctl_component(action: &str, component: Component) -> Result<()> {
    let mut command = Command::new("/usr/bin/systemctl");
    command
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .args([action, component.unit()]);
    let mut child = command.spawn()?;
    for _ in 0..100 {
        if let Some(status) = child.try_wait()? {
            ensure!(status.success(), "systemctl failed");
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    let _ = child.wait();
    bail!("systemctl timed out")
}
fn systemctl(action: &str) -> Result<()> {
    systemctl_component(action, Component::Monitoring)
}
fn install_component(bytes: &[u8], component: Component) -> Result<()> {
    let binary = Path::new(component.legacy_path());
    let parent = binary.parent().context("Missing executable parent")?;
    directory(parent)?;
    let staged_path = parent.join(format!(".ephor-{}-update", component.name()));
    let staged_path = staged_path.as_path();
    if staged_path.exists() {
        let meta = fs::symlink_metadata(staged_path)?;
        ensure!(meta.is_file() && meta.uid() == 0, "Unsafe staging file");
        fs::remove_file(staged_path)?;
    }
    let mut staged = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o755)
        .open(staged_path)?;
    staged.write_all(bytes)?;
    // UMask=0077 protects state, but the monitoring user must execute this file.
    staged.set_permissions(fs::Permissions::from_mode(0o755))?;
    staged.sync_all()?;
    fs::rename(staged_path, binary)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}
fn install(bytes: &[u8]) -> Result<()> {
    install_component(bytes, Component::Monitoring)
}
fn read_limited(path: &Path, max: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(max + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= max, "File too large");
    Ok(bytes)
}
fn post(
    client: &Client,
    settings: &Settings,
    action: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value> {
    let response = client
        .post(format!("{}/api/agent/updates/{action}", settings.panel))
        .bearer_auth(&settings.credential)
        .json(&body)
        .send()
        .map_err(|_| anyhow::anyhow!("Panel unavailable"))?;
    ensure!(
        response.status().is_success(),
        "Panel rejected updater request"
    );
    let mut bytes = Vec::new();
    response.take(20001).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 20000, "Panel response too large");
    Ok(serde_json::from_slice(&bytes)?)
}
fn report(client: &Client, settings: &Settings, journal: &Journal) -> Result<()> {
    post(
        client,
        settings,
        "report",
        serde_json::json!({"id":journal.job.id,"status":journal.status,"error": if journal.status == "rolled_back" {Some("Update did not complete health verification; previous Ephor components restored.")} else if journal.status == "failed" {Some("Update could not start: release, download, or machine-readiness checks failed.")} else {None}}),
    )?;
    Ok(())
}
fn restore(journal: &mut Journal, state: &Path) -> Result<()> {
    if journal.shared {
        private_file(&state.join("previous"))?;
        let bytes = read_limited(&state.join("previous"), MAX_BINARY)?;
        ensure!(
            digest(&bytes) == journal.previous_hash,
            "Shared backup integrity failed"
        );
        for c in &journal.components {
            if c.active {
                systemctl_component("stop", c.component)?;
            }
        }
        install(&bytes)?;
        for c in &journal.components {
            if c.active {
                systemctl_component("restart", c.component)?;
            }
        }
        write_private(&state.join("version"), journal.previous_version.as_bytes())?;
        journal.status = "rolled_back".into();
        write_private(&state.join("journal.json"), &serde_json::to_vec(journal)?)?;
        return Ok(());
    }
    if !journal.components.is_empty() {
        // Validate every backup before restoring any component. An interrupted restore is retried.
        let mut backups = Vec::new();
        for backup in &journal.components {
            let path = state.join(format!("{}.previous", backup.component.name()));
            private_file(&path)?;
            let bytes = read_limited(&path, MAX_BINARY)?;
            ensure!(
                digest(&bytes) == backup.hash,
                "Component backup integrity failed"
            );
            backups.push((backup, bytes));
        }
        for (backup, _) in &backups {
            if backup.active && backup.component != Component::Updater {
                systemctl_component("stop", backup.component)?;
            }
        }
        for (backup, bytes) in &backups {
            install_component(bytes, backup.component)?;
        }
        for (backup, _) in &backups {
            if backup.active && backup.component != Component::Updater {
                systemctl_component("restart", backup.component)?;
            }
        }
        write_private(&state.join("version"), journal.previous_version.as_bytes())?;
        journal.status = "rolled_back".into();
        write_private(&state.join("journal.json"), &serde_json::to_vec(journal)?)?;
        return Ok(());
    }
    let backup = read_limited(&state.join("previous"), MAX_BINARY)?;
    ensure!(
        digest(&backup) == journal.previous_hash,
        "Backup integrity check failed; manual recovery required"
    );
    install(&backup)?;
    systemctl("restart")?;
    write_private(&state.join("version"), journal.previous_version.as_bytes())?;
    journal.status = "rolled_back".into();
    write_private(&state.join("journal.json"), &serde_json::to_vec(journal)?)?;
    Ok(())
}
pub fn configure(key: &str, panel: &str, installed: &str) -> Result<()> {
    root()?;
    decode::<32>(key)?;
    version(installed)?;
    for component in inventory()?.iter().filter(|c| c.installed) {
        if let Some(current) = &component.version {
            ensure!(
                version(current)? <= version(env!("CARGO_PKG_VERSION"))?,
                "Panel bundle is older than an installed component; deploy a newer bundle before repair"
            );
        }
    }
    directory(Path::new("/etc/ephor"))?;
    let identity = crate::config::Config::load(Path::new("/var/lib/ephord/identity.json"))?;
    ensure!(
        identity.panel.starts_with("https://") && identity.panel == panel,
        "Updater panel must match the enrolled HTTPS identity"
    );
    if Path::new(CONFIG).exists() {
        check()?;
        let previous: Settings = serde_json::from_slice(&read_limited(Path::new(CONFIG), 4096)?)?;
        ensure!(
            previous.public_key == key
                && previous.panel == panel
                && previous.credential == identity.credential,
            "Existing updater trust or identity differs; local administration is required"
        );
        let journal = Path::new(STATE).join("journal.json");
        if journal.exists() {
            let journal: Journal = serde_json::from_slice(&read_limited(&journal, 30000)?)?;
            ensure!(
                ["succeeded", "failed", "rolled_back"].contains(&journal.status.as_str()),
                "Recover the interrupted update before repairing maintenance"
            );
        }
        return Ok(());
    }
    write_private(
        Path::new(CONFIG),
        &serde_json::to_vec(&Settings {
            panel: identity.panel,
            credential: identity.credential,
            public_key: key.into(),
        })?,
    )?;
    directory(Path::new(STATE))?;
    write_private(&Path::new(STATE).join("version"), installed.as_bytes())?;
    Ok(())
}
fn root() -> Result<()> {
    ensure!(
        Command::new("/usr/bin/id").arg("-u").output()?.stdout == b"0\n",
        "Updater requires root"
    );
    Ok(())
}
pub fn run() -> Result<()> {
    root()?;
    let _layout_lock = layout_lock()?;
    recover_layout()?;
    if unified() {
        layout_check()?;
    }
    private_file(Path::new(CONFIG))?;
    let settings: Settings = serde_json::from_slice(&read_limited(Path::new(CONFIG), 4096)?)?;
    crate::config::panel_url(&settings.panel)?;
    ensure!(
        settings.panel.starts_with("https://") && crate::config::token(&settings.credential),
        "Invalid updater identity"
    );
    decode::<32>(&settings.public_key)?;
    let state = Path::new(STATE);
    directory(state)?;
    if state.join("lock").exists() {
        private_file(&state.join("lock"))?;
    }
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(state.join("lock"))?;
    if lock.try_lock_exclusive().is_err() {
        return Ok(());
    }
    let client = super::client()?;
    let journal_path = state.join("journal.json");
    if journal_path.exists() {
        private_file(&journal_path)?;
        let mut journal: Journal = serde_json::from_slice(&read_limited(&journal_path, 30000)?)?;
        if journal.status == "prepared" {
            journal.status = "failed".into();
            write_private(&journal_path, &serde_json::to_vec(&journal)?)?;
        } else if !["succeeded", "rolled_back", "failed"].contains(&journal.status.as_str()) {
            restore(&mut journal, state)?;
        }
        // Persist the receipt until acknowledged; never repeat a job after an ambiguous response.
        report(&client, &settings, &journal)?;
    }
    let response = post(
        &client,
        &settings,
        "next",
        serde_json::json!({"publicKey":settings.public_key,"protocol":if unified(){3}else{2},"components":inventory()?}),
    )?;
    if response["job"].is_null() {
        return Ok(());
    }
    let job: Job = serde_json::from_value(response["job"].clone())?;
    if journal_path.exists() {
        let old: Journal = serde_json::from_slice(&read_limited(&journal_path, 30000)?)?;
        if old.job.id == job.id {
            return Ok(());
        }
    }
    ensure!(job.expires_at > now(), "Update request expired");
    private_file(&state.join("version"))?;
    let installed = String::from_utf8(read_limited(&state.join("version"), 64)?)?;
    let mut journal = Journal {
        job,
        components: Vec::new(),
        shared: unified(),
        previous_hash: String::new(),
        previous_version: installed.clone(),
        status: "failed".into(),
    };
    let mut mutation_started = false;
    let result = (|| -> Result<()> {
        let manifest = verify(&journal.job.envelope, &settings.public_key, &installed)?;
        ensure!(
            (manifest.updater_protocol == 3) == journal.shared,
            "Shared-binary updates require migrated layout and protocol 3"
        );
        let artifact = manifest
            .artifacts
            .get(std::env::consts::ARCH)
            .context("No artifact for this architecture")?;
        if manifest.updater_protocol >= 2 {
            let components = inventory()?;
            for c in components.iter().filter(|c| c.installed) {
                let current = c
                    .version
                    .as_deref()
                    .context("Cannot determine installed component version")?;
                ensure!(
                    version(current)? <= version(&manifest.version)?,
                    "Component downgrade rejected"
                );
            }
            ensure!(
                components
                    .iter()
                    .filter(|c| c.installed)
                    .any(|c| read_limited(Path::new(c.id.path()), MAX_BINARY)
                        .is_ok_and(|b| digest(&b) != artifact.sha256)),
                "All components already match the release"
            );
        }
        journal.status = "downloading".into();
        report(&client, &settings, &journal)?;
        // Release URLs are authorized by the pinned signer. Redirects may only remain HTTPS;
        // credentials are never attached to artifact requests (GitHub uses signed CDN redirects).
        let download = Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(Policy::limited(5))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(180))
            .build()?;
        let response = download
            .get(&artifact.url)
            .send()
            .map_err(|_| anyhow::anyhow!("Artifact download failed"))?;
        ensure!(response.status().is_success(), "Artifact download rejected");
        let mut bytes = Vec::new();
        response.take(artifact.size + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 == artifact.size && digest(&bytes) == artifact.sha256,
            "Artifact integrity rejected"
        );
        let health = post(&client, &settings, "health", serde_json::json!({}))?;
        ensure!(
            health["maintenanceBusy"] != true,
            "Machine is busy; retry maintenance after work completes"
        );
        for unit in ["ephor-updates-apply.service", "apt-daily-upgrade.service"] {
            ensure!(
                output("/usr/bin/systemctl", &["is-active", unit]).is_err(),
                "Operating-system maintenance is active"
            );
        }
        ensure!(
            component_installed(Component::Monitoring)?,
            "Monitoring is not installed"
        );
        let previous = read_limited(Path::new(BINARY), MAX_BINARY)?;
        journal.previous_hash = digest(&previous);
        write_private(&state.join("previous"), &previous)?;
        if manifest.updater_protocol >= 2 {
            ensure!(
                component_installed(Component::Updater)?,
                "Updater is not installed"
            );
            for component in COMPONENTS {
                if !component_installed(component)? {
                    continue;
                }
                let bytes = read_limited(Path::new(component.path()), MAX_BINARY)?;
                if !journal.shared {
                    write_private(
                        &state.join(format!("{}.previous", component.name())),
                        &bytes,
                    )?;
                }
                journal.components.push(ComponentBackup {
                    component,
                    hash: digest(&bytes),
                    active: component != Component::Updater && active(component),
                });
            }
        }
        journal.status = "prepared".into();
        write_private(&journal_path, &serde_json::to_vec(&journal)?)?;
        journal.status = "installing".into();
        report(&client, &settings, &journal)?;
        ensure!(
            journal.job.expires_at > now() && manifest.expires_at > now(),
            "Update request or release expired before installation"
        );
        write_private(&journal_path, &serde_json::to_vec(&journal)?)?;
        mutation_started = true;
        let started = now();
        if journal.components.is_empty() {
            install(&bytes)?;
            systemctl("restart")?;
        } else {
            for backup in &journal.components {
                if backup.active {
                    systemctl_component("stop", backup.component)?;
                }
            }
            if journal.shared {
                install(&bytes)?;
            } else {
                for backup in &journal.components {
                    install_component(&bytes, backup.component)?;
                }
            }
            for backup in &journal.components {
                if backup.active {
                    systemctl_component("restart", backup.component)?;
                }
            }
        }
        for _ in 0..18 {
            thread::sleep(Duration::from_secs(5));
            if let Ok(health) = post(&client, &settings, "health", serde_json::json!({})) {
                if health["lastSeen"].as_u64().unwrap_or(0) >= started
                    && health["telemetry"]["agentVersion"] == manifest.version
                    && health["telemetry"]["agentBuildId"] == manifest.build_id
                    && journal.components.iter().all(|backup| {
                        component_health(
                            backup.component,
                            &manifest,
                            &artifact.sha256,
                            backup.active,
                        )
                    })
                {
                    write_private(&state.join("version"), manifest.version.as_bytes())?;
                    journal.status = "succeeded".into();
                    write_private(&journal_path, &serde_json::to_vec(&journal)?)?;
                    return Ok(());
                }
            }
        }
        bail!("New agent did not report healthy")
    })();
    if result.is_err() {
        if mutation_started {
            restore(&mut journal, state)?;
        } else {
            journal.status = "failed".into();
            write_private(&journal_path, &serde_json::to_vec(&journal)?)?;
        }
    }
    report(&client, &settings, &journal)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    fn signed(key: &SigningKey, version: &str) -> Envelope {
        let manifest = serde_json::json!({"schema":1,"version":version,"buildId":"a".repeat(40),"protocol":1,"updaterProtocol":1,"channel":"stable","expiresAt":now()+60000,"artifacts":{"x86_64":{"url":"https://example.com/binary","sha256":"b".repeat(64),"size":10}}}).to_string();
        let signature = key
            .sign(manifest.as_bytes())
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Envelope {
            manifest,
            signature,
        }
    }
    #[test]
    fn rejects_tampering_wrong_keys_and_downgrades() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let public = key
            .verifying_key()
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let envelope = signed(&key, "0.2.0");
        assert!(verify(&envelope, &public, "0.1.0").is_ok());
        assert!(verify(&envelope, &public, "0.2.0").is_err());
        assert!(verify(&envelope, &public, "1.0.0").is_err());
        let mut bad = envelope.clone();
        bad.manifest.push(' ');
        assert!(verify(&bad, &public, "0.1.0").is_err());
        assert!(verify(&envelope, &"a".repeat(64), "0.1.0").is_err());
    }
    #[test]
    fn versions_are_strict_and_numeric() {
        assert!(version("0.10.0").unwrap() > version("0.9.0").unwrap());
        for v in ["1.2", "01.2.3", "1.2.3-beta", "1.2.3;id"] {
            assert!(version(v).is_err());
        }
    }
    #[test]
    fn systemd_health_requires_exact_role_path_arguments_and_pid() {
        let start = "{ path=/usr/local/libexec/ephor-security ; argv[]=/usr/local/libexec/ephor-security security-worker ; ignore_errors=no ; pid=42 ; code=(null) ; status=0/0 }";
        assert!(expected_start(start, Component::Security, 42));
        assert!(!expected_start(start, Component::Security, 43));
        assert!(!expected_start(start, Component::Deployments, 42));
        assert!(!expected_start(
            &start.replace("security-worker", "security-worker --extra"),
            Component::Security,
            42
        ));
        assert!(!expected_start(
            &format!("{start} {start}"),
            Component::Security,
            42
        ));
        assert!(!expected_start(
            &start.replace("/usr/local/libexec/ephor-security", "/tmp/other"),
            Component::Security,
            42
        ));
    }
}
