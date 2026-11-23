//! Observation only. Never invoke unattended-upgrade, refresh repositories, or write APT policy.
use super::*;
fn option<'a>(config: &'a str, key: &str) -> Option<&'a str> {
    config.lines().find_map(|line| {
        let tail = line.strip_prefix(key)?.strip_prefix(" \"")?;
        tail.strip_suffix("\";")
    })
}
fn enabled(value: Option<&str>, default: bool) -> Option<bool> {
    match value {
        None => Some(default),
        Some("always") => Some(true),
        Some(s) => s.parse::<u32>().ok().map(|n| n > 0),
    }
}
fn active(value: &str) -> bool {
    value.lines().any(|l| l == "ActiveState=active")
}
fn evaluate(
    installed: Option<bool>,
    config: Option<&str>,
    refresh: &str,
    upgrade: &str,
    last_run: Option<u64>,
    service: &str,
    now_ms: u64,
) -> Vec<Value> {
    let mut checks = vec![];
    let key = "maintenance.automatic-updates";
    let remediation = "Review unattended-upgrades, APT periodic settings, allowed security origins and apt-daily timers. Prefer a maintenance window; package updates can restart services. Host updates do not update container images.";
    let (status, evidence) = if installed.is_none() {
        (
            "error",
            "Could not read the package database. Automatic update installation status is unknown."
                .into(),
        )
    } else if installed == Some(false) {
        ("fail", "The unattended-upgrades package is not installed. Automatic updates through another tool are not assessed.".into())
    } else if let Some(config) = config {
        let periodic = enabled(option(config, "APT::Periodic::Enable"), true);
        let lists = enabled(option(config, "APT::Periodic::Update-Package-Lists"), false);
        let updates = enabled(option(config, "APT::Periodic::Unattended-Upgrade"), false);
        let origins = config
            .lines()
            .filter(|l| {
                (l.starts_with("Unattended-Upgrade::Allowed-Origins:: ")
                    || l.starts_with("Unattended-Upgrade::Origins-Pattern:: "))
                    && !l.ends_with("\"\";")
            })
            .count();
        if [periodic, lists, updates].contains(&None) {
            ("error", "APT uses a periodic interval this collector cannot interpret. Review the effective configuration locally.".into())
        } else if periodic != Some(true)
            || lists != Some(true)
            || updates != Some(true)
            || origins == 0
        {
            (
                "fail",
                format!(
                    "Installed, but effective APT settings do not enable all required periodic tasks and origin rules. Periodic enabled: {}; package lists: {}; upgrades: {}; origin rules: {origins}.",
                    periodic == Some(true),
                    lists == Some(true),
                    updates == Some(true)
                ),
            )
        } else if refresh.is_empty() || upgrade.is_empty() {
            (
                "error",
                "APT policy is enabled, but timer state could not be read.".into(),
            )
        } else if !active(refresh) || !active(upgrade) {
            ("unsupported", "APT policy is enabled, but both standard systemd timers are not active. A custom cron or scheduler may be in use; verify it locally.".into())
        } else {
            (
                "pass",
                format!(
                    "unattended-upgrades is installed, APT periodic tasks are enabled, both standard timers are active, and {origins} origin rules are configured. Repository coverage and held packages still require review."
                ),
            )
        }
    } else {
        (
            "error",
            "Could not read effective APT configuration.".into(),
        )
    };
    checks.push(check(
        key,
        "Automatic package updates",
        status,
        "maintenance",
        "medium",
        &evidence,
        remediation,
        "",
    ));
    if installed != Some(true) {
        return checks;
    }
    let failed = service
        .lines()
        .any(|l| l.starts_with("Result=") && l != "Result=success" && l != "Result=");
    let managed = config.is_some_and(|c| option(c, "Ephor::Updates::Managed") == Some("true"));
    let max_age_hours = if managed {
        config
            .and_then(|c| option(c, "Ephor::Updates::MaxGapDays"))
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|n| (1..=7).contains(n))
            .unwrap_or(7)
            * 24
            + 24
    } else {
        48
    };
    let (status, evidence) = if failed {
        (
            "fail",
            "The last apt-daily-upgrade service result reports a failure.".into(),
        )
    } else if let Some(t) = last_run {
        if t > now_ms {
            (
                "error",
                "The APT success stamp is dated in the future; check the system clock.".into(),
            )
        } else {
            (
                if now_ms - t <= max_age_hours * 3600000 {
                    "pass"
                } else {
                    "fail"
                },
                format!(
                    "APT's unattended-upgrade success stamp is {} hours old. This is scheduler evidence, not proof that every available security patch was applied.",
                    (now_ms - t) / 3600000
                ),
            )
        }
    } else {
        ("unsupported", "No APT unattended-upgrade success stamp is available; a recent successful automatic run cannot be confirmed.".into())
    };
    checks.push(check("maintenance.automatic-updates-run","Automatic update execution",status,"maintenance","medium",&evidence,"Review unattended-upgrades and apt-daily-upgrade logs, failed package operations and the update schedule.",""));
    if let Some(config) = config {
        let reboot = if managed {
            option(config, "Ephor::Updates::AutomaticReboot")
        } else {
            option(config, "Unattended-Upgrade::Automatic-Reboot")
        }
        .unwrap_or("false");
        let on = ["true", "1", "yes"].contains(&reboot);
        let known = on || ["false", "0", "no"].contains(&reboot);
        checks.push(check("maintenance.automatic-reboot","Automatic reboot policy",if !known {"error"}else if on {"fail"}else{"pass"},"maintenance","info",if !known {"Automatic reboot policy could not be interpreted."}else if on {"Automatic reboots are enabled. Confirm that the configured reboot window and workload recovery are acceptable."}else{"Automatic reboots are disabled. Schedule required reboots separately; package updates can still restart services."},"Review the automatic reboot policy and maintenance window. Ephor does not change this setting.",""));
    }
    checks
}
pub(super) fn collect() -> Vec<Value> {
    let installed = command(
        "/usr/bin/dpkg-query",
        &["-W", "-f=${Package}\t${Status}\n"],
        10,
        2_000_000,
    )
    .ok()
    .map(|s| {
        s.lines()
            .any(|line| line == "unattended-upgrades\tinstall ok installed")
    });
    let config = command("/usr/bin/apt-config", &["dump"], 10, 256000).ok();
    let timer = |unit| {
        command(
            "/usr/bin/systemctl",
            &["show", unit, "--property=LoadState,ActiveState"],
            10,
            4096,
        )
        .unwrap_or_default()
    };
    let last_run = fs::metadata("/var/lib/apt/periodic/upgrade-stamp")
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let service = command(
        "/usr/bin/systemctl",
        &["show", "apt-daily-upgrade.service", "--property=Result"],
        10,
        4096,
    )
    .unwrap_or_default();
    evaluate(
        installed,
        config.as_deref(),
        &timer("apt-daily.timer"),
        &timer("apt-daily-upgrade.timer"),
        last_run,
        &service,
        now(),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    const CONFIG: &str = "APT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Unattended-Upgrade \"1\";\nUnattended-Upgrade::Allowed-Origins:: \"Ubuntu:stable-security\";\nAcquire::https::Proxy \"https://secret:password@example.com\";";
    #[test]
    fn installed_is_not_enabled_or_successful() {
        let result = evaluate(
            Some(true),
            Some(CONFIG),
            "ActiveState=inactive",
            "ActiveState=active",
            None,
            "Result=success",
            100000,
        );
        assert_eq!(result[0]["status"], "unsupported");
        assert_eq!(result[1]["status"], "unsupported");
        assert!(!serde_json::to_string(&result).unwrap().contains("password"));
        assert_eq!(
            evaluate(None, None, "", "", None, "", 100000)[0]["status"],
            "error"
        );
        assert_eq!(
            evaluate(Some(false), None, "", "", None, "", 100000)[0]["status"],
            "fail"
        );
    }
    #[test]
    fn effective_policy_scheduler_and_run_are_separate() {
        let healthy = evaluate(
            Some(true),
            Some(CONFIG),
            "ActiveState=active",
            "ActiveState=active",
            Some(99000),
            "Result=success",
            100000,
        );
        assert!(healthy.iter().all(|c| c["status"] == "pass"));
        let disabled = CONFIG.replace("Unattended-Upgrade \"1\"", "Unattended-Upgrade \"0\"");
        assert_eq!(
            evaluate(
                Some(true),
                Some(&disabled),
                "ActiveState=active",
                "ActiveState=active",
                Some(99000),
                "Result=success",
                100000
            )[0]["status"],
            "fail"
        );
        assert_eq!(
            evaluate(
                Some(true),
                Some(CONFIG),
                "ActiveState=active",
                "ActiveState=active",
                Some(1),
                "Result=exit-code",
                100000
            )[1]["status"],
            "fail"
        );
        assert_eq!(
            evaluate(
                Some(true),
                Some(CONFIG),
                "ActiveState=active",
                "ActiveState=active",
                Some(1),
                "Result=success",
                200000000
            )[1]["status"],
            "fail"
        );
        let reboot = format!("{CONFIG}\nUnattended-Upgrade::Automatic-Reboot \"true\";");
        assert_eq!(
            evaluate(
                Some(true),
                Some(&reboot),
                "ActiveState=active",
                "ActiveState=active",
                None,
                "",
                100000
            )[2]["status"],
            "fail"
        );
    }
}
