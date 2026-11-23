//! Narrow APT policy adapter. Jobs select typed settings, never commands, paths or repositories.
use super::*;
use chrono::{Datelike, Timelike, Utc};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::process::{Command, Stdio};
const POLICY: &str = "/var/lib/ephor-protections/updates.json";
const PAUSED: &str = "/var/lib/ephor-protections/updates-paused";
const REQUEST: &str = "/var/lib/ephor-protections/update-request.json";
const RESULT: &str = "/var/lib/ephor-protections/update-result.json";
const APT: &str = "/etc/apt/apt.conf.d/99zz-ephor-updates";
const TIMER: &str = "/etc/systemd/system/apt-daily-upgrade.timer.d/90-ephor.conf";
const SERVICE: &str = "/etc/systemd/system/apt-daily-upgrade.service.d/90-ephor.conf";
const OWNED: [&str; 3] = [APT, TIMER, SERVICE];
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Policy {
    days: Vec<u32>,
    start_minute: u32,
    // Preserve existing on-machine authorizations until explicitly reconfigured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    window_minutes: Option<u32>,
    automatic_reboot: bool,
    reboot_minute: u32,
}
impl Policy {
    pub(super) fn validate(&self) -> Result<()> {
        ensure!(
            !self.days.is_empty()
                && self.days.len() <= 7
                && self.days.iter().all(|d| (1..=7).contains(d)),
            "Invalid maintenance days"
        );
        ensure!(
            self.start_minute < 1440 && self.reboot_minute < 1440,
            "Invalid UTC update or reboot time"
        );
        if let Some(length) = self.window_minutes {
            ensure!(
                (60..=360).contains(&length)
                    && self.start_minute + length <= 1440
                    && self.reboot_minute >= self.start_minute
                    && self.reboot_minute < self.start_minute + length,
                "Invalid legacy maintenance policy"
            );
        }
        Ok(())
    }
    fn permits(&self, day: u32, minute: u32) -> bool {
        self.days.contains(&day)
            && self
                .window_minutes
                .map_or(minute == self.start_minute, |length| {
                    minute >= self.start_minute && minute < self.start_minute + length
                })
    }
    fn permits_reboot(&self, day: u32, minute: u32) -> bool {
        self.days.contains(&day) && minute == self.reboot_minute
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Managed {
    policy: Policy,
    enabled: bool,
    files: BTreeMap<String, String>,
    timer_enabled: bool,
    timer_active: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    job: Job,
    credential_hash: String,
    update_revision: String,
}
#[derive(Serialize, Deserialize)]
struct ApplyResult {
    id: String,
    error: Option<String>,
}
fn system(args: &[&str]) -> Result<String> {
    io::command("/usr/bin/systemctl", args, 15)
}
fn supported() -> bool {
    let os = fs::read_to_string("/etc/os-release").unwrap_or_default();
    (os.lines()
        .any(|l| ["ID=debian", "ID=ubuntu", "ID=\"debian\"", "ID=\"ubuntu\""].contains(&l)))
        && Path::new("/usr/bin/apt-get").exists()
        && Path::new("/run/systemd/system").exists()
        && Path::new("/etc/systemd/system/ephor-updates-apply.service").exists()
}
fn installed() -> bool {
    Path::new("/usr/bin/unattended-upgrade").exists()
}
fn managed() -> Result<Managed> {
    let m: Managed = io::load(Path::new(POLICY))?;
    m.policy.validate()?;
    ensure!(
        m.files.len() == OWNED.len() && m.files.keys().all(|p| OWNED.contains(&p.as_str())),
        "Invalid owned update files"
    );
    Ok(m)
}
fn intact(m: &Managed) -> bool {
    !Path::new(PAUSED).exists()
        && m.files.iter().all(|(p, content)| {
            fs::symlink_metadata(p).is_ok_and(|s| {
                s.is_file() && !s.file_type().is_symlink() && s.uid() == 0 && s.mode() & 0o022 == 0
            }) && fs::read_to_string(p).is_ok_and(|s| s == *content)
        })
}
fn active(unit: &str) -> bool {
    // oneshot services stay "activating" for the entire package transaction.
    system(&["show", unit, "--property=ActiveState", "--value"])
        .map(|s| !matches!(s.trim(), "inactive" | "failed"))
        .unwrap_or(true)
}
fn busy() -> bool {
    active("ephor-updates-apply.service") || active("apt-daily-upgrade.service")
}
fn apt_config(enabled: bool) -> String {
    format!(
        r#"// Managed by Ephor. Remove management through Ephor before editing.
APT::Periodic::Enable "1";
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "{}";
#clear Unattended-Upgrade::Allowed-Origins;
#clear Unattended-Upgrade::Origins-Pattern;
Unattended-Upgrade::Origins-Pattern {{
 "origin=Ubuntu,codename=${{distro_codename}}-security,label=Ubuntu";
 "origin=UbuntuESMApps,codename=${{distro_codename}}-apps-security,label=UbuntuESMApps";
 "origin=UbuntuESM,codename=${{distro_codename}}-infra-security,label=UbuntuESM";
 "origin=Debian,codename=${{distro_codename}}-security,label=Debian-Security";
 "origin=Debian,codename=${{distro_codename}},label=Debian-Security";
}};
APT::Get::AllowUnauthenticated "false";
Acquire::AllowInsecureRepositories "false";
Acquire::AllowDowngradeToInsecureRepositories "false";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::InstallOnShutdown "false";
Unattended-Upgrade::AutoFixInterruptedDpkg "false";
Unattended-Upgrade::Remove-Unused-Dependencies "false";
Unattended-Upgrade::Remove-New-Unused-Dependencies "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "false";
"#,
        if enabled { 1 } else { 0 }
    )
}
fn max_gap(policy: &Policy) -> u32 {
    let mut days = policy.days.clone();
    days.sort();
    days.dedup();
    days.iter()
        .enumerate()
        .map(|(i, d)| {
            if i + 1 < days.len() {
                days[i + 1] - d
            } else {
                7 + days[0] - d
            }
        })
        .max()
        .unwrap_or(7)
}
fn files(policy: &Policy, enabled: bool) -> BTreeMap<String, String> {
    let weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let days = policy
        .days
        .iter()
        .map(|d| weekdays[(*d - 1) as usize])
        .collect::<Vec<_>>()
        .join(",");
    BTreeMap::from([
        (APT.into(), format!("{}Ephor::Updates::Managed \"true\";\nEphor::Updates::MaxGapDays \"{}\";\nEphor::Updates::AutomaticReboot \"{}\";\n", apt_config(enabled), max_gap(policy), policy.automatic_reboot)),
        (TIMER.into(), format!("[Timer]\nOnCalendar=\nOnBootSec=\nOnStartupSec=\nOnUnitActiveSec=\nOnUnitInactiveSec=\nOnCalendar={days} *-*-* {:02}:{:02}:00 UTC\nRandomizedDelaySec=0\nAccuracySec=1s\nPersistent=false\n", policy.start_minute / 60, policy.start_minute % 60)),
        (SERVICE.into(), "[Service]\nExecCondition=/usr/local/libexec/ephor-protections protection-updates-window\nExecStartPre=/usr/bin/apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update\nExecStartPre=/usr/local/libexec/ephor-protections protection-updates-continue\n".into()),
    ])
}
fn effective(m: &Managed) -> bool {
    let Ok(config) = io::command("/usr/bin/apt-config", &["dump"], 10) else {
        return false;
    };
    config.lines().any(|l| {
        l == format!(
            "APT::Periodic::Unattended-Upgrade \"{}\";",
            if m.enabled { 1 } else { 0 }
        )
    }) && config
        .lines()
        .any(|l| l == "Unattended-Upgrade::Automatic-Reboot \"false\";")
        && config
            .lines()
            .filter(|l| l.starts_with("Unattended-Upgrade::Origins-Pattern:: "))
            .count()
            == 5
        && !config
            .lines()
            .any(|l| l.starts_with("Unattended-Upgrade::Allowed-Origins:: "))
        && config
            .lines()
            .filter(|l| l.starts_with("Unattended-Upgrade::Origins-Pattern:: "))
            .all(|l| {
                apt_config(m.enabled)
                    .contains(l.trim_start_matches("Unattended-Upgrade::Origins-Pattern:: "))
            })
}
pub(super) fn snapshot() -> Value {
    let m = managed().ok();
    let healthy = m.as_ref().is_some_and(|m| intact(m) && effective(m));
    let last_run = fs::metadata("/var/lib/apt/periodic/upgrade-stamp")
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let reboot = io::load::<Value>(Path::new("/var/lib/ephor-protections/update-reboot.json")).ok();
    json!({"scheduleVersion":2,"lastRunAt":last_run,"lastRebootRequestAt":reboot.as_ref().and_then(|v| v["at"].as_u64()),"supported":supported(),"installed":installed(),"managed":Path::new(POLICY).exists(),"enabled":m.as_ref().is_some_and(|m| m.enabled),"healthy":healthy,"busy":busy(),"rebootRequired":Path::new("/var/run/reboot-required").exists(),"policy":m.as_ref().map(|m| &m.policy),"detail":if Path::new(POLICY).exists() && !healthy {"Managed configuration changed or installation incomplete. Review locally; scheduled work is blocked."} else if m.as_ref().is_some_and(|m| m.enabled) {"Security updates scheduled in UTC. Starts and reboots require fresh authenticated panel contact. Checks and optional reboots have separate scheduled times."} else {"Automatic reboots require explicit opt-in. Existing APT configuration is preserved beneath Ephor overrides."}})
}
/// Include external policy changes in the reviewed revision without sending configuration secrets.
pub(super) fn revision(h: &mut Sha256) {
    for dir in [
        "/etc/apt/apt.conf.d",
        "/etc/systemd/system/apt-daily-upgrade.timer.d",
        "/etc/systemd/system/apt-daily-upgrade.service.d",
    ] {
        let mut paths = fs::read_dir(dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect::<Vec<_>>();
        paths.sort();
        for p in paths.iter().take(256) {
            h.update(p.to_string_lossy().as_bytes());
            if let Ok(f) = fs::File::open(p) {
                let mut b = vec![];
                let _ = f.take(2_000_000).read_to_end(&mut b);
                h.update(b);
            }
        }
    }
    h.update(fs::read(POLICY).unwrap_or_default());
    h.update([u8::from(Path::new(PAUSED).exists())]);
}
fn current_revision() -> String {
    let mut h = Sha256::new();
    revision(&mut h);
    format!("{:x}", h.finalize())
}
pub(super) fn validate(job: &Job) -> Result<()> {
    ensure!(
        uuid(&job.id)
            && job.status == "running"
            && job.result.is_none()
            && job.created_at <= now() + 30_000
            && job.expires_at > now()
            && job.expires_at <= now() + 900_000,
        "Invalid update job envelope"
    );
    ensure!(
        job.parameters.trusted_ips.is_empty() && job.parameters.ip.is_none(),
        "Unexpected update parameters"
    );
    ensure!(
        !Path::new("/run/systemd/shutdown/scheduled").exists(),
        "An existing shutdown is scheduled; review it locally first"
    );
    ensure!(
        supported(),
        "Update management requires a repaired helper on Debian/Ubuntu with systemd"
    );
    ensure!(
        [
            "updates.install",
            "updates.configure",
            "updates.disable",
            "updates.remove"
        ]
        .contains(&job.action.as_str()),
        "Unsupported update action"
    );
    let configuring = matches!(job.action.as_str(), "updates.install" | "updates.configure");
    ensure!(
        configuring == job.parameters.policy.is_some(),
        "Unexpected update policy"
    );
    if let Some(p) = &job.parameters.policy {
        p.validate()?;
    }
    if job.action == "updates.install" {
        ensure!(
            !Path::new(POLICY).exists() && OWNED.iter().all(|p| fs::symlink_metadata(p).is_err()),
            "Reserved update policy already exists"
        );
    } else {
        let m = managed()?;
        ensure!(
            intact(&m) && effective(&m),
            "Update policy drift: inspect local configuration before retrying"
        );
    }
    ensure!(
        !active("apt-daily-upgrade.service") && !package_process(),
        "Wait for the current package operation to finish"
    );
    Ok(())
}
pub(super) fn execute(job: &Job) -> Result<()> {
    ensure!(
        !active("ephor-updates-apply.service"),
        "Update configuration already running"
    );
    let identity = Config::load(identity_path())?;
    io::save(
        Path::new(REQUEST),
        &Request {
            job: job.clone(),
            update_revision: current_revision(),
            credential_hash: format!("{:x}", Sha256::digest(identity.credential.as_bytes())),
        },
    )?;
    system(&["start", "--no-block", "ephor-updates-apply.service"])?;
    Ok(())
}
pub(super) fn outcome(id: &str) -> Option<Result<()>> {
    if let Ok(r) = io::load::<ApplyResult>(Path::new(RESULT)) {
        if r.id == id {
            return Some(match r.error {
                None => Ok(()),
                Some(e) => Err(anyhow::anyhow!(e)),
            });
        }
    }
    if active("ephor-updates-apply.service") || Path::new(REQUEST).exists() {
        None
    } else {
        Some(Err(anyhow::anyhow!(
            "Update setup interrupted; inspect local policy before retrying"
        )))
    }
}

fn write_files(m: &Managed) -> Result<()> {
    // Journal ownership first; any partial application fails the exact-content guard.
    io::save(Path::new(POLICY), m)?;
    for (path, content) in &m.files {
        let parent = Path::new(path).parent().context("Missing parent")?;
        fs::create_dir_all(parent)?;
        let meta = fs::symlink_metadata(parent)?;
        ensure!(
            meta.is_dir()
                && !meta.file_type().is_symlink()
                && meta.uid() == 0
                && meta.mode() & 0o022 == 0,
            "Unsafe update configuration directory"
        );
        io::write(Path::new(path), content.as_bytes())?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o644))?;
    }
    system(&["daemon-reload"])?;
    Ok(())
}
fn authenticated(r: &Request) -> Result<()> {
    ensure!(
        !Path::new(PAUSED).exists(),
        "Update management paused locally"
    );
    let c = Config::load(identity_path())?;
    ensure!(
        r.job.expires_at > now()
            && c.machine_id.as_deref() == Some(&r.job.machine_id)
            && format!("{:x}", Sha256::digest(c.credential.as_bytes())) == r.credential_hash,
        "Update authorization expired or rotated"
    );
    Ok(())
}
fn install_package() -> Result<()> {
    // Package maintainer scripts need normal root privileges. No arbitrary arguments or shell.
    // systemd owns this process; there is deliberately no kill timeout for dpkg transactions.
    for args in [
        vec![
            "-o",
            "APT::Update::Error-Mode=any",
            "-o",
            "Acquire::Retries=0",
            "-o",
            "Acquire::http::Timeout=30",
            "-o",
            "Acquire::https::Timeout=30",
            "update",
        ],
        vec![
            "-y",
            "--no-install-recommends",
            "--no-remove",
            "-o",
            "DPkg::Lock::Timeout=60",
            "-o",
            "Dpkg::Options::=--force-confold",
            "install",
            "unattended-upgrades",
        ],
    ] {
        let status = Command::new("/usr/bin/apt-get")
            .args([
                "-o",
                "APT::Get::AllowUnauthenticated=false",
                "-o",
                "Acquire::AllowInsecureRepositories=false",
                "-o",
                "Acquire::AllowDowngradeToInsecureRepositories=false",
            ])
            .args(args)
            .env_clear()
            .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
            .env("HOME", "/root")
            .env("DEBIAN_FRONTEND", "noninteractive")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        ensure!(
            status.success(),
            "APT installation failed; inspect the machine's package logs"
        );
    }
    Ok(())
}
fn apply(r: &Request) -> Result<()> {
    authenticated(r)?;
    // The dispatch validated the complete reviewed revision. Recheck the APT scope here:
    // unrelated live CrowdSec lease changes must not invalidate a dispatched update request.
    ensure!(
        r.update_revision == current_revision(),
        "APT configuration changed after dispatch"
    );
    validate(&r.job)?;
    let prior = managed().ok();
    if r.job.action == "updates.remove" {
        let m = prior.context("Managed policy missing")?;
        for p in OWNED {
            fs::remove_file(p)?;
        }
        fs::remove_file(POLICY)?;
        system(&["daemon-reload"])?;
        system(&[
            if m.timer_enabled { "enable" } else { "disable" },
            "apt-daily-upgrade.timer",
        ])?;
        system(&[
            if m.timer_active { "restart" } else { "stop" },
            "apt-daily-upgrade.timer",
        ])?;
        return Ok(());
    }
    let policy = r
        .job
        .parameters
        .policy
        .clone()
        .or_else(|| prior.as_ref().map(|m| m.policy.clone()))
        .context("Missing maintenance policy")?;
    let mut m = Managed {
        policy,
        enabled: false,
        files: BTreeMap::new(),
        timer_enabled: prior.as_ref().map_or_else(
            || system(&["is-enabled", "--quiet", "apt-daily-upgrade.timer"]).is_ok(),
            |m| m.timer_enabled,
        ),
        timer_active: prior
            .as_ref()
            .map_or_else(|| active("apt-daily-upgrade.timer"), |m| m.timer_active),
    };
    m.files = files(&m.policy, false);
    write_files(&m)?;
    if !installed() && r.job.action != "updates.disable" {
        install_package()?;
    }
    // Never enable after an expired install or enrollment rotation. Disabled policy is retained for review.
    authenticated(r)?;
    ensure!(
        intact(&m) && effective(&m),
        "Update setup conflict; policy remains paused"
    );
    m.enabled = r.job.action != "updates.disable";
    m.files = files(&m.policy, m.enabled);
    write_files(&m)?;
    system(&["enable", "apt-daily-upgrade.timer"])?;
    system(&["restart", "apt-daily-upgrade.timer"])?;
    Ok(())
}
pub fn apply_request() -> Result<()> {
    io::root()?;
    let r: Request = io::load(Path::new(REQUEST))?;
    // Consume before effects: systemd restarts cannot replay a privileged request.
    fs::remove_file(REQUEST)?;
    fs::File::open(STATE)?.sync_all()?;
    let result = apply(&r);
    io::save(
        Path::new(RESULT),
        &ApplyResult {
            id: r.job.id,
            error: result
                .as_ref()
                .err()
                .map(|e| e.to_string().chars().take(500).collect()),
        },
    )?;
    result
}
pub(super) fn contact() -> Result<()> {
    io::save(
        Path::new("/var/lib/ephor-protections/update-contact.json"),
        &json!({"at":now(), "boot":fs::read_to_string("/proc/sys/kernel/random/boot_id")?}),
    )
}
fn fresh_contact() -> bool {
    let Ok(c) = io::load::<Value>(Path::new("/var/lib/ephor-protections/update-contact.json"))
    else {
        return false;
    };
    c["at"]
        .as_u64()
        .is_some_and(|t| t <= now() && now() - t < 90_000)
        && c["boot"].as_str()
            == fs::read_to_string("/proc/sys/kernel/random/boot_id")
                .ok()
                .as_deref()
}
pub fn pause_locally() -> Result<()> {
    io::root()?;
    io::write(
        Path::new(PAUSED),
        b"Locally paused; inspect policy before removing this file.\n",
    )?;
    Ok(())
}
fn authorized_policy() -> Result<Managed> {
    let m = managed()?;
    ensure!(
        m.enabled && intact(&m) && effective(&m) && fresh_contact(),
        "Update policy or authenticated contact unavailable"
    );
    Ok(m)
}
// Kept as the installed service entry point for compatibility with existing policies.
pub fn window() -> Result<()> {
    let m = authorized_policy()?;
    let current = chrono::DateTime::<Utc>::from(SystemTime::now());
    ensure!(
        m.policy.permits(
            current.weekday().number_from_monday(),
            current.hour() * 60 + current.minute()
        ),
        "Not the scheduled update time"
    );
    Ok(())
}
// Refreshing indexes may extend beyond the scheduled minute; recheck authorization,
// not the start time, before continuing this already-started check.
pub fn continue_check() -> Result<()> {
    authorized_policy().map(|_| ())
}
fn reboot_schedule() -> Result<()> {
    let m = authorized_policy()?;
    let current = chrono::DateTime::<Utc>::from(SystemTime::now());
    ensure!(
        m.policy.automatic_reboot
            && m.policy.permits_reboot(
                current.weekday().number_from_monday(),
                current.hour() * 60 + current.minute()
            ),
        "Not the scheduled reboot time"
    );
    Ok(())
}
fn package_process() -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return true;
    };
    entries
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .bytes()
                .all(|b| b.is_ascii_digit())
        })
        .any(|e| {
            fs::read_to_string(e.path().join("comm")).is_ok_and(|s| {
                [
                    "dpkg",
                    "apt",
                    "apt-get",
                    "unattended-upgr",
                    "unattended-upgra",
                ]
                .contains(&s.trim())
            })
        })
}
pub fn reboot_if_due() -> Result<()> {
    io::root()?;
    if reboot_schedule().is_err() {
        return Ok(());
    }
    let m = managed()?;
    let current = chrono::DateTime::<Utc>::from(SystemTime::now());
    if !m.policy.automatic_reboot
        || current.hour() * 60 + current.minute() != m.policy.reboot_minute
        || !Path::new("/var/run/reboot-required").exists()
        || busy()
        || package_process()
    {
        return Ok(());
    }
    // Failure to inspect sessions is a veto, not permission to reboot.
    ensure!(
        io::command("/usr/bin/users", &[], 5)?.is_empty()
            && io::command("/usr/bin/loginctl", &["list-sessions", "--no-legend"], 5)?.is_empty()
            && system(&["list-jobs", "--no-legend"])?
                .lines()
                .all(|l| l.contains("ephor-updates-reboot.service")),
        "Users or system jobs are active; reboot skipped"
    );
    let marker = Path::new("/var/lib/ephor-protections/update-reboot.json");
    let date = current.format("%Y-%m-%d").to_string();
    if io::load::<Value>(marker)
        .ok()
        .is_some_and(|v| v["date"] == date)
    {
        return Ok(());
    }
    reboot_schedule()?;
    io::save(marker, &json!({"date":date,"at":now()}))?; // A blocked reboot is not retried in the same scheduled day.
    system(&["--check-inhibitors=yes", "--no-block", "reboot"])?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn policy() -> Policy {
        Policy {
            days: vec![1, 3, 5],
            start_minute: 120,
            window_minutes: None,
            automatic_reboot: false,
            reboot_minute: 240,
        }
    }
    #[test]
    fn independent_times_and_legacy_policy_are_safe() {
        let mut p = policy();
        p.validate().unwrap();
        assert!(p.permits(1, 120));
        assert!(!p.permits(1, 121));
        assert!(!p.permits(2, 120));
        assert!(p.permits_reboot(1, 240));
        assert!(!p.permits_reboot(2, 240));
        p.start_minute = 1430;
        p.reboot_minute = 60;
        p.validate().unwrap();
        assert!(p.permits(1, 1430));
        assert!(p.permits_reboot(1, 60));
        p.reboot_minute = 1440;
        assert!(p.validate().is_err());
        p = policy();
        p.window_minutes = Some(180);
        p.validate().unwrap();
        assert!(p.permits(1, 121));
        assert!(!p.permits(1, 300));
        p.reboot_minute = 300;
        assert!(p.validate().is_err());
        p = policy();
        p.days = vec![0];
        assert!(p.validate().is_err());
        assert!(serde_json::from_value::<Policy>(json!({"days":[1],"startMinute":120,"automaticReboot":false,"rebootMinute":180,"command":"id"})).is_err());
    }
    #[test]
    fn generated_config_scopes_origins_and_disables_native_reboots() {
        let f = files(&policy(), true);
        assert!(f[APT].contains("Automatic-Reboot \"false\""));
        assert!(f[APT].contains("#clear Unattended-Upgrade::Allowed-Origins"));
        assert!(f[TIMER].contains("Mon,Wed,Fri *-*-* 02:00:00 UTC"));
        assert!(f[TIMER].contains("Persistent=false"));
        assert!(f[SERVICE].contains("ExecCondition="));
        assert!(files(&policy(), false)[APT].contains("Unattended-Upgrade \"0\""));
    }
    #[test]
    #[ignore = "disposable Debian container with reboot/systemd emulator only"]
    fn linux_update_lifecycle() {
        io::root().unwrap();
        let mut identity = Config::new("https://panel.example.com").unwrap();
        identity.machine_id = Some("12345678-1234-1234-1234-123456789abc".into());
        identity.save(identity_path(), true).unwrap();
        let state = State::default();
        io::save(state_path(), &state).unwrap();
        let current = chrono::DateTime::<Utc>::from(SystemTime::now());
        let minute = current.hour() * 60 + current.minute();
        let mut policy = policy();
        policy.days = vec![1, 2, 3, 4, 5, 6, 7];
        policy.start_minute = minute;
        policy.reboot_minute = minute;
        let make_job = |action: &str, policy: Option<Policy>| Job {
            id: "12345678-1234-1234-1234-123456789abd".into(),
            machine_id: identity.machine_id.clone().unwrap(),
            action: action.into(),
            parameters: Parameters {
                policy,
                trusted_ips: vec![],
                ip: None,
            },
            revision: super::super::revision(&state),
            expires_at: now() + 900_000,
            created_at: now(),
            status: "running".into(),
            result: None,
        };
        let original = fs::read("/etc/apt/apt.conf.d/20auto-upgrades").ok();
        let job = make_job("updates.install", Some(policy.clone()));
        execute(&job).unwrap();
        apply_request().unwrap();
        assert!(apply_request().is_err(), "consumed requests cannot replay");
        assert!(outcome(&job.id).unwrap().is_ok());
        assert!(installed());
        assert!(intact(&managed().unwrap()));
        assert!(effective(&managed().unwrap()));
        assert!(window().is_err(), "no contact means no updates");
        contact().unwrap();
        continue_check().unwrap();
        io::save(Path::new("/var/lib/ephor-protections/update-contact.json"),&json!({"at":now()-100000,"boot":fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap()})).unwrap();
        assert!(window().is_err(), "stale contact must block scheduled work");
        contact().unwrap();
        fs::write("/var/run/reboot-required", "test").unwrap();
        reboot_if_due().unwrap();
        assert!(
            !Path::new("/tmp/ephor-test-reboot-requested").exists(),
            "reboots default off"
        );
        policy.automatic_reboot = true;
        let current = chrono::DateTime::<Utc>::from(SystemTime::now());
        policy.reboot_minute = current.hour() * 60 + current.minute();
        let job = make_job("updates.configure", Some(policy));
        execute(&job).unwrap();
        apply_request().unwrap();
        fs::write("/tmp/ephor-test-package-busy", "test").unwrap();
        reboot_if_due().unwrap();
        assert!(!Path::new("/tmp/ephor-test-reboot-requested").exists());
        fs::remove_file("/tmp/ephor-test-package-busy").unwrap();
        reboot_if_due().unwrap();
        assert!(
            Path::new("/tmp/ephor-test-reboot-requested").exists(),
            "only emulator can receive reboot"
        );
        pause_locally().unwrap();
        assert!(window().is_err());
        assert!(!intact(&managed().unwrap()));
        fs::remove_file(PAUSED).unwrap();
        let job = make_job("updates.disable", None);
        execute(&job).unwrap();
        apply_request().unwrap();
        assert!(!managed().unwrap().enabled);
        assert!(window().is_err());
        fs::write(APT, "// local change\n").unwrap();
        assert!(!intact(&managed().unwrap()));
        assert!(validate(&make_job("updates.remove", None)).is_err());
        let m = managed().unwrap();
        fs::write(APT, &m.files[APT]).unwrap();
        let job = make_job("updates.remove", None);
        execute(&job).unwrap();
        apply_request().unwrap();
        assert!(!Path::new(POLICY).exists());
        assert!(OWNED.iter().all(|p| !Path::new(p).exists()));
        assert!(installed());
        // Package installation may create its standard policy, but Ephor never overwrites it.
        if let Some(original) = original {
            assert_eq!(
                fs::read("/etc/apt/apt.conf.d/20auto-upgrades").unwrap(),
                original
            );
        }
        assert!(window().is_err());
    }
}
