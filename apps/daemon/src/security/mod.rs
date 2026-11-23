//! Fixed-purpose, separately enrolled security collector. No panel-supplied commands or paths.
mod host;
mod images;
mod journal;
mod updates;

use crate::config::{self, Config};
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const STATE: &str = "/var/lib/ephor-security";
const IDENTITY: &str = "/var/lib/ephor-security/identity.json";
const TRIVY: &str = "/usr/local/libexec/ephor-trivy";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    id: String,
    service_id: Option<String>,
    revision: Option<String>,
    force: bool,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn clean(value: &str, max: usize) -> String {
    // Match the API's JavaScript string-length limit, including supplementary Unicode characters.
    let mut result = String::new();
    let mut length = 0;
    for c in value
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
    {
        length += c.len_utf16();
        if length > max {
            break;
        }
        result.push(c);
    }
    result
}
fn uuid(value: &str) -> bool {
    value.len() == 36 && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}
fn root_directory() -> Result<()> {
    ensure!(
        Command::new("/usr/bin/id").arg("-u").output()?.stdout == b"0\n",
        "Security helper requires root"
    );
    if !Path::new(STATE).exists() {
        fs::create_dir(STATE)?;
        fs::set_permissions(STATE, fs::Permissions::from_mode(0o700))?;
    }
    let m = fs::symlink_metadata(STATE)?;
    ensure!(
        m.is_dir()
            && !m.file_type().is_symlink()
            && m.uid() == 0
            && m.permissions().mode() & 0o077 == 0,
        "Unsafe security state directory"
    );
    Ok(())
}
fn read_state<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let m = fs::symlink_metadata(path)?;
    ensure!(
        m.is_file() && m.uid() == 0 && m.permissions().mode() & 0o077 == 0 && m.len() <= 4_000_000,
        "Unsafe security state"
    );
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn write_state(path: &Path, value: &impl Serialize) -> Result<()> {
    let tmp = path.with_extension("new");
    if let Ok(m) = fs::symlink_metadata(&tmp) {
        // A crash can leave incomplete JSON. Check ownership/type, not contents, before retrying.
        ensure!(
            m.is_file() && m.uid() == 0 && m.permissions().mode() & 0o077 == 0,
            "Unsafe temporary security state"
        );
        fs::remove_file(&tmp)?;
    }
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(&serde_json::to_vec(value)?)?;
    f.sync_all()?;
    fs::rename(&tmp, path)?;
    File::open(path.parent().context("Missing state parent")?)?.sync_all()?;
    Ok(())
}
// Fixed executable paths, cleared environment, bounded output, and process-group timeout.
fn command(path: &str, args: &[&str], seconds: u64, limit: usize) -> Result<String> {
    let mut child = Command::new(path)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LC_ALL", "C")
        .env("HOME", STATE)
        .env("DOCKER_HOST", "unix:///var/run/docker.sock")
        .current_dir(STATE)
        .process_group(0)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .context("Check tool unavailable")?;
    let mut stdout = child.stdout.take().context("Missing check output")?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut exceeded = false;
        let mut buffer = [0u8; 8192];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if bytes.len() + n > limit {
                        exceeded = true;
                    }
                    if !exceeded {
                        bytes.extend_from_slice(&buffer[..n]);
                    }
                }
            }
        }
        (bytes, exceeded)
    });
    let start = Instant::now();
    let success = loop {
        if let Some(status) = child.try_wait()? {
            break status.success();
        }
        if start.elapsed() > Duration::from_secs(seconds) {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{}", child.id())])
                .status();
            let _ = child.kill();
            let _ = child.wait();
            break false;
        }
        thread::sleep(Duration::from_millis(50));
    };
    let (bytes, exceeded) = reader
        .join()
        .map_err(|_| anyhow::anyhow!("Check output unavailable"))?;
    ensure!(
        success && !exceeded,
        "Check failed, timed out, or exceeded its output limit"
    );
    Ok(String::from_utf8_lossy(&bytes).trim().to_string())
}
// Keep declarative check definitions readable at call sites.
#[allow(clippy::too_many_arguments)]
fn check(
    key: &str,
    title: &str,
    status: &str,
    category: &str,
    severity: &str,
    evidence: &str,
    remediation: &str,
    component: &str,
) -> Value {
    json!({"key":key,"title":title,"status":status,"category":category,"severity":severity,"component":clean(component,128),"evidence":clean(evidence,2000),"remediation":clean(remediation,1000)})
}
fn blank_result() -> Value {
    json!({"checks":[],"vulnerabilities":[],"vulnerabilitiesComplete":false,"scanner":null,"inventory":{"os":"","ports":[],"firewalls":[],"protections":[],"containers":[]}})
}

fn post(
    client: &reqwest::blocking::Client,
    identity: &Config,
    path: &str,
    body: &Value,
) -> Result<Value> {
    let response = client
        .post(format!("{}/api/agent/security/{path}", identity.panel))
        .bearer_auth(&identity.credential)
        .json(body)
        .send()
        .map_err(|_| anyhow::anyhow!("Security panel unavailable"))?;
    if matches!(response.status().as_u16(), 401 | 403) {
        eprintln!("Security credential revoked or rejected.");
        std::process::exit(77);
    }
    ensure!(
        response.status().is_success(),
        "Security report rejected (HTTP {})",
        response.status().as_u16()
    );
    let mut bytes = Vec::new();
    response.take(65537).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 65536, "Security response too large");
    serde_json::from_slice(&bytes).context("Invalid security response")
}
pub fn configure(panel: &str) -> Result<()> {
    root_directory()?;
    config::panel_url(panel)?;
    let mut token = String::new();
    std::io::stdin().take(128).read_to_string(&mut token)?;
    let token = token.trim();
    ensure!(
        config::token(token),
        "Expected an enrollment token on stdin"
    );
    let path = Path::new(IDENTITY);
    if path.exists() {
        let previous = read_state::<Config>(path)?;
        ensure!(
            previous.panel == config::panel_url(panel)?.origin().ascii_serialization(),
            "Security identity belongs to another panel"
        );
    }
    #[derive(Serialize, Deserialize)]
    struct Enrollment {
        ticket_hash: String,
        identity: Config,
    }
    let ticket_hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    let enrollment_path = Path::new(STATE).join("enrollment.json");
    let saved = if enrollment_path.exists() {
        Some(read_state::<Enrollment>(&enrollment_path)?)
    } else {
        None
    };
    let mut enrollment = match saved {
        Some(saved) if saved.ticket_hash == ticket_hash => saved,
        _ => Enrollment {
            ticket_hash,
            identity: Config::new(panel)?,
        },
    };
    let identity = &mut enrollment.identity;
    ensure!(
        identity.panel == config::panel_url(panel)?.origin().ascii_serialization(),
        "Security identity belongs to another panel"
    );
    write_state(&enrollment_path, &enrollment)?;
    let identity = &mut enrollment.identity;
    let client = crate::client()?;
    let response = client
        .post(format!("{}/api/agent/security/enroll", identity.panel))
        .bearer_auth(token)
        .json(&json!({"credential":identity.credential}))
        .send()
        .map_err(|_| anyhow::anyhow!("Security enrollment unavailable; retry the same command"))?;
    ensure!(
        response.status().is_success(),
        "Security enrollment rejected"
    );
    let mut bytes = Vec::new();
    response.take(4097).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 4096, "Invalid enrollment response");
    let data: Value = serde_json::from_slice(&bytes)?;
    let id = data["id"].as_str().context("Missing machine identity")?;
    ensure!(uuid(id), "Invalid machine identity");
    identity.machine_id = Some(id.to_string());
    write_state(path, identity)?;
    write_state(&enrollment_path, &enrollment)?;
    Ok(())
}
fn pending_path() -> PathBuf {
    Path::new(STATE).join("report.json")
}
fn flush_report(
    client: &reqwest::blocking::Client,
    identity: &Config,
    report: &Value,
) -> Result<()> {
    // Small resumable batches keep each API request within D1's query budget.
    for _ in 0..400 {
        let response = client
            .post(format!("{}/api/agent/security/report", identity.panel))
            .bearer_auth(&identity.credential)
            .json(report)
            .send()
            .map_err(|_| anyhow::anyhow!("Security panel unavailable"))?;
        match response.status().as_u16() {
            401 | 403 => std::process::exit(77),
            404 | 409 => return Ok(()),
            200 => {}
            _ => anyhow::bail!("Buffered security report not accepted"),
        }
        let mut bytes = Vec::new();
        response.take(4097).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 4096, "Security acknowledgement too large");
        let data: Value = serde_json::from_slice(&bytes)?;
        if data["pending"] != true {
            return Ok(());
        }
    }
    anyhow::bail!("Security ingestion has not completed")
}
pub fn run() -> Result<()> {
    root_directory()?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(Path::new(STATE).join("worker.lock"))?;
    lock.try_lock_exclusive()
        .context("Security worker already running")?;
    let identity: Config = read_state(Path::new(IDENTITY))?;
    ensure!(
        identity.machine_id.as_deref().is_some_and(uuid),
        "Security enrollment incomplete"
    );
    config::panel_url(&identity.panel)?;
    ensure!(
        config::token(&identity.credential),
        "Invalid security credential"
    );
    let client = crate::client()?;
    loop {
        let attempt = (|| -> Result<()> {
            if pending_path().exists() {
                let pending: Value = read_state(&pending_path())?;
                // Reports remain buffered across panel outages. An expired lease is a visible failed scan.
                flush_report(&client, &identity, &pending)?;
                fs::remove_file(pending_path())?;
            }
            journal::collect_and_send(&client, &identity)?;
            let data = post(
                &client,
                &identity,
                "next",
                &json!({"version":env!("CARGO_PKG_VERSION")}),
            )?;
            if data["job"].is_null() {
                return Ok(());
            }
            let job: Job = serde_json::from_value(data["job"].clone())?;
            ensure!(
                uuid(&job.id) && job.service_id.as_deref().is_none_or(uuid),
                "Invalid security job"
            );
            let result = if let Some(sid) = &job.service_id {
                images::scan_service(sid, job.force)
            } else {
                host::scan_host()
            };
            let report = match result {
                Ok(value) => json!({"id":job.id,"status":"completed","result":value}),
                Err(_) => json!({"id":job.id,"status":"failed","error":"CHECK_FAILED"}),
            };
            let report = if serde_json::to_vec(&report)?.len() > 500_000 {
                json!({"id":job.id,"status":"failed","error":"REPORT_LIMIT_EXCEEDED"})
            } else {
                report
            };
            write_state(&pending_path(), &report)?;
            flush_report(&client, &identity, &report)?;
            fs::remove_file(pending_path())?;
            Ok(())
        })();
        if attempt.is_err() {
            eprintln!("Security collection incomplete; retrying. Existing findings are retained.");
        }
        thread::sleep(Duration::from_secs(30));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_are_not_command_arguments() {
        assert!(!uuid("--help"));
        assert!(!uuid("../etc/shadow"));
        assert!(uuid("e5906638-bcc6-4afb-9118-d343c9462c42"));
    }
    #[test]
    fn redacts_control_characters_and_bounds_text() {
        assert_eq!(clean("abc\0\u{1b}def", 4), "abcd");
    }
}
