use super::*;
use std::collections::BTreeMap;

fn os_release(input: &str) -> BTreeMap<String, String> {
    input
        .lines()
        .filter_map(|line| {
            let (k, v) = line.split_once('=')?;
            Some((k.to_string(), v.trim_matches('"').to_string()))
        })
        .collect()
}
fn setting(input: &str, key: &str) -> Option<String> {
    input.lines().find_map(|l| {
        let (k, v) = l.split_once(' ')?;
        (k == key).then(|| v.to_string())
    })
}
fn socket(line: &str) -> Option<Value> {
    let parts: Vec<_> = line.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let protocol = if parts[0].starts_with("tcp") {
        "tcp"
    } else if parts[0].starts_with("udp") {
        "udp"
    } else {
        return None;
    };
    let (address, port) = parts[4].rsplit_once(':')?;
    let port = port.parse::<u16>().ok()?;
    let process = line
        .split("users:((\"")
        .nth(1)
        .and_then(|s| s.split('"').next())
        .unwrap_or("");
    Some(
        json!({"protocol":protocol,"address":clean(address,128),"port":port,"process":clean(process,128)}),
    )
}
fn lifecycle(os: &BTreeMap<String, String>) -> Value {
    let distribution = os.get("ID").map(String::as_str).unwrap_or("");
    if !matches!(distribution, "ubuntu" | "debian") {
        return check(
            "os.support",
            "Operating system support",
            "unsupported",
            "maintenance",
            "medium",
            "Lifecycle checks currently support Ubuntu and Debian.",
            "Review your distribution's support lifecycle.",
            "",
        );
    }
    let file = format!("/usr/share/distro-info/{distribution}.csv");
    let Ok(data) = fs::read_to_string(file) else {
        return check(
            "os.support",
            "Operating system support",
            "unsupported",
            "maintenance",
            "medium",
            "The local distro-info lifecycle catalogue is unavailable.",
            "Install or update distro-info-data to enable this check.",
            "",
        );
    };
    let mut lines = data.lines();
    let headers: Vec<_> = lines.next().unwrap_or("").split(',').collect();
    let index = headers.iter().position(|h| *h == "eol");
    let series = headers.iter().position(|h| *h == "series");
    for line in lines {
        let fields: Vec<_> = line.split(',').collect();
        if series.and_then(|i| fields.get(i)).copied()
            != os.get("VERSION_CODENAME").map(String::as_str)
        {
            continue;
        }
        if let Some(date) = index
            .and_then(|i| fields.get(i))
            .and_then(|v| chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d").ok())
        {
            let ended = chrono::DateTime::from_timestamp_millis(now() as i64)
                .is_some_and(|current| current.date_naive() > date);
            return check(
                "os.support",
                "Operating system standard support",
                if ended { "fail" } else { "pass" },
                "maintenance",
                "high",
                &format!(
                    "Standard support ends {date}, according to the installed distro-info-data catalogue. Extended support subscriptions and LTS coverage are not assessed."
                ),
                "Update distro-info-data and confirm extended coverage or plan an OS upgrade.",
                "",
            );
        }
    }
    check(
        "os.support",
        "Operating system support",
        "unsupported",
        "maintenance",
        "medium",
        "This OS release is absent from the installed lifecycle catalogue.",
        "Update distro-info-data and verify the release lifecycle.",
        "",
    )
}
pub(super) fn scan_host() -> Result<Value> {
    let mut result = blank_result();
    let mut checks = Vec::new();
    let os = os_release(&fs::read_to_string("/etc/os-release").unwrap_or_default());
    result["inventory"]["os"] = json!(clean(
        os.get("PRETTY_NAME")
            .map(String::as_str)
            .unwrap_or("Unknown Linux"),
        256
    ));
    checks.push(lifecycle(&os));
    match command("/usr/sbin/sshd",&["-T"],15,128000) {
        Ok(config)=> {
            for (key,title,severity,good) in [("passwordauthentication","Default SSH password authentication","high",vec!["no"]),("permitrootlogin","Default SSH root login","medium",vec!["no"]),("kbdinteractiveauthentication","Default SSH keyboard-interactive authentication","medium",vec!["no"])] {
                let value=setting(&config,key);
                let status=match &value {Some(v) if good.contains(&v.as_str())=>"pass",Some(_)=>"fail",None=>"unsupported"};
                checks.push(check(&format!("ssh.{key}"),title,status,"ssh",severity,&format!("sshd -T: {key} {}. These are default settings; Match blocks may apply different policies to specific connections.",value.unwrap_or_else(||"unavailable".into())),"Review sshd configuration and Match overrides. Verify key-based access before changing authentication. Keyboard-interactive may be intentional for MFA.",""));
            }
        },
        Err(_)=>checks.push(check("ssh.configuration","SSH configuration","error","ssh","medium","sshd -T could not be inspected; SSH may be absent or the configuration could not be validated.","Check the OpenSSH server installation and configuration locally.","")),
    }
    match command("/usr/bin/ss", &["-H", "-lntup"], 15, 128000) {
        Ok(output) => {
            let ports: Vec<_> = output.lines().filter_map(socket).collect();
            let truncated = ports.len() > 256;
            let exposed: Vec<_> = ports
                .iter()
                .filter(|p| {
                    matches!(
                        p["port"].as_u64(),
                        Some(2375 | 2376 | 3306 | 5432 | 6379 | 27017 | 9200)
                    ) && !matches!(p["address"].as_str(), Some("127.0.0.1" | "[::1]" | "::1"))
                })
                .collect();
            checks.push(check("network.sensitive-listeners","Sensitive services listening beyond loopback",if truncated {"error"} else if exposed.is_empty(){"pass"}else{"fail"},"network","high",&format!("{} database or management listeners bind beyond loopback. Reachability is unverified; private interfaces, provider firewalls and routing may restrict access.",exposed.len()),"Inspect bind addresses and host/provider firewall rules. Keep database and management endpoints private.",""));
            result["inventory"]["ports"] = json!(ports.into_iter().take(256).collect::<Vec<_>>());
        }
        Err(_) => checks.push(check(
            "network.listeners",
            "Listening ports",
            "error",
            "network",
            "medium",
            "Listening ports could not be inspected.",
            "Ensure iproute2 is installed and the collector can inspect sockets.",
            "",
        )),
    }
    let mut firewalls = Vec::new();
    for (name, path, args) in [
        ("nftables", "/usr/sbin/nft", vec!["list", "ruleset"]),
        ("iptables IPv4", "/usr/sbin/iptables-save", vec![]),
        ("iptables IPv6", "/usr/sbin/ip6tables-save", vec![]),
        ("ufw", "/usr/sbin/ufw", vec!["status", "verbose"]),
        (
            "firewalld",
            "/usr/bin/firewall-cmd",
            vec!["--list-all-zones"],
        ),
    ] {
        if !Path::new(path).exists() {
            continue;
        }
        match command(path,&args,15,128000) {
            Ok(rules)=> {let redacted=rules.lines().any(|l|l.contains("comment ") || l.contains("--comment "));
                let filtered=rules.lines().filter(|l|!l.trim_start().starts_with('#')).map(|l|if l.contains("comment ") || l.contains("--comment ") {"[Rule contains a comment; inspect this rule locally]"}else{l}).collect::<Vec<_>>().join("\n");
                let status=if filtered.len()>16000 {"truncated"}else if redacted {"redacted"}else if filtered.is_empty(){"empty"}else{"inspected"};
                firewalls.push(json!({"name":name,"status":status,"rules":clean(&filtered,16000)}));
            },
            Err(_)=>firewalls.push(json!({"name":name,"status":"unavailable","rules":"Inspection failed or the firewall service is inactive."})),
        }
    }
    checks.push(check("network.firewall-visibility","Firewall inspection",if firewalls.iter().any(|f|f["status"]=="inspected" || f["status"]=="empty"){"pass"}else{"unsupported"},"network","medium","Inspected rules are evidence only. Docker forwarding, IPv6, provider firewalls and external reachability require separate review. Rules containing comments are marked for local inspection and counted as incomplete.","Review ingress and forwarding policies, including Docker traffic and IPv6. Ephor does not change rules.",""));
    result["inventory"]["firewalls"] = json!(firewalls);
    let mut protections = Vec::new();
    for (name, unit) in [
        ("CrowdSec", "crowdsec.service"),
        (
            "CrowdSec firewall remediation",
            "crowdsec-firewall-bouncer.service",
        ),
        ("Fail2ban", "fail2ban.service"),
        ("Tailscale", "tailscaled.service"),
        ("Tetragon", "tetragon.service"),
        ("Falco", "falco.service"),
    ] {
        let info = command(
            "/usr/bin/systemctl",
            &["show", unit, "--property=LoadState,ActiveState,SubState"],
            10,
            8192,
        )
        .unwrap_or_default();
        let state = if info.contains("LoadState=not-found") {
            "not installed"
        } else if info.contains("ActiveState=active") {
            "running"
        } else if info.is_empty() {
            "unknown"
        } else {
            "inactive"
        };
        let mut detail =
            "Service process state only; effective enforcement has not been verified.".to_string();
        if name == "Tailscale" && state == "running" {
            if let Ok(status) = command("/usr/bin/tailscale", &["status", "--json"], 10, 128000) {
                if let Ok(v) = serde_json::from_str::<Value>(&status) {
                    detail = format!(
                        "Backend: {}. Public SSH exposure and tailnet policy are not changed.",
                        clean(v["BackendState"].as_str().unwrap_or("unknown"), 40)
                    );
                }
            }
        }
        protections.push(json!({"name":name,"status":state,"detail":detail}));
    }
    result["inventory"]["protections"] = json!(protections);
    let supported = matches!(os.get("ID").map(String::as_str), Some("ubuntu" | "debian"));
    if supported {
        checks.extend(super::updates::collect());
        let metadata: Vec<_> = fs::read_dir("/var/lib/apt/lists")
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with("InRelease"))
            .filter_map(|e| e.metadata().ok()?.modified().ok())
            .collect();
        let fresh = !metadata.is_empty()
            && metadata
                .iter()
                .all(|t| t.elapsed().is_ok_and(|d| d < Duration::from_secs(86400)));
        checks.push(check("maintenance.package-index","Security update metadata",if fresh {"pass"}else{"fail"},"maintenance","medium",if fresh {"APT repository metadata was refreshed within 24 hours."}else{"APT repository metadata is missing or older than 24 hours. Update counts may be incomplete."},"Refresh APT repository metadata through your normal update process.",""));
        match command(
            "/usr/bin/apt-get",
            &["--simulate", "-o", "Debug::NoLocking=1", "upgrade"],
            60,
            256000,
        ) {
            Ok(output) => {
                let pending: Vec<_> = output
                    .lines()
                    .filter(|l| l.starts_with("Inst ") && l.to_lowercase().contains("security"))
                    .collect();
                checks.push(check("maintenance.security-updates","Available security updates",if !fresh{"error"}else if pending.is_empty(){"pass"}else{"fail"},"maintenance","high",&format!("{} security-origin upgrades reported by APT simulation using local repository metadata. Held packages and extended-support entitlement require separate review.",pending.len()),"Review and apply security updates during an appropriate maintenance window.",""));
            }
            Err(_) => checks.push(check(
                "maintenance.security-updates",
                "Available security updates",
                "error",
                "maintenance",
                "high",
                "APT upgrade simulation failed.",
                "Inspect the package manager and refresh repository metadata.",
                "",
            )),
        }
        checks.push(check("maintenance.reboot","Pending reboot",if Path::new("/var/run/reboot-required").exists(){"fail"}else{"pass"},"maintenance","medium","Based on the distribution's /var/run/reboot-required marker; not an independent running-kernel vulnerability assessment.","Schedule a reboot and verify services recover.",""));
    } else {
        checks.push(check(
            "maintenance.packages",
            "Security update and reboot checks",
            "unsupported",
            "maintenance",
            "medium",
            "Package update checks currently support Ubuntu and Debian.",
            "Use the distribution's security update tools.",
            "",
        ));
    }
    result["checks"] = json!(checks);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_ipv4_ipv6_tcp_udp_without_process_arguments() {
        let p = socket("tcp LISTEN 0 128 [::]:22 [::]:* users:((\"sshd\",pid=1,fd=3))").unwrap();
        assert_eq!(p["address"], "[::]");
        assert_eq!(p["port"], 22);
        assert_eq!(p["process"], "sshd");
        assert_eq!(
            socket("udp UNCONN 0 0 127.0.0.1:53 0.0.0.0:*").unwrap()["protocol"],
            "udp"
        );
        assert!(socket("malformed").is_none());
    }
    #[test]
    fn reads_effective_values_without_evaluating_shell() {
        assert_eq!(
            setting(
                "passwordauthentication no\npermitrootlogin prohibit-password",
                "passwordauthentication"
            )
            .as_deref(),
            Some("no")
        );
        assert_eq!(
            os_release("ID=ubuntu\nPRETTY_NAME=\"Ubuntu Linux\"")["PRETTY_NAME"],
            "Ubuntu Linux"
        );
    }
}
