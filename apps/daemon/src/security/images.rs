use super::*;
use std::collections::BTreeMap;

fn docker(client: &reqwest::blocking::Client, path: &str) -> Result<Value> {
    let response = client.get(format!("http://localhost{path}")).send()?;
    ensure!(
        response.status().is_success(),
        "Docker inspection unavailable"
    );
    let mut bytes = Vec::new();
    response.take(2_000_001).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 2_000_000, "Docker inventory too large");
    Ok(serde_json::from_slice(&bytes)?)
}
fn inventory(client: &reqwest::blocking::Client, sid: &str) -> Result<Vec<Value>> {
    let filters = json!({"label":["ephor.managed=1",format!("ephor.service={sid}")]});
    let mut url = reqwest::Url::parse("http://localhost/containers/json")?;
    url.query_pairs_mut()
        .append_pair("filters", &filters.to_string());
    let list = docker(
        client,
        &format!("{}?{}", url.path(), url.query().unwrap_or("")),
    )?;
    let list = list.as_array().context("Invalid Docker inventory")?;
    ensure!(list.len() <= 32, "Too many service containers");
    let mut result = Vec::new();
    for item in list {
        let cid = item["Id"].as_str().context("Missing container identity")?;
        ensure!(
            cid.len() == 64 && cid.bytes().all(|c| c.is_ascii_hexdigit()),
            "Invalid container identity"
        );
        let c = docker(client, &format!("/containers/{cid}/json"))?;
        ensure!(
            c["Config"]["Labels"]["ephor.managed"] == "1"
                && c["Config"]["Labels"]["ephor.service"] == sid,
            "Container ownership changed"
        );
        if c["Config"]["Labels"]["ephor.role"] == "helper" {
            continue;
        }
        result.push(c);
    }
    result.sort_by_key(|c| c["Id"].as_str().unwrap_or("").to_string());
    Ok(result)
}
fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|s| clean(s, 256))
        .take(64)
        .collect()
}
fn digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|c| c.is_ascii_hexdigit())
}
fn component(c: &Value, sid: &str) -> String {
    let name = c["Name"].as_str().unwrap_or("").trim_start_matches('/');
    if let Some(part) = name.strip_prefix(&format!("ephor-app-{sid}-")) {
        clean(part, 128)
    } else {
        "application".into()
    }
}
fn posture(c: &Value, component: &str) -> (Value, Vec<Value>) {
    let config = &c["HostConfig"];
    let user = clean(c["Config"]["User"].as_str().unwrap_or(""), 128);
    let caps = strings(&config["CapAdd"]);
    let drop = strings(&config["CapDrop"]);
    let mounts: Vec<String> = c["Mounts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["Type"] == "bind")
        .map(|m| clean(m["Destination"].as_str().unwrap_or("unknown"), 256))
        .take(64)
        .collect();
    let socket = c["Mounts"].as_array().into_iter().flatten().any(|m| {
        ["Source", "Destination"].iter().any(|key| {
            m[key]
                .as_str()
                .is_some_and(|path| path.ends_with("docker.sock"))
        })
    });
    let privileged = config["Privileged"].as_bool().unwrap_or(false);
    let readonly = config["ReadonlyRootfs"].as_bool().unwrap_or(false);
    let opts = strings(&config["SecurityOpt"]);
    let mut ports = Vec::new();
    for (port, bindings) in c["NetworkSettings"]["Ports"]
        .as_object()
        .into_iter()
        .flatten()
    {
        for binding in bindings.as_array().into_iter().flatten() {
            ports.push(clean(
                &format!(
                    "{}:{} → {port}",
                    binding["HostIp"].as_str().unwrap_or(""),
                    binding["HostPort"].as_str().unwrap_or("")
                ),
                256,
            ));
        }
    }
    let networks: Vec<_> = c["NetworkSettings"]["Networks"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, _)| clean(name, 256))
        .take(64)
        .collect();
    let definitions = [
        (
            "container.user",
            "Container user",
            !user.is_empty() && !matches!(user.split(':').next(), Some("0" | "root")),
            "medium",
            format!(
                "Configured user: {}",
                if user.is_empty() {
                    "image default (root)"
                } else {
                    &user
                }
            ),
            "Use a non-root runtime user where supported. Reviewed catalog applications may deliberately start as root.",
        ),
        (
            "container.privileged",
            "Privileged container",
            !privileged,
            "critical",
            format!("Privileged mode: {privileged}"),
            "Recreate the container without privileged mode.",
        ),
        (
            "container.capabilities",
            "Container capabilities",
            drop.iter().any(|c| c == "ALL") && caps.is_empty(),
            "medium",
            format!("Added: {}; dropped: {}", caps.join(", "), drop.join(", ")),
            "Drop all unnecessary Linux capabilities. Catalog applications may need a small reviewed set.",
        ),
        (
            "container.readonly",
            "Read-only root filesystem",
            readonly,
            "low",
            format!("Read-only root filesystem: {readonly}"),
            "Use a read-only root filesystem with explicit writable data volumes.",
        ),
        (
            "container.host-mounts",
            "Host bind mounts",
            mounts.is_empty(),
            "high",
            format!("Bind-mount destinations: {}", mounts.join(", ")),
            "Review host filesystem access and prefer managed named volumes.",
        ),
        (
            "container.docker-socket",
            "Docker socket access",
            !socket,
            "critical",
            format!("Docker socket mount detected: {socket}"),
            "Remove Docker socket access from application containers.",
        ),
        (
            "container.no-new-privileges",
            "Privilege escalation prevention",
            opts.iter()
                .any(|s| s == "no-new-privileges" || s == "no-new-privileges:true"),
            "high",
            format!("Security options: {}", opts.join(", ")),
            "Enable no-new-privileges when recreating the container.",
        ),
    ];
    let checks = definitions
        .into_iter()
        .map(|(key, title, ok, severity, evidence, remediation)| {
            check(
                key,
                title,
                if ok { "pass" } else { "fail" },
                "container",
                severity,
                &evidence,
                remediation,
                component,
            )
        })
        .collect();
    (
        json!({"id":c["Id"],"component":component,"digest":c["Image"],"user":user,"privileged":privileged,"readonlyRootfs":readonly,"capabilities":caps,"mounts":mounts,"ports":ports.into_iter().take(64).collect::<Vec<_>>(),"networks":networks}),
        checks,
    )
}
fn vulnerabilities(report: &Value, image: &str) -> (Vec<Value>, bool) {
    let mut values = Vec::new();
    let mut complete = true;
    for result in report["Results"].as_array().into_iter().flatten() {
        for v in result["Vulnerabilities"].as_array().into_iter().flatten() {
            if values.len() >= 1000 {
                complete = false;
                break;
            }
            let sev = v["Severity"].as_str().unwrap_or("UNKNOWN").to_lowercase();
            values.push(json!({"advisory":clean(v["VulnerabilityID"].as_str().unwrap_or("Unknown advisory"),100),"package":clean(v["PkgName"].as_str().unwrap_or("Unknown package"),256),"installedVersion":clean(v["InstalledVersion"].as_str().unwrap_or("unknown"),128),"fixedVersion":clean(v["FixedVersion"].as_str().unwrap_or(""),256),"severity":if matches!(sev.as_str(),"critical"|"high"|"medium"|"low"){&sev}else{"info"},"component":"","digest":image,"target":clean(result["Target"].as_str().unwrap_or(""),256)}));
        }
    }
    (values, complete)
}
fn scan_image(image: &str, force: bool) -> Result<Value> {
    ensure!(digest(image), "Only immutable local image IDs are scanned");
    let cache = Path::new(STATE).join(format!("image-{}.json", &image[7..]));
    if !force && cache.exists() {
        if let Ok(c) = read_state::<Value>(&cache) {
            if now().saturating_sub(c["at"].as_u64().unwrap_or(0)) < 86400000 {
                return Ok(c);
            }
        }
    }
    let cache_dir = format!("{STATE}/trivy");
    let raw = command(
        TRIVY,
        &[
            "image",
            "--config",
            "",
            "--cache-dir",
            &cache_dir,
            "--scanners",
            "vuln",
            "--image-src",
            "docker",
            "--format",
            "json",
            "--list-all-pkgs=false",
            "--ignorefile",
            "/dev/null",
            "--timeout",
            "3m",
            "--quiet",
            image,
        ],
        200,
        16_000_000,
    )?;
    let parsed: Value = serde_json::from_str(&raw)?;
    ensure!(
        parsed["SchemaVersion"].as_u64().is_some(),
        "Invalid Trivy report"
    );
    let (values, complete) = vulnerabilities(&parsed, image);
    let metadata = command(
        TRIVY,
        &[
            "--version",
            "--format",
            "json",
            "--cache-dir",
            &cache_dir,
            "--config",
            "",
        ],
        15,
        16384,
    )
    .ok()
    .and_then(|v| serde_json::from_str::<Value>(&v).ok())
    .unwrap_or(Value::Null);
    let updated = metadata["VulnerabilityDB"]["UpdatedAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis());
    let fresh = updated.is_some_and(|t| t >= 0 && now().saturating_sub(t as u64) < 48 * 3600000);
    let result = json!({"at":now(),"vulnerabilities":values,"complete":complete && fresh,"scanner":{"version":clean(metadata["Version"].as_str().unwrap_or("unknown"),80),"databaseUpdatedAt":updated},"eosl":parsed["Metadata"]["OS"]["EOSL"].as_bool().unwrap_or(false)});
    write_state(&cache, &result)?;
    Ok(result)
}
pub(super) fn scan_service(sid: &str, force: bool) -> Result<Value> {
    ensure!(uuid(sid), "Invalid service ID");
    let client = reqwest::blocking::Client::builder()
        .unix_socket("/var/run/docker.sock")
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()?;
    let containers = inventory(&client, sid)?;
    let mut result = blank_result();
    let mut checks = Vec::new();
    let mut items = Vec::new();
    let mut vulns = Vec::new();
    let mut complete = !containers.is_empty();
    let mut images = BTreeMap::new();
    let start = Instant::now();
    for c in &containers {
        let image = c["Image"]
            .as_str()
            .context("Missing immutable image identity")?;
        ensure!(digest(image), "Invalid image identity");
        let name = component(c, sid);
        let (item, posture_checks) = posture(c, &name);
        items.push(item);
        checks.extend(posture_checks);
        if start.elapsed() > Duration::from_secs(600) {
            complete = false;
            continue;
        }
        if !images.contains_key(image) {
            images.insert(image.to_string(), scan_image(image, force).ok());
        }
        if let Some(Some(report)) = images.get(image) {
            if report["complete"] != true {
                complete = false;
            }
            result["scanner"] = report["scanner"].clone();
            checks.push(check("container.image-support","Base image OS support",if report["eosl"]==true{"fail"}else{"pass"},"container","high",if report["eosl"]==true{"Trivy identifies this image's OS as end of support."}else{"Trivy did not flag this image's OS as end of support; this is not a guarantee of package coverage."},"Rebuild using a supported base image.",&name));
            for v in report["vulnerabilities"].as_array().into_iter().flatten() {
                if vulns.len() >= 1000 {
                    complete = false;
                    break;
                }
                let mut v = v.clone();
                v["component"] = json!(name);
                vulns.push(v);
            }
        } else {
            complete = false;
            checks.push(check("scan.image","Image vulnerability scan","error","coverage","high","Trivy could not scan this image. It may be unavailable, have stale/missing vulnerability data, or have exceeded resource limits.","Check the security helper and Trivy database connectivity, then run Scan now.",&name));
        }
    }
    let stable = inventory(&client, sid)
        .map(|current| {
            current
                .iter()
                .map(|v| (&v["Id"], &v["Image"]))
                .eq(containers.iter().map(|v| (&v["Id"], &v["Image"])))
        })
        .unwrap_or(false);
    complete &= stable;
    // During rolling deployments both old and candidate containers may exist; do not claim a complete snapshot.
    let mut names = std::collections::BTreeSet::new();
    if items
        .iter()
        .any(|v| !names.insert(v["component"].as_str().unwrap_or("").to_string()))
    {
        anyhow::bail!("Deployment is changing; scan will retry");
    }
    checks.push(check("scan.coverage","Image scan coverage",if complete{"pass"}else{"error"},"coverage","high",if complete{"All discovered running components scanned with vulnerability data updated within 48 hours. Package scanning identifies known component vulnerabilities, not application logic flaws."}else{"Coverage is incomplete: no running containers, a failed image scan, stale database, changing deployment, or scan/output limit. Existing findings are retained."},"Inspect helper health and running components, then retry the scan.",""));
    result["checks"] = json!(checks);
    result["inventory"]["containers"] = json!(items);
    result["vulnerabilities"] = json!(vulns);
    result["vulnerabilitiesComplete"] = json!(complete);
    // Bound Ephor's normalized result cache by age.
    for entry in fs::read_dir(STATE)?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("image-")
            && name.ends_with(".json")
            && entry
                .metadata()?
                .modified()?
                .elapsed()
                .is_ok_and(|age| age > Duration::from_secs(7 * 86400))
        {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires the isolated Linux Docker security fixture and Trivy database access"]
    fn linux_real_images_and_component_coverage() {
        root_directory().unwrap();
        let sid = "e5906638-bcc6-4afb-9118-d343c9462c42";
        for name in ["app", "database"] {
            command(
                "/usr/bin/docker",
                &[
                    "run",
                    "--detach",
                    "--name",
                    &format!("ephor-app-{sid}-{name}"),
                    "--label",
                    "ephor.managed=1",
                    "--label",
                    &format!("ephor.service={sid}"),
                    "--env",
                    "PASSWORD=do-not-report-this-value",
                    "alpine:3.16.0",
                    "sleep",
                    "600",
                ],
                120,
                8192,
            )
            .unwrap();
        }
        let result = scan_service(sid, true).unwrap();
        assert_eq!(
            result["inventory"]["containers"].as_array().unwrap().len(),
            2
        );
        assert_eq!(result["vulnerabilitiesComplete"], true, "{result}");
        assert!(!result["vulnerabilities"].as_array().unwrap().is_empty());
        assert_eq!(result["scanner"]["version"], "0.76.2");
        assert!(!result.to_string().contains("do-not-report-this-value"));
        for name in ["app", "database"] {
            assert!(
                result["vulnerabilities"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v["component"] == name)
            );
            command(
                "/usr/bin/docker",
                &["rm", "--force", &format!("ephor-app-{sid}-{name}")],
                15,
                8192,
            )
            .unwrap();
        }
        let empty = scan_service(sid, false).unwrap();
        assert_eq!(empty["vulnerabilitiesComplete"], false);
        let host = super::super::host::scan_host().unwrap();
        assert!(
            host["checks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["status"] == "unsupported")
        );
    }
    #[test]
    fn only_local_digest_can_reach_scanner() {
        assert!(!digest("alpine:latest"));
        assert!(!digest("--config=/etc/passwd"));
        assert!(digest(&format!("sha256:{}", "a".repeat(64))));
    }
    #[test]
    fn vulnerability_projection_excludes_secrets_and_untrusted_urls() {
        let v = json!({"Results":[{"Target":"package-lock.json","Vulnerabilities":[{"VulnerabilityID":"CVE-2026-1234","PkgName":"example","InstalledVersion":"1","FixedVersion":"2","Severity":"HIGH","Description":"secret-token","PrimaryURL":"javascript:alert(1)"}]}]});
        let (items, complete) = vulnerabilities(&v, &format!("sha256:{}", "a".repeat(64)));
        assert!(complete);
        assert_eq!(items[0]["severity"], "high");
        assert!(!items[0].to_string().contains("secret-token"));
        assert!(!items[0].to_string().contains("javascript"));
    }
    #[test]
    fn posture_does_not_upload_environment_or_command() {
        let c = json!({"Id":"abc","Image":"sha256:abc","Config":{"User":"0","Env":["PASSWORD=secret"],"Cmd":["secret"]},"HostConfig":{"Privileged":true,"ReadonlyRootfs":false,"CapAdd":["SYS_ADMIN"]},"Mounts":[{"Type":"bind","Source":"/secret","Destination":"/var/run/docker.sock"}]});
        let (inventory, checks) = posture(&c, "app");
        assert!(!inventory.to_string().contains("PASSWORD"));
        assert!(!inventory.to_string().contains("/secret"));
        assert!(
            checks
                .iter()
                .any(|c| c["key"] == "container.privileged" && c["status"] == "fail")
        );
    }
}
