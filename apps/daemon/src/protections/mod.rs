mod engine;
mod firewall;
mod io;
pub mod updates;
use crate::config::Config;
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Read,
    net::IpAddr,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const STATE: &str = "/var/lib/ephor-protections";
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn identity_path() -> &'static Path {
    Path::new("/var/lib/ephor-protections/identity.json")
}
fn state_path() -> &'static Path {
    Path::new("/var/lib/ephor-protections/state.json")
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    managed: bool,
    #[serde(default)]
    firewall_owned: bool,
    trusted_ips: Vec<IpAddr>,
    blocking: bool,
    confirm_before: Option<u64>,
    #[serde(skip)]
    trial_started: Option<Instant>,
    exemptions: BTreeMap<IpAddr, u64>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Parameters {
    #[serde(default)]
    trusted_ips: Vec<IpAddr>,
    #[serde(default)]
    policy: Option<updates::Policy>,
    #[serde(default)]
    ip: Option<IpAddr>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    id: String,
    machine_id: String,
    action: String,
    parameters: Parameters,
    revision: String,
    expires_at: u64,
    created_at: u64,
    status: String,
    result: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Receipt {
    id: String,
    status: String,
    result: String,
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn revision(state: &State) -> String {
    let mut h = Sha256::new();
    h.update(serde_json::to_vec(state).unwrap());
    h.update(
        engine::ports()
            .iter()
            .flat_map(|n| n.to_be_bytes())
            .collect::<Vec<_>>(),
    );
    h.update([u8::from(engine::intact()), u8::from(engine::external())]);
    h.update(fs::read(format!("{STATE}/version")).unwrap_or_default());
    updates::revision(&mut h);
    format!("{:x}", h.finalize())
}
fn snapshot(state: &State, detail: &str, bans: &[firewall::Ban]) -> Value {
    let running = state.managed && engine::running();
    json!({"updates":updates::snapshot(),"ownership":if engine::external(){"external"}else if state.managed{"managed"}else{"absent"},"supported":engine::supported(),"version":fs::read_to_string(format!("{STATE}/version")).unwrap_or_default(),"engineRunning":running,"acquisitionReady":running && engine::intact() && engine::acquisition_ready(),"blocking":if !state.blocking {"off"} else if state.confirm_before.is_some(){"pending"}else{"enabled"},"confirmBefore":state.confirm_before,"sshPorts":engine::ports(),"trustedIPs":state.trusted_ips,"revision":revision(state),"detail":detail,"bans":bans})
}
fn post(identity: &Config, route: &str, body: &impl Serialize) -> Result<Value> {
    let response = crate::client()?
        .post(format!("{}/api/agent/protections/{route}", identity.panel))
        .bearer_auth(&identity.credential)
        .json(body)
        .send()
        .map_err(|_| anyhow::anyhow!("Protection panel unavailable"))?;
    if matches!(response.status().as_u16(), 401 | 403) {
        anyhow::bail!("PROTECTION_CREDENTIAL_REVOKED");
    }
    ensure!(
        response.status().is_success(),
        "Protection panel unavailable or request rejected"
    );
    let mut bytes = Vec::new();
    response.take(32769).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 32768, "Protection response too large");
    Ok(serde_json::from_slice(&bytes)?)
}
fn lock() -> Result<std::fs::File> {
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(format!("{STATE}/lock"))?;
    f.try_lock_exclusive()
        .context("Protection worker already running")?;
    Ok(f)
}
pub fn configure(panel: &str) -> Result<()> {
    io::root()?;
    let _lock = lock()?;
    let mut token = String::new();
    std::io::stdin().take(128).read_to_string(&mut token)?;
    let token = token.trim();
    ensure!(
        crate::config::token(token),
        "Invalid protection enrollment token"
    );
    let origin = crate::config::panel_url(panel)?
        .origin()
        .ascii_serialization();
    let mut identity = if identity_path().exists() {
        let old = Config::load(identity_path())?;
        ensure!(
            old.panel == origin,
            "Protection identity belongs to another panel"
        );
        if old.machine_id.is_none() {
            old
        } else {
            let fresh = Config::new(panel)?;
            fresh.save(identity_path(), false)?;
            fresh
        }
    } else {
        let fresh = Config::new(panel)?;
        fresh.save(identity_path(), true)?;
        fresh
    };
    let response = crate::client()?
        .post(format!("{}/api/agent/protections/enroll", identity.panel))
        .bearer_auth(token)
        .json(&json!({"credential":identity.credential}))
        .send()
        .map_err(|_| {
            anyhow::anyhow!("Protection enrollment unavailable; retry the same command")
        })?;
    ensure!(
        response.status().is_success(),
        "Protection enrollment rejected; generate a new command"
    );
    let mut bytes = Vec::new();
    response.take(4097).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 4096, "Enrollment response too large");
    let v: Value = serde_json::from_slice(&bytes)?;
    let id = v["id"].as_str().context("Missing machine identity")?;
    ensure!(uuid(id), "Invalid machine identity");
    identity.machine_id = Some(id.into());
    identity.save(identity_path(), false)?;
    if !state_path().exists() {
        io::save(state_path(), &State::default())?;
    }
    fs::create_dir_all(format!("{STATE}/receipts"))?;
    println!(
        "Protection management enrolled; CrowdSec installation requires approval in the panel."
    );
    Ok(())
}
fn reset_state(state: &mut State) -> Result<()> {
    state.blocking = false;
    state.confirm_before = None;
    state.trial_started = None;
    io::save(state_path(), state)?;
    if state.firewall_owned {
        firewall::clear()?;
        state.firewall_owned = false;
        io::save(state_path(), state)?;
    }
    Ok(())
}
pub fn reset() -> Result<()> {
    io::root()?;
    let _lock = lock()?;
    let mut state: State = io::load(state_path())?;
    reset_state(&mut state)
}
fn validate(job: &Job, identity: &Config, state: &State) -> Result<()> {
    ensure!(
        uuid(&job.id) && identity.machine_id.as_deref() == Some(job.machine_id.as_str()),
        "Job machine identity mismatch"
    );
    ensure!(
        job.status == "running"
            && job.result.is_none()
            && job.created_at <= now() + 30_000
            && job.expires_at > now()
            && job.expires_at <= now() + 15 * 60_000,
        "Job authorization expired or invalid"
    );
    ensure!(
        job.revision == revision(state),
        "Machine configuration changed; review a new plan"
    );
    if job.action.starts_with("updates.") {
        ensure!(
            job.parameters.ip.is_none() && job.parameters.trusted_ips.is_empty(),
            "Unexpected update parameters"
        );
        return updates::validate(job);
    }
    ensure!(job.parameters.policy.is_none(), "Unexpected update policy");
    ensure!(
        [
            "install",
            "repair",
            "update",
            "enable",
            "confirm",
            "disable",
            "unblock",
            "uninstall"
        ]
        .contains(&job.action.as_str()),
        "Unsupported protection action"
    );
    ensure!(
        job.parameters.trusted_ips.len() <= 16
            && (job.action == "enable" || job.parameters.trusted_ips.is_empty())
            && (job.action == "unblock" || job.parameters.ip.is_none()),
        "Unexpected protection parameters"
    );
    ensure!(
        !engine::external() && engine::supported(),
        "Existing external CrowdSec or unsupported host"
    );
    ensure!(
        if job.action == "install" {
            !state.managed
        } else {
            state.managed
        },
        "Protection installation state changed"
    );
    Ok(())
}
fn execute(job: &Job, state: &mut State) -> Result<()> {
    if job.action.starts_with("updates.") {
        return updates::execute(job);
    }
    match job.action.as_str() {
        "install" | "repair" | "update" => {
            reset_state(state)?;
            state.managed = true;
            io::save(state_path(), state)?;
            engine::install()?;
        }
        "enable" => {
            ensure!(
                !state.blocking
                    && engine::running()
                    && engine::intact()
                    && engine::acquisition_ready(),
                "SSH detection is not ready"
            );
            let ports = engine::ports();
            firewall::validate_ports(&ports)?;
            ensure!(
                !job.parameters.trusted_ips.is_empty(),
                "Trusted administrator IP required"
            );
            // Preserve earlier trusted addresses until an administrator edits the private local policy.
            for ip in &job.parameters.trusted_ips {
                if !state.trusted_ips.contains(ip) {
                    state.trusted_ips.push(*ip);
                }
            }
            ensure!(
                state.trusted_ips.len() <= 32,
                "Too many trusted addresses; review the local policy"
            );
            ensure!(
                state.firewall_owned || !firewall::exists(),
                "Reserved firewall table exists but is not owned by Ephor"
            );
            state.firewall_owned = true;
            state.blocking = true;
            state.confirm_before = Some(now() + 120_000);
            state.trial_started = Some(Instant::now());
            io::save(state_path(), state)?;
        }
        "confirm" => {
            ensure!(
                state.blocking
                    && state.confirm_before.is_some_and(|t| t > now())
                    && state
                        .trial_started
                        .is_some_and(|t| t.elapsed() < Duration::from_secs(120)),
                "Blocking trial expired"
            );
            state.confirm_before = None;
            state.trial_started = None;
            io::save(state_path(), state)?;
        }
        "disable" => reset_state(state)?,
        "unblock" => {
            let ip = job.parameters.ip.context("Missing unblock address")?;
            ensure!(
                state.exemptions.len() < 100 || state.exemptions.contains_key(&ip),
                "Temporary exemption limit reached"
            );
            state.exemptions.insert(ip, now() + 3_600_000);
            io::save(state_path(), state)?;
            if state.firewall_owned {
                firewall::clear()?;
            }
        }
        "uninstall" => {
            reset_state(state)?;
            engine::uninstall()?;
            state.managed = false;
            io::save(state_path(), state)?;
        }
        _ => anyhow::bail!("Unsupported action"),
    }
    Ok(())
}
fn handle(job: Job, identity: &Config, state: &mut State) -> Result<()> {
    ensure!(uuid(&job.id), "Invalid job ID");
    let path = Path::new(STATE).join("receipts").join(&job.id);
    if path.exists() {
        // A receipt is written BEFORE any effect. Interrupted jobs are never executed twice.
        let mut receipt: Receipt = io::load(&path)?;
        if receipt.status == "pending" {
            let Some(result) = updates::outcome(&job.id) else {
                return Ok(());
            };
            receipt.status = if result.is_ok() {
                "completed"
            } else {
                "failed"
            }
            .into();
            receipt.result = result.err().map_or_else(
                || "Update policy applied. Review the current protection status.".into(),
                |e| e.to_string().chars().take(500).collect(),
            );
            io::save(&path, &receipt)?;
        }
        if receipt.status == "started" {
            receipt.status = "failed".into();
            receipt.result =
                "Interrupted operation; inspect status and create a new repair plan.".into();
            io::save(&path, &receipt)?;
        }
        post(identity, "report", &receipt)?;
        return Ok(());
    }
    let mut receipt = Receipt {
        id: job.id.clone(),
        status: "started".into(),
        result: String::new(),
    };
    io::save(&path, &receipt)?;
    let result = validate(&job, identity, state).and_then(|()| execute(&job, state));
    if result.is_ok() && job.action.starts_with("updates.") {
        receipt.status = "pending".into();
        io::save(&path, &receipt)?;
        return Ok(());
    }
    receipt.status = if result.is_ok() {
        "completed"
    } else {
        "failed"
    }
    .into();
    receipt.result = match result {
        Ok(()) => "Requested action completed. Review the current protection status.".into(),
        Err(e) => {
            if !job.action.starts_with("updates.") {
                let _ = reset_state(state);
            }
            format!("{e:#}").chars().take(500).collect()
        }
    };
    io::save(&path, &receipt)?;
    post(identity, "report", &receipt)?;
    Ok(())
}
pub fn run() -> Result<()> {
    io::root()?;
    let _lock = lock()?;
    let identity = Config::load(identity_path())?;
    ensure!(
        identity.machine_id.is_some(),
        "Protection enrollment incomplete"
    );
    let mut state: State = io::load(state_path())?;
    // Restarts and reboots require explicit re-enablement; never resurrect an old trial or bans.
    reset_state(&mut state)?;
    let mut last_contact: Option<Instant> = None;
    let mut detail = String::new();
    loop {
        let expired = state.confirm_before.is_some_and(|t| {
            t <= now()
                || state
                    .trial_started
                    .is_none_or(|s| s.elapsed() >= Duration::from_secs(120))
        });
        if state.blocking
            && (expired
                || last_contact.is_none_or(|t| t.elapsed() > Duration::from_secs(90))
                || !engine::intact()
                || !engine::running()
                || engine::external())
        {
            let _ = reset_state(&mut state);
            detail="Blocking paused: trial expired, connection lost, or detection/configuration unhealthy.".into();
        }
        state.exemptions.retain(|_, until| *until > now());
        let mut bans = if state.managed && engine::running() {
            match engine::decisions() {
                Ok(bans) => bans,
                Err(_) => {
                    let _ = reset_state(&mut state);
                    detail = "Blocking paused: CrowdSec decisions are unavailable.".into();
                    vec![]
                }
            }
        } else {
            vec![]
        };
        bans.retain(|b| {
            !state.exemptions.contains_key(&b.ip)
                && !state.trusted_ips.contains(&b.ip)
                && firewall::public(b.ip)
        });
        // Recheck deadlines after subprocess/network work; kernel timeouts also cover a stuck helper.
        let trial_seconds = state
            .confirm_before
            .map_or(60, |t| t.saturating_sub(now()) / 1000);
        let contact_seconds =
            last_contact.map_or(0, |t| 90u64.saturating_sub(t.elapsed().as_secs()));
        let monotonic_trial_seconds = if state.confirm_before.is_some() {
            state
                .trial_started
                .map_or(0, |s| 120u64.saturating_sub(s.elapsed().as_secs()))
        } else {
            60
        };
        let lease = trial_seconds
            .min(monotonic_trial_seconds)
            .min(contact_seconds)
            .min(60);
        if state.blocking && lease == 0 {
            let _ = reset_state(&mut state);
        }
        for ban in &mut bans {
            if state.blocking {
                ban.remaining_seconds = ban.remaining_seconds.min(lease);
            }
        }
        if state.blocking && firewall::apply(&engine::ports(), &state.trusted_ips, &bans).is_err() {
            let _ = reset_state(&mut state);
            detail = "Blocking paused because firewall verification failed.".into();
        }
        let observation = snapshot(&state, &detail, &bans);
        match post(&identity, "next", &json!({"snapshot":observation})) {
            Ok(response) => {
                last_contact = Some(Instant::now());
                let _ = updates::contact();
                if !response["job"].is_null() {
                    match serde_json::from_value::<Job>(response["job"].clone()) {
                        Ok(job) => {
                            if let Err(e) = handle(job, &identity, &mut state) {
                                eprintln!("Protection job: {e}");
                            }
                        }
                        Err(_) => eprintln!("Rejected invalid protection job"),
                    }
                }
            }
            Err(error) => {
                if error.to_string() == "PROTECTION_CREDENTIAL_REVOKED" {
                    let _ = reset_state(&mut state);
                    eprintln!(
                        "Protection credential revoked. Management stopped; detection remains installed."
                    );
                    std::process::exit(77);
                }
                eprintln!("Protection panel unavailable; local blocking lease will expire.");
            }
        }
        thread::sleep(Duration::from_secs(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_envelopes_and_ids() {
        assert!(!uuid("../../etc/passwd"));
        assert!(!uuid("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(uuid("12345678-1234-1234-1234-123456789abc"));
        assert!(serde_json::from_value::<Parameters>(json!({"command":"reboot"})).is_err());
        assert!(
            serde_json::from_value::<Parameters>(json!({"trustedIPs":["1.1.1.1;reboot"]})).is_err()
        );
    }
    #[test]
    #[ignore = "disposable privileged Debian container only"]
    fn linux_crowdsec_lifecycle() {
        io::root().unwrap();
        let _lock = lock().unwrap();
        fs::create_dir_all(format!("{STATE}/receipts")).unwrap();
        let mut state = State {
            managed: true,
            ..State::default()
        };
        io::save(state_path(), &state).unwrap();
        if let Err(e) = engine::install() {
            eprintln!("Installation failed: {e:#}");
            eprintln!(
                "engine log: {}",
                fs::read_to_string("/tmp/crowdsec.log").unwrap_or_default()
            );
            panic!("Real CrowdSec installation failed");
        }
        assert!(engine::running());
        assert!(engine::intact());
        eprintln!(
            "Collection: {}",
            engine::cscli(&["collections", "inspect", "crowdsecurity/sshd", "-o", "json"]).unwrap()
        );
        assert!(engine::decisions().unwrap().is_empty());
        engine::cscli(&[
            "decisions",
            "add",
            "--ip",
            "1.1.1.1",
            "--duration",
            "10m",
            "--reason",
            "crowdsecurity/ssh-bf",
        ])
        .unwrap();
        eprintln!(
            "Decisions: {}",
            engine::cscli(&["decisions", "list", "-o", "json"]).unwrap()
        );
        // Manual origin decisions must not be enforced by the restricted adapter.
        assert!(engine::decisions().unwrap().is_empty());
        let stamp = chrono::DateTime::<chrono::Utc>::from_timestamp((now() / 1000) as i64, 0)
            .unwrap()
            .format("%b %e %H:%M:%S")
            .to_string();
        let log = (0..12).map(|_| format!("{stamp} test sshd[1234]: Failed password for invalid user admin from 9.9.9.9 port 45678 ssh2\n")).collect::<String>();
        io::write(
            Path::new(STATE).join("ssh-fixture.log").as_path(),
            log.as_bytes(),
        )
        .unwrap();
        let output = io::command(
            &format!("{STATE}/runtime/usr/bin/crowdsec"),
            &[
                "-c",
                &format!("{}/config.yaml", engine::ENGINE),
                "-no-api",
                "-dsn",
                &format!("file://{STATE}/ssh-fixture.log"),
                "-type",
                "syslog",
                "-info",
            ],
            60,
        )
        .unwrap();
        eprintln!("SSH replay: {output}");
        assert!(
            engine::decisions()
                .unwrap()
                .iter()
                .any(|b| b.ip.to_string() == "9.9.9.9"),
            "Real SSH fixture must produce an eligible decision"
        );
        let bans = [firewall::Ban {
            ip: "1.1.1.1".parse().unwrap(),
            reason: "crowdsecurity/ssh-bf".into(),
            remaining_seconds: 600,
        }];
        firewall::apply(&[22], &["8.8.8.8".parse().unwrap()], &bans).unwrap();
        let rules = io::command(
            "/usr/sbin/nft",
            &["list", "table", "inet", "ephor_crowdsec"],
            5,
        )
        .unwrap();
        assert!(rules.contains("1.1.1.1") && rules.contains("expires"));
        assert!(!rules.contains("hook forward"));
        // Exercise packets, not only generated rule text, inside this isolated network namespace.
        io::command(
            "/usr/sbin/ip",
            &["addr", "add", "1.1.1.1/32", "dev", "lo"],
            5,
        )
        .unwrap();
        io::command(
            "/usr/sbin/ip",
            &["addr", "add", "8.8.8.8/32", "dev", "lo"],
            5,
        )
        .unwrap();
        let network_test = r#"import socket
listeners=[]
for port in (22,80,443):
 s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',port)); s.listen(5); listeners.append(s)
def connects(ip,port):
 s=socket.socket(); s.settimeout(.5); s.bind((ip,0))
 try: s.connect(('127.0.0.1',port)); return True
 except TimeoutError: return False
 finally: s.close()
assert not connects('1.1.1.1',22), 'SSH attack address must be blocked'
assert connects('1.1.1.1',80), 'Public HTTP must remain accessible'
assert connects('1.1.1.1',443), 'Public HTTPS must remain accessible'
assert connects('8.8.8.8',22), 'Administrator SSH must remain accessible'
"#;
        io::write(
            Path::new(STATE).join("network-test.py").as_path(),
            network_test.as_bytes(),
        )
        .unwrap();
        io::command(
            "/usr/bin/python3",
            &[&format!("{STATE}/network-test.py")],
            10,
        )
        .unwrap();
        let short_ban = [firewall::Ban {
            ip: "1.1.1.1".parse().unwrap(),
            reason: "test".into(),
            remaining_seconds: 1,
        }];
        firewall::apply(&[22], &["8.8.8.8".parse().unwrap()], &short_ban).unwrap();
        thread::sleep(Duration::from_secs(2));
        let expired = io::command(
            "/usr/sbin/nft",
            &["list", "set", "inet", "ephor_crowdsec", "blocked4"],
            5,
        )
        .unwrap();
        assert!(
            !expired.contains("1.1.1.1"),
            "Kernel must expire entries without a helper refresh"
        );
        reset_state(&mut state).unwrap();
        assert!(
            firewall::exists(),
            "Reset must preserve a table without an ownership receipt"
        );
        state.firewall_owned = true;
        reset_state(&mut state).unwrap();
        assert!(!state.firewall_owned);
        assert!(!firewall::exists());
        let identity = Config {
            panel: "https://example.com".into(),
            credential: "a".repeat(64),
            machine_id: Some("12345678-1234-1234-1234-123456789abc".into()),
        };
        let mut job = Job {
            id: "12345678-1234-1234-1234-123456789abd".into(),
            machine_id: identity.machine_id.clone().unwrap(),
            action: "disable".into(),
            parameters: Parameters {
                policy: None,
                trusted_ips: vec![],
                ip: None,
            },
            revision: revision(&state),
            expires_at: now() + 60000,
            created_at: now(),
            status: "running".into(),
            result: None,
        };
        assert!(validate(&job, &identity, &state).is_ok());
        job.expires_at = now() - 1;
        assert!(validate(&job, &identity, &state).is_err());
        job.expires_at = now() + 60000;
        job.machine_id = "12345678-1234-1234-1234-123456789abe".into();
        assert!(validate(&job, &identity, &state).is_err());
        job.machine_id = identity.machine_id.clone().unwrap();
        job.revision = "b".repeat(64);
        assert!(validate(&job, &identity, &state).is_err());
        state.blocking = true;
        state.confirm_before = Some(now() - 1);
        job.action = "confirm".into();
        assert!(execute(&job, &mut state).is_err());
        reset_state(&mut state).unwrap();
        // Real HTTP receipt reporting; duplicate and interrupted deliveries cannot rerun effects.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            use std::io::Write;
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = [0u8; 8192];
                let _ = stream.read(&mut bytes).unwrap();
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").unwrap();
            }
        });
        let test_identity = Config {
            panel: format!("http://localhost:{port}"),
            credential: identity.credential.clone(),
            machine_id: identity.machine_id.clone(),
        };
        let make_job = |state: &State| Job {
            id: "12345678-1234-1234-1234-123456789abf".into(),
            machine_id: identity.machine_id.clone().unwrap(),
            action: "disable".into(),
            parameters: Parameters {
                policy: None,
                trusted_ips: vec![],
                ip: None,
            },
            revision: revision(state),
            expires_at: now() + 60000,
            created_at: now(),
            status: "running".into(),
            result: None,
        };
        handle(make_job(&state), &test_identity, &mut state).unwrap();
        state.blocking = true;
        handle(make_job(&state), &test_identity, &mut state).unwrap();
        assert!(
            state.blocking,
            "A duplicate delivery must not execute disable again"
        );
        let mut interrupted = make_job(&state);
        interrupted.id = "12345678-1234-1234-1234-123456789ab0".into();
        interrupted.action = "uninstall".into();
        let receipt_path = Path::new(STATE).join("receipts").join(&interrupted.id);
        io::save(
            &receipt_path,
            &Receipt {
                id: interrupted.id.clone(),
                status: "started".into(),
                result: String::new(),
            },
        )
        .unwrap();
        handle(interrupted, &test_identity, &mut state).unwrap();
        assert!(
            engine::running(),
            "Interrupted uninstall must not be replayed"
        );
        assert_eq!(io::load::<Receipt>(&receipt_path).unwrap().status, "failed");
        server.join().unwrap();
        reset_state(&mut state).unwrap();
        engine::uninstall().unwrap();
        assert!(!engine::running());
        assert!(Path::new(engine::ENGINE).join("data/crowdsec.db").exists());
    }
}
