use super::{STATE, firewall::Ban, io};
use anyhow::{Context, Result, ensure};
use reqwest::{blocking::Client, redirect::Policy};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, net::IpAddr, path::Path, time::Duration};
pub const VERSION: &str = "1.8.2";
pub const ENGINE: &str = "/var/lib/ephor-protections/engine";
const CONFIG: &str = "/var/lib/ephor-protections/engine/config.yaml";
const CLI: &str = "/var/lib/ephor-protections/runtime/usr/bin/cscli";
pub fn cscli(args: &[&str]) -> Result<String> {
    let mut a = vec!["-c", CONFIG];
    a.extend_from_slice(args);
    io::command(CLI, &a, 120)
}
pub fn external() -> bool {
    Path::new("/etc/crowdsec").exists()
        || Path::new("/usr/bin/crowdsec").exists()
        || Path::new("/usr/local/bin/crowdsec").exists()
}
pub fn supported() -> bool {
    let os = fs::read_to_string("/etc/os-release").unwrap_or_default();
    os.lines().any(|l| {
        matches!(
            l,
            "ID=debian" | "ID=ubuntu" | "ID=\"debian\"" | "ID=\"ubuntu\""
        )
    }) && Path::new("/usr/bin/dpkg-deb").exists()
        && Path::new("/usr/sbin/nft").exists()
        && Path::new("/usr/sbin/sshd").exists()
}
pub fn running() -> bool {
    io::command(
        "/usr/bin/systemctl",
        &["is-active", "--quiet", "ephor-crowdsec.service"],
        5,
    )
    .is_ok()
}
pub fn service(action: &str) -> Result<()> {
    ensure!(
        ["start", "stop", "restart", "enable", "disable"].contains(&action),
        "Unsupported service action"
    );
    io::command(
        "/usr/bin/systemctl",
        &[action, "ephor-crowdsec.service"],
        30,
    )?;
    Ok(())
}
pub fn ports() -> Vec<u16> {
    let Ok(output) = io::command("/usr/sbin/sshd", &["-T"], 5) else {
        return vec![];
    };
    let mut ports = output
        .lines()
        .filter_map(|l| l.strip_prefix("port ")?.parse().ok())
        .collect::<Vec<_>>();
    ports.sort();
    ports.dedup();
    ports
}
pub fn acquisition_ready() -> bool {
    // Verify the journal source exists and the SSH collection is enabled, without exporting log text.
    let logs = io::command(
        "/usr/bin/journalctl",
        &[
            "--no-pager",
            "-n",
            "1",
            "-o",
            "json",
            "_COMM=sshd",
            "+",
            "_COMM=sshd-session",
        ],
        5,
    )
    .unwrap_or_default();
    let collection =
        cscli(&["collections", "inspect", "crowdsecurity/sshd", "-o", "json"]).unwrap_or_default();
    !logs.is_empty()
        && serde_json::from_str::<Value>(&collection)
            .ok()
            .is_some_and(|v| {
                v.get("installed").and_then(Value::as_bool) == Some(true)
                    && v.get("tainted").and_then(Value::as_bool) == Some(false)
            })
        && running()
}
pub fn config() -> String {
    format!(
        r#"common:
  daemonize: false
  log_media: stdout
  log_level: warning
config_paths:
  config_dir: {ENGINE}
  data_dir: {ENGINE}/data
  simulation_path: {ENGINE}/simulation.yaml
  hub_dir: {ENGINE}/hub
  index_path: {ENGINE}/hub/.index.json
  notification_dir: {ENGINE}/notifications
  plugin_dir: {ENGINE}/plugins
crowdsec_service:
  acquisition_path: {ENGINE}/acquis.yaml
  parser_routines: 1
cscli:
  output: json
  color: never
db_config:
  type: sqlite
  db_path: {ENGINE}/data/crowdsec.db
  flush:
    max_items: 5000
    max_age: 7d
api:
  client:
    credentials_path: {ENGINE}/local_api_credentials.yaml
  server:
    listen_uri: 127.0.0.1:18765
    profiles_path: {ENGINE}/profiles.yaml
    console_path: {ENGINE}/console.yaml
prometheus:
  enabled: false
"#
    )
}
pub const ACQUIS: &str = "source: journalctl\njournalctl_filter:\n  - _COMM=sshd\n  - \"+\"\n  - _COMM=sshd-session\nlabels:\n  type: syslog\n";
pub const PROFILES: &str = "name: ephor_ssh\nfilters:\n  - Alert.Remediation == true && Alert.GetScope() == \"Ip\" && Alert.GetScenario() startsWith \"crowdsecurity/ssh-\"\ndecisions:\n  - type: ban\n    duration: 10m\non_success: break\n";
pub fn intact() -> bool {
    fs::read_to_string(CONFIG).ok().as_deref() == Some(config().as_str())
        && fs::read_to_string(format!("{ENGINE}/acquis.yaml"))
            .ok()
            .as_deref()
            == Some(ACQUIS)
        && fs::read_to_string(format!("{ENGINE}/profiles.yaml"))
            .ok()
            .as_deref()
            == Some(PROFILES)
}
pub fn install() -> Result<()> {
    ensure!(
        supported() && !external(),
        "Unsupported host or externally managed CrowdSec"
    );
    let (arch, digest) = match std::env::consts::ARCH {
        "x86_64" => (
            "amd64",
            "d534ad21e6eed3d82a8fd748fa19f34970e95bfccd99735c0ebebcbad1e6366e",
        ),
        "aarch64" => (
            "arm64",
            "3e52ed0c072806da0b986a5f1bbee9d2b109bb847d72633de86193e602da21d8",
        ),
        _ => anyhow::bail!("Unsupported architecture"),
    };
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::custom(|a| {
            if a.url().scheme() != "https" || a.previous().len() >= 5 {
                a.stop()
            } else {
                a.follow()
            }
        }))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .build()?;
    let url = format!(
        "https://packagecloud.io/crowdsec/crowdsec/any/pool/any/main/c/crowdsec/crowdsec_{VERSION}_{arch}.deb"
    );
    let response = client
        .get(url)
        .send()
        .map_err(|_| anyhow::anyhow!("CrowdSec download failed"))?;
    ensure!(response.status().is_success(), "CrowdSec download rejected");
    let mut bytes = Vec::new();
    response.take(100_000_001).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 100_000_000 && format!("{:x}", Sha256::digest(&bytes)) == digest,
        "CrowdSec package checksum mismatch"
    );
    io::write(Path::new(STATE).join("crowdsec.deb").as_path(), &bytes)?;
    let stage = Path::new(STATE).join("stage");
    if stage.exists() {
        fs::remove_dir_all(&stage)?;
    }
    io::command(
        "/usr/bin/dpkg-deb",
        &[
            "--extract",
            &format!("{STATE}/crowdsec.deb"),
            stage.to_str().unwrap(),
        ],
        60,
    )?;
    // Extract only: no package maintainer scripts or system-wide CrowdSec service/configuration.
    let _ = service("stop");
    let runtime = Path::new(STATE).join("runtime");
    if runtime.exists() {
        fs::remove_dir_all(&runtime)?;
    }
    fs::rename(stage, &runtime)?;
    for dir in [
        "",
        "/data",
        "/hub",
        "/notifications",
        "/plugins",
        "/collections",
        "/scenarios",
        "/parsers/s00-raw",
        "/parsers/s01-parse",
        "/parsers/s02-enrich",
        "/postoverflows/s00-enrich",
        "/postoverflows/s01-whitelist",
    ] {
        fs::create_dir_all(format!("{ENGINE}{dir}"))?;
    }
    io::command(
        "/bin/cp",
        &[
            "-R",
            &format!("{STATE}/runtime/etc/crowdsec/patterns"),
            ENGINE,
        ],
        30,
    )?;
    for (name,value) in [("config.yaml",config()),("acquis.yaml",ACQUIS.into()),("profiles.yaml",PROFILES.into()),("simulation.yaml","simulation: false\n".into()),("console.yaml","share_manual_decisions: false\nshare_tainted: false\nshare_custom: false\nshare_context: false\nconsole_management: false\n".into())] { io::write(Path::new(ENGINE).join(name).as_path(),value.as_bytes())?; }
    // Generate a separate local API identity; neither this secret nor logs reach the panel.
    if !Path::new(ENGINE)
        .join("local_api_credentials.yaml")
        .exists()
    {
        cscli(&["machines", "add", "ephor-local", "--auto", "--force"])?;
    }
    cscli(&["hub", "update"])?;
    cscli(&[
        "parsers",
        "install",
        "crowdsecurity/syslog-logs",
        "crowdsecurity/dateparse-enrich",
    ])?;
    cscli(&["collections", "install", "crowdsecurity/sshd"])?;
    io::command(
        &format!("{STATE}/runtime/usr/bin/crowdsec"),
        &["-c", CONFIG, "-t"],
        60,
    )
    .context("CrowdSec configuration validation failed")?;
    io::write(
        Path::new(STATE).join("version").as_path(),
        VERSION.as_bytes(),
    )?;
    service("enable")?;
    service("start")?;
    let _ = fs::remove_file(format!("{STATE}/crowdsec.deb"));
    Ok(())
}
pub fn uninstall() -> Result<()> {
    service("stop")?;
    service("disable")?;
    let runtime = Path::new(STATE).join("runtime");
    if runtime.exists() {
        fs::remove_dir_all(runtime)?;
    }
    for p in ["config.yaml", "acquis.yaml", "profiles.yaml"] {
        let _ = fs::remove_file(Path::new(ENGINE).join(p));
    }
    let _ = fs::remove_file(format!("{STATE}/version"));
    Ok(())
}
pub fn parse_decisions(value: &Value) -> Vec<Ban> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .take(1000)
        .filter_map(|v| {
            // cscli decisions list returns alerts containing decisions; flatten at the caller.
            let ip: IpAddr = v.get("value")?.as_str()?.parse().ok()?;
            let reason = v.get("scenario")?.as_str()?;
            if v.get("type")?.as_str()? != "ban"
                || v.get("scope")?.as_str()? != "Ip"
                || v.get("origin")?.as_str()? != "crowdsec"
                || v.get("simulated").and_then(Value::as_bool) == Some(true)
                || !reason.starts_with("crowdsecurity/ssh-")
            {
                return None;
            }
            let duration = v.get("duration")?.as_str()?;
            let remaining = duration_seconds(duration)?;
            Some(Ban {
                ip,
                reason: reason.chars().take(160).collect(),
                remaining_seconds: remaining.min(600),
            })
        })
        .take(100)
        .collect()
}
fn duration_seconds(s: &str) -> Option<u64> {
    let mut number = String::new();
    let mut total = 0f64;
    for c in s.chars() {
        if c.is_ascii_digit() || c == '.' {
            number.push(c);
        } else {
            let factor = match c {
                'h' => 3600.,
                'm' => 60.,
                's' => 1.,
                _ => return None,
            };
            total += number.parse::<f64>().ok()? * factor;
            number.clear();
        }
    }
    if !number.is_empty() || !total.is_finite() || total <= 0. {
        return None;
    }
    Some(total.min(14400.) as u64)
}
pub fn decisions() -> Result<Vec<Ban>> {
    let raw = cscli(&["decisions", "list", "-o", "json", "--limit", "100"])?;
    let v: Value = serde_json::from_str(&raw)?;
    // Current cscli emits alerts with a decisions array. Accept direct arrays for compatibility.
    let mut all = Vec::new();
    for item in v.as_array().context("Invalid CrowdSec decision response")? {
        if let Some(ds) = item.get("decisions").and_then(Value::as_array) {
            all.extend(ds.iter().cloned());
        } else {
            all.push(item.clone());
        }
    }
    Ok(parse_decisions(&Value::Array(all)))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_local_ssh_ip_bans() {
        let d = serde_json::json!({"value":"1.1.1.1","scenario":"crowdsecurity/ssh-bf","scope":"Ip","type":"ban","origin":"crowdsec","duration":"9m12.5s"});
        assert_eq!(
            parse_decisions(&serde_json::json!([d.clone()]))[0].remaining_seconds,
            552
        );
        for (key, value) in [
            ("origin", "CAPI"),
            ("scope", "Range"),
            ("scenario", "crowdsecurity/http-probing"),
            ("value", "1.1.1.1; flush ruleset"),
            ("duration", "-1s"),
        ] {
            let mut v = d.clone();
            v[key] = value.into();
            assert!(parse_decisions(&serde_json::json!([v])).is_empty());
        }
        assert!(!config().contains("online_client"));
        assert!(config().contains("127.0.0.1:18765"));
    }
}
