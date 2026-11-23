//! Local-admin migration. Paths and aliases are fixed; credentials and units are preserved.
use super::*;
use std::os::unix::fs::symlink;
const MARKER: &str = "/var/lib/ephor-updater/shared-layout";
const JOURNAL: &str = "/var/lib/ephor-updater/layout.json";
#[derive(Serialize, Deserialize)]
struct LayoutBackup {
    component: Component,
    hash: String,
    alias: bool,
    active: bool,
}
#[derive(Serialize, Deserialize)]
struct LayoutJournal {
    status: String,
    was_shared: bool,
    files: Vec<LayoutBackup>,
    active: Vec<Component>,
    previous_version: Option<String>,
}
pub(super) fn unified() -> bool {
    private_file(Path::new(MARKER)).is_ok()
        && read_limited(Path::new(MARKER), 16).is_ok_and(|b| b == b"3")
}
pub fn layout_check() -> Result<()> {
    root()?;
    ensure!(unified(), "Run the unified maintenance setup command first");
    let meta = fs::symlink_metadata(BINARY)?;
    ensure!(
        meta.is_file() && meta.uid() == 0 && meta.mode() & 0o022 == 0,
        "Unsafe shared executable"
    );
    for c in COMPONENTS.iter().skip(1) {
        let path = Path::new(c.legacy_path());
        if fs::symlink_metadata(path).is_ok() {
            ensure!(
                fs::read_link(path)? == Path::new(BINARY),
                "Unexpected legacy executable; rerun migration"
            );
        }
    }
    Ok(())
}
pub(super) fn layout_lock() -> Result<File> {
    directory(Path::new(STATE))?;
    let path = Path::new(STATE).join("layout.lock");
    if path.exists() {
        private_file(&path)?;
    }
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)?;
    file.try_lock_exclusive()
        .context("Another migration or update is running")?;
    Ok(file)
}
fn alias(component: Component) -> Result<()> {
    let path = Path::new(component.legacy_path());
    if fs::read_link(path).is_ok_and(|target| target == Path::new(BINARY)) {
        return Ok(());
    }
    let parent = path.parent().context("Missing parent")?;
    directory(parent)?;
    let temp = parent.join(format!(".ephor-{}-alias", component.name()));
    if fs::symlink_metadata(&temp).is_ok() {
        fs::remove_file(&temp)?;
    }
    symlink(BINARY, &temp)?;
    fs::rename(&temp, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}
fn save(j: &LayoutJournal) -> Result<()> {
    write_private(Path::new(JOURNAL), &serde_json::to_vec(j)?)
}
fn restore_layout(j: &mut LayoutJournal) -> Result<()> {
    let mut bytes = Vec::new();
    // Verify every backup before stopping anything or changing a path.
    for f in &j.files {
        let path = Path::new(STATE).join(format!("layout-{}.previous", f.component.name()));
        private_file(&path)?;
        let data = read_limited(&path, MAX_BINARY)?;
        ensure!(digest(&data) == f.hash, "Migration backup integrity failed");
        bytes.push(data);
    }
    for &c in &j.active {
        systemctl_component("stop", c)?;
    }
    for (f, data) in j.files.iter().zip(&bytes) {
        if f.alias {
            alias(f.component)?;
        } else {
            install_component(data, f.component)?;
        }
    }
    if j.was_shared {
        write_private(Path::new(MARKER), b"3")?;
    } else if Path::new(MARKER).exists() {
        fs::remove_file(MARKER)?;
        File::open(STATE)?.sync_all()?;
    }
    for &c in &j.active {
        systemctl_component("restart", c)?;
    }
    if let Some(v) = &j.previous_version {
        write_private(&Path::new(STATE).join("version"), v.as_bytes())?;
    }
    j.status = "rolled_back".into();
    save(j)
}
pub(super) fn recover_layout() -> Result<()> {
    if !Path::new(JOURNAL).exists() {
        return Ok(());
    }
    private_file(Path::new(JOURNAL))?;
    let mut j: LayoutJournal = serde_json::from_slice(&read_limited(Path::new(JOURNAL), 8192)?)?;
    if j.status == "installing" {
        restore_layout(&mut j)?;
    }
    Ok(())
}
pub fn migrate_layout() -> Result<()> {
    root()?;
    let _lock = layout_lock()?;
    recover_layout()?;
    // Do not overlap a signed update, including an interrupted one.
    let journal = Path::new(STATE).join("journal.json");
    if journal.exists() {
        private_file(&journal)?;
        let j: Journal = serde_json::from_slice(&read_limited(&journal, 30000)?)?;
        ensure!(
            ["succeeded", "failed", "rolled_back"].contains(&j.status.as_str()),
            "Recover the previous signed update before migrating"
        );
    }
    if Path::new(CONFIG).exists() {
        check()?;
        let settings: Settings = serde_json::from_slice(&read_limited(Path::new(CONFIG), 4096)?)?;
        let health = post(
            &super::super::client()?,
            &settings,
            "health",
            serde_json::json!({}),
        )?;
        ensure!(
            health["maintenanceActive"] == true && health["maintenanceBusy"] == false,
            "Use a fresh panel maintenance command after current work completes"
        );
    }
    for unit in ["ephor-updates-apply.service", "apt-daily-upgrade.service"] {
        ensure!(
            output("/usr/bin/systemctl", &["is-active", unit]).is_err(),
            "OS maintenance is active"
        );
    }
    let candidate = std::env::current_exe()?;
    let meta = fs::symlink_metadata(&candidate)?;
    ensure!(
        meta.is_file() && meta.uid() == 0 && meta.mode() & 0o022 == 0,
        "Unsafe migration executable"
    );
    let bytes = read_limited(&candidate, MAX_BINARY)?;
    let mut j = LayoutJournal {
        status: "installing".into(),
        was_shared: unified(),
        files: Vec::new(),
        active: COMPONENTS
            .into_iter()
            .filter(|c| *c != Component::Updater && active(*c))
            .collect(),
        previous_version: fs::read_to_string(Path::new(STATE).join("version")).ok(),
    };
    for component in COMPONENTS {
        let path = Path::new(component.legacy_path());
        let meta = match fs::symlink_metadata(path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        let is_alias = meta.file_type().is_symlink();
        ensure!(
            meta.uid() == 0
                && if is_alias {
                    component != Component::Monitoring && fs::read_link(path)? == Path::new(BINARY)
                } else {
                    meta.is_file() && meta.mode() & 0o022 == 0
                },
            "Unsafe legacy executable"
        );
        let current = String::from_utf8(output(component.legacy_path(), &["--version"])?)?;
        let current = current
            .trim()
            .strip_prefix("ephord ")
            .context("Unknown component version")?;
        ensure!(
            version(current)? <= version(env!("CARGO_PKG_VERSION"))?,
            "Migration would downgrade a component"
        );
        let old = read_limited(path, MAX_BINARY)?;
        write_private(
            &Path::new(STATE).join(format!("layout-{}.previous", component.name())),
            &old,
        )?;
        j.files.push(LayoutBackup {
            component,
            hash: digest(&old),
            alias: is_alias,
            active: component != Component::Updater && active(component),
        });
    }
    ensure!(
        j.files.iter().any(|f| f.component == Component::Monitoring),
        "Enroll monitoring first"
    );
    // Keep a known migration-capable executable for recovery even if power fails
    // before the old updater has been converted. It is private, not a running service.
    let recovery = Path::new(STATE).join("layout-recovery");
    write_private(&recovery, &bytes)?;
    fs::set_permissions(&recovery, fs::Permissions::from_mode(0o700))?;
    save(&j)?;
    let result = (|| -> Result<()> {
        for &c in &j.active {
            systemctl_component("stop", c)?;
        }
        install(&bytes)?;
        for f in &j.files {
            if f.component != Component::Monitoring {
                alias(f.component)?;
            }
        }
        write_private(Path::new(MARKER), b"3")?;
        for &c in &j.active {
            systemctl_component("restart", c)?;
        }
        let manifest: Manifest = serde_json::from_value(
            serde_json::json!({"schema":1,"version":env!("CARGO_PKG_VERSION"),"buildId":option_env!("EPHOR_BUILD_ID").unwrap_or("development"),"protocol":1,"updaterProtocol":3,"channel":"stable","expiresAt":now()+60000,"artifacts":{}}),
        )?;
        for _ in 0..20 {
            if j.active
                .iter()
                .all(|c| component_health(*c, &manifest, &digest(&bytes), true))
            {
                layout_check()?;
                if j.previous_version.is_some() {
                    write_private(
                        &Path::new(STATE).join("version"),
                        env!("CARGO_PKG_VERSION").as_bytes(),
                    )?;
                }
                j.status = "complete".into();
                save(&j)?;
                fs::remove_file(&recovery)?;
                return Ok(());
            }
            thread::sleep(Duration::from_secs(1));
        }
        bail!("A service did not restart after migration")
    })();
    if let Err(e) = result {
        restore_layout(&mut j)?;
        return Err(e);
    }
    Ok(())
}
pub fn recover() -> Result<()> {
    root()?;
    let _lock = layout_lock()?;
    recover_layout()
}
