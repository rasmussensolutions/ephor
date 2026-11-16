//! Fixed-purpose service worker. Docker access stays out of the monitoring process.
//! No shell, host mounts, caller-selected command, Docker options or host port are accepted.
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
mod backup;
mod build;
mod catalog;
mod metrics;

const STATE: &str = "/var/lib/ephor-services";
const SETTINGS: &str = "/etc/ephor/services.json";
const PROXY: &str = "ephor-proxy";
const DOCKER: &str = "/usr/bin/docker";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    server: String,
    username: String,
    password: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spec {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    connections: Vec<Connection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    catalog: Option<catalog::Selection>,
    image: String,
    port: u16,
    health_path: String,
    memory_mb: u32,
    cpus: f64,
    environment: BTreeMap<String, String>,
    registry: Option<Registry>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Connection {
    service_id: String,
    template: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Domains {
    primary: Option<String>,
    aliases: Vec<String>,
    redirect: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    backup_id: Option<String>,
    id: String,
    service_id: String,
    domain: Option<String>,
    #[serde(default)]
    domains: Option<Domains>,
    action: String,
    spec: Spec,
}
#[derive(Clone, Serialize, Deserialize)]
struct Revision {
    job: Job,
    container: String,
    digest: String,
    port: u16,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Service {
    #[serde(default)]
    app: Option<catalog::App>,
    active: Option<Revision>,
    previous: Option<Revision>,
}
#[derive(Default, Serialize, Deserialize)]
struct State {
    services: BTreeMap<String, Service>,
    journal: Option<Journal>,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    job: Job,
    old: Service,
    status: String,
    digest: Option<String>,
    error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    panel: String,
    credential: String,
    proxy_image: String,
}

fn id(s: &str) -> bool {
    s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}
fn image(s: &str) -> bool {
    s.len() <= 255
        && s.contains('/')
        && s.bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/:@".contains(&b))
        && !s.contains("..")
        && !s.contains("//")
        && (s.rsplit('/').next().unwrap_or_default().contains(':'))
}
fn domain(s: &str) -> bool {
    s.len() <= 253
        && s.contains('.')
        && s.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
        && s.rsplit('.')
            .next()
            .is_some_and(|t| t.len() >= 2 && t.bytes().all(|b| b.is_ascii_lowercase()))
}
fn validate(job: &Job) -> Result<()> {
    let s = &job.spec;
    if s.catalog.is_some() {
        catalog::validate(job)?;
    } else {
        ensure!(
            ["deploy", "rollback", "stop"].contains(&job.action.as_str()),
            "Invalid stateless action"
        );
    }
    if let Some(domains) = &job.domains {
        ensure!(
            domains.primary == job.domain && domains.aliases.len() <= 9,
            "Invalid domains"
        );
        let mut names = std::collections::BTreeSet::new();
        for name in domains.primary.iter().chain(domains.aliases.iter()) {
            ensure!(
                domain(name) && names.insert(name),
                "Invalid or duplicate domain"
            );
        }
        ensure!(
            domains.primary.is_some() || domains.aliases.is_empty(),
            "Missing primary domain"
        );
    }
    ensure!(id(&job.id) && id(&job.service_id), "Invalid job identity");
    let mut sources = std::collections::BTreeSet::new();
    ensure!(s.connections.len() <= 64, "Too many connections");
    for connection in &s.connections {
        ensure!(
            s.catalog.is_none()
                && id(&connection.service_id)
                && connection.service_id != job.service_id
                && sources.insert(&connection.service_id)
                && ["postgres", "redis"].contains(&connection.template.as_str()),
            "Invalid service connection"
        );
    }
    ensure!(
        [
            "deploy",
            "rollback",
            "stop",
            "backup",
            "restore",
            "delete-backup"
        ]
        .contains(&job.action.as_str()),
        "Invalid operation"
    );
    ensure!(
        job.domain.as_ref().is_none_or(|v| domain(v)),
        "Invalid domain"
    );
    ensure!(
        image(&s.image)
            && s.port >= if s.catalog.is_some() { 1 } else { 1024 }
            && (64..=65536).contains(&s.memory_mb)
            && s.cpus.is_finite()
            && (0.1..=32.0).contains(&s.cpus),
        "Invalid service specification"
    );
    ensure!(
        s.health_path.starts_with('/')
            && s.health_path.len() <= 200
            && s.health_path
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/_.~-".contains(&b)),
        "Invalid health path"
    );
    ensure!(
        s.environment.len() <= 64 && serde_json::to_vec(&s.environment)?.len() <= 12000,
        "Too many environment variables"
    );
    for (k, v) in &s.environment {
        ensure!(
            !k.is_empty()
                && k.len() <= 64
                && k.bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
                && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && !v.contains('\0')
                && v.len() <= 4096,
            "Invalid environment"
        );
    }
    if let Some(r) = &s.registry {
        ensure!(
            Some(r.server.as_str()) == s.image.split('/').next()
                && !r.username.is_empty()
                && r.username.len() <= 200
                && !r.password.is_empty()
                && r.password.len() <= 4096,
            "Invalid registry"
        );
    }
    Ok(())
}
fn root() -> Result<()> {
    ensure!(
        Command::new("/usr/bin/id").arg("-u").output()?.stdout == b"0\n",
        "Service worker requires root"
    );
    Ok(())
}
fn directory(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::create_dir(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    let m = fs::symlink_metadata(path)?;
    ensure!(
        m.is_dir() && m.uid() == 0 && m.permissions().mode() & 0o022 == 0,
        "Unsafe service directory"
    );
    Ok(())
}
fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let m = fs::symlink_metadata(path)?;
    ensure!(
        m.is_file() && m.uid() == 0 && m.permissions().mode() & 0o077 == 0 && m.len() <= 4_000_000,
        "Unsafe service state"
    );
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn write<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let temp = path.with_extension("new");
    if temp.exists() {
        let _ = read::<Value>(&temp)?;
        fs::remove_file(&temp)?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    fs::rename(temp, path)?;
    File::open(path.parent().context("No state directory")?)?.sync_all()?;
    Ok(())
}
fn state_path() -> PathBuf {
    Path::new(STATE).join("state.json")
}
fn save(s: &State) -> Result<()> {
    write(&state_path(), s)
}
// Bounded output and deadline. Child output is never included in errors or journals.
fn docker(
    args: &[String],
    input: Option<&[u8]>,
    seconds: u64,
    config: Option<&Path>,
) -> Result<String> {
    let mut cmd = Command::new(DOCKER);
    cmd.env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("DOCKER_HOST", "unix:///var/run/docker.sock");
    if let Some(p) = config {
        cmd.arg("--config").arg(p);
    }
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = cmd.spawn().context("Docker unavailable")?;
    if let Some(bytes) = input {
        child
            .stdin
            .take()
            .context("No Docker stdin")?
            .write_all(bytes)?;
    }
    let mut out = child.stdout.take().context("No Docker stdout")?;
    let reader = thread::spawn(move || {
        let mut collected = Vec::new();
        let mut block = [0u8; 4096];
        while let Ok(n) = out.read(&mut block) {
            if n == 0 {
                break;
            }
            if collected.len() + n > 1024 * 1024 {
                let excess = (collected.len() + n) - 1024 * 1024;
                collected.drain(..excess.min(collected.len()));
            }
            collected.extend_from_slice(&block[..n]);
        }
        collected
    });
    let started = Instant::now();
    let success = loop {
        if let Some(status) = child.try_wait()? {
            break status.success();
        }
        if started.elapsed() > Duration::from_secs(seconds) {
            let _ = child.kill();
            let _ = child.wait();
            break false;
        }
        thread::sleep(Duration::from_millis(100));
    };
    let bytes = reader
        .join()
        .map_err(|_| anyhow::anyhow!("Docker output failed"))?;
    ensure!(success, "Docker operation failed or timed out");
    Ok(String::from_utf8_lossy(&bytes).trim().to_string())
}
fn d(args: &[&str], seconds: u64) -> Result<String> {
    docker(
        &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        None,
        seconds,
        None,
    )
}
fn inspect(name: &str) -> Result<Value> {
    let v: Value = serde_json::from_str(&d(&["inspect", name], 10)?)?;
    Ok(v[0].clone())
}
fn owned(name: &str) -> Result<bool> {
    match inspect(name) {
        Ok(v) => {
            ensure!(
                v["Config"]["Labels"]["ephor.managed"] == "1",
                "Refusing an unmanaged Docker resource"
            );
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}
fn remove(name: &str) -> Result<()> {
    if owned(name)? {
        d(&["rm", "-f", name], 30)?;
    }
    Ok(())
}
fn container(job: &Job) -> String {
    format!("ephor-{}-{}", job.service_id, job.id)
}
fn post(client: &Client, settings: &Settings, action: &str, body: Value) -> Result<Value> {
    let response = client
        .post(format!("{}/api/agent/services/{action}", settings.panel))
        .bearer_auth(&settings.credential)
        .json(&body)
        .send()
        .map_err(|_| anyhow::anyhow!("Panel unavailable"))?;
    ensure!(
        response.status().is_success(),
        "Panel rejected service request"
    );
    let mut bytes = Vec::new();
    response.take(64001).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 64000, "Panel response too large");
    Ok(serde_json::from_slice(&bytes)?)
}
fn proxy_config(state: &State) -> Value {
    let mut routes = Vec::new();
    for revision in state.services.values().filter_map(|s| s.active.as_ref()) {
        let Some(primary) = &revision.job.domain else {
            continue;
        };
        let domains = revision.job.domains.clone().unwrap_or(Domains {
            primary: Some(primary.clone()),
            ..Domains::default()
        });
        let mut hosts = vec![primary.clone()];
        if domains.redirect && !domains.aliases.is_empty() {
            routes.push(json!({"match":[{"host":domains.aliases}],"handle":[{"handler":"static_response","status_code":308,"headers":{"Location":[format!("https://{primary}{{http.request.uri}}")]}}],"terminal":true}));
        } else {
            hosts.extend(domains.aliases);
        }
        let mut handlers = Vec::new();
        let mut setup_protected = false;
        if let Some(app) = state
            .services
            .get(&revision.job.service_id)
            .and_then(|s| s.app.as_ref())
        {
            if let Some(access) = catalog::access(app) {
                handlers.push(access);
                setup_protected = true;
            }
        }
        let mut upstream = json!({"handler":"reverse_proxy","upstreams":[{"dial":format!("127.0.0.1:{}",revision.port)}],"stream_close_delay":"5m"});
        if setup_protected {
            upstream["headers"] = json!({"request":{"delete":["Authorization"]}});
        }
        handlers.push(upstream);
        routes.push(json!({"match":[{"host":hosts}],"handle":handlers,"terminal":true}));
    }
    let mut config = json!({"admin":{"listen":"unix//config/admin.sock"},"apps":{"http":{"servers":{"ephor":{"listen":[":443"],"routes":routes}}}}});
    if cfg!(test) {
        config["apps"]["tls"] =
            json!({"automation":{"policies":[{"issuers":[{"module":"internal"}]}]}});
    }
    config
}
fn proxy(state: &State, settings: &Settings) -> Result<()> {
    if !state
        .services
        .values()
        .any(|s| s.active.as_ref().is_some_and(|r| r.job.domain.is_some()))
    {
        remove(PROXY)?;
        return Ok(());
    }
    let dir = Path::new(STATE).join("proxy");
    directory(&dir)?;
    write(&dir.join("next.json"), &proxy_config(state))?;
    if owned(PROXY)? {
        if inspect(PROXY)?["State"]["Running"] != true {
            d(&["start", PROXY], 30)?;
            thread::sleep(Duration::from_secs(2));
        }
        // Full config is validated by Caddy before atomically replacing live routes.
        d(
            &[
                "exec",
                PROXY,
                "caddy",
                "reload",
                "--address",
                "unix//config/admin.sock",
                "--config",
                "/config/next.json",
            ],
            30,
        )?;
    } else {
        write(&dir.join("current.json"), &proxy_config(state))?;
        let mount = format!("type=bind,src={},dst=/config", dir.display());
        d(
            &[
                "run",
                "-d",
                "--name",
                PROXY,
                "--label",
                "ephor.managed=1",
                "--network",
                "host",
                "--restart",
                "unless-stopped",
                "--cap-drop",
                "ALL",
                "--cap-add",
                "NET_BIND_SERVICE",
                "--security-opt",
                "no-new-privileges",
                "--memory",
                "256m",
                "--pids-limit",
                "128",
                "--log-driver",
                "local",
                "--log-opt",
                "max-size=10m",
                "--log-opt",
                "max-file=3",
                "--mount",
                &mount,
                "--mount",
                "type=volume,src=ephor-caddy-data,dst=/data",
                &settings.proxy_image,
                "caddy",
                "run",
                "--config",
                "/config/current.json",
            ],
            60,
        )?;
        // An existing listener on 80/443 must fail the deployment, never silently steal traffic.
        thread::sleep(Duration::from_secs(2));
        d(
            &[
                "exec",
                PROXY,
                "caddy",
                "reload",
                "--address",
                "unix//config/admin.sock",
                "--config",
                "/config/next.json",
            ],
            30,
        )?;
    }
    write(&dir.join("current.json"), &proxy_config(state))?;
    Ok(())
}
fn pull(spec: &Spec) -> Result<String> {
    if spec.image.starts_with("ephor.local/") {
        let (name, digest) = spec
            .image
            .split_once('@')
            .context("Local build is not ready")?;
        let sid = name
            .strip_prefix("ephor.local/")
            .context("Invalid local build")?;
        ensure!(
            id(sid)
                && digest.starts_with("sha256:")
                && digest.len() == 71
                && digest[7..].bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid local image"
        );
        let info = inspect(digest)?;
        ensure!(
            info["Id"] == digest
                && info["RepoTags"]
                    .as_array()
                    .is_some_and(|tags| tags.iter().any(|tag| tag
                        .as_str()
                        .is_some_and(|tag| tag.starts_with(&format!("ephor.local/{sid}:"))))),
            "Local image unavailable or not owned by this service"
        );
        return Ok(spec.image.clone());
    }
    let dir = Path::new(STATE).join("registry");
    directory(&dir)?;
    // No CLI credentials or registry helper processes; temporary Docker config is root-only.
    let auth = if let Some(r) = &spec.registry {
        json!({"auths":{r.server.clone():{"auth":base64(format!("{}:{}",r.username,r.password).as_bytes())}}})
    } else {
        json!({"auths":{}})
    };
    write(&dir.join("config.json"), &auth)?;
    let result = (|| -> Result<String> {
        docker(&["pull".into(), spec.image.clone()], None, 600, Some(&dir))?;
        let v = inspect(&spec.image)?;
        let repo = spec.image.split('@').next().unwrap_or_default();
        let repo = match repo.rfind(':') {
            Some(i) if i > repo.rfind('/').unwrap_or(0) => &repo[..i],
            _ => repo,
        };
        let canonical = |s: &str| {
            let s = s.strip_prefix("docker.io/").unwrap_or(s);
            s.strip_prefix("library/").unwrap_or(s).to_string()
        };
        let found = v["RepoDigests"]
            .as_array()
            .and_then(|a| {
                a.iter().filter_map(Value::as_str).find(|s| {
                    s.split_once("@sha256:").is_some_and(|(name, hash)| {
                        canonical(name) == canonical(repo)
                            && hash.len() == 64
                            && hash.bytes().all(|b| b.is_ascii_hexdigit())
                    })
                })
            })
            .context("Image digest unavailable")?;
        let hash = found.split_once("@sha256:").context("Invalid digest")?.1;
        let digest = format!("{repo}@sha256:{hash}");
        ensure!(image(&digest), "Invalid resolved image");
        Ok(digest)
    })();
    let _ = fs::remove_file(dir.join("config.json"));
    result
}
fn base64(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        s.push(A[((n >> 18) & 63) as usize] as char);
        s.push(A[((n >> 12) & 63) as usize] as char);
        s.push(if c.len() > 1 {
            A[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        s.push(if c.len() > 2 {
            A[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    s
}
fn docker_client() -> Result<Client> {
    Ok(Client::builder()
        .unix_socket("/var/run/docker.sock")
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()?)
}
fn container_config(job: &Job, digest: &str, network: &str, host_port: u16) -> Value {
    let port = format!("{}/tcp", job.spec.port);
    let mut env: Vec<String> = job
        .spec
        .environment
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    if !job.spec.environment.contains_key("PORT") {
        env.push(format!("PORT={}", job.spec.port));
    }
    if !job.spec.environment.contains_key("HOST") {
        env.push("HOST=0.0.0.0".into());
    }
    json!({
        "Image":if digest.starts_with("ephor.local/") {digest.split_once('@').map(|(_,d)|d).unwrap_or(digest)} else {digest},"User":"65532:65532","Env":env,
        "Labels":{"ephor.managed":"1","ephor.service":job.service_id},
        "ExposedPorts":{port.clone():{}},
        "HostConfig":{
            "NetworkMode":network,"RestartPolicy":{"Name":"unless-stopped"},
            "CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"ReadonlyRootfs":true,
            "Tmpfs":{"/tmp":"rw,noexec,nosuid,size=64m,mode=1777"},
            "Memory":u64::from(job.spec.memory_mb)*1024*1024,"MemorySwap":u64::from(job.spec.memory_mb)*1024*1024,
            "NanoCpus":(job.spec.cpus*1_000_000_000.0) as u64,"PidsLimit":256,
            "LogConfig":{"Type":"local","Config":{"max-size":"10m","max-file":"3"}},
            "PortBindings":{port:[{"HostIp":"127.0.0.1","HostPort":host_port.to_string()}]}
        }
    })
}
fn logs(name: &str) -> Result<String> {
    let response = docker_client()?
        .get(format!(
            "http://localhost/containers/{name}/logs?stdout=1&stderr=1&tail=60&timestamps=1"
        ))
        .send()?;
    ensure!(response.status().is_success(), "Logs unavailable");
    let mut bytes = Vec::new();
    response.take(65536).read_to_end(&mut bytes)?;
    let mut text = String::new();
    let mut offset = 0;
    while offset + 8 <= bytes.len() {
        let size = u32::from_be_bytes(bytes[offset + 4..offset + 8].try_into()?) as usize;
        offset += 8;
        let end = (offset + size).min(bytes.len());
        text.push_str(&String::from_utf8_lossy(&bytes[offset..end]));
        offset = end;
    }
    Ok(text)
}
fn launch(job: &Job, digest: &str) -> Result<Revision> {
    let name = container(job);
    remove(&name)?;
    let network = format!("ephor-{}", job.service_id);
    match d(&["network", "inspect", &network], 10) {
        Ok(output) => {
            let v: Value = serde_json::from_str(&output)?;
            ensure!(
                v[0]["Labels"]["ephor.managed"] == "1",
                "Unmanaged network collision"
            );
        }
        Err(_) => {
            d(
                &["network", "create", "--label", "ephor.managed=1", &network],
                20,
            )?;
        }
    }
    // Use the Docker Unix API for creation. Application secrets never enter a host
    // process environment, command line, shell or Docker CLI configuration.
    // Pin the allocated loopback port in Docker's persistent HostConfig so a container
    // or host restart cannot silently change its proxy destination. Docker fails closed
    // if another process wins the small bind race before container startup.
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let host_port = listener.local_addr()?.port();
    let body = container_config(job, digest, &network, host_port);
    drop(listener);
    let response = docker_client()?
        .post(format!("http://localhost/containers/create?name={name}"))
        .json(&body)
        .send()
        .context("Container creation failed")?;
    ensure!(
        response.status().is_success(),
        "Container creation rejected"
    );
    for connection in &job.spec.connections {
        catalog::connect(&name, connection)?;
    }
    d(&["start", &name], 30)?;
    let v = inspect(&name)?;
    let key = format!("{}/tcp", job.spec.port);
    let port = v["NetworkSettings"]["Ports"][&key][0]["HostPort"]
        .as_str()
        .context("No loopback port")?
        .parse::<u16>()?;
    ensure!(port >= 1024, "Unsafe port");
    Ok(Revision {
        job: job.clone(),
        container: name,
        digest: digest.into(),
        port,
    })
}
fn healthy(client: &Client, r: &Revision) -> bool {
    if !inspect(&r.container).is_ok_and(|v| v["State"]["Running"] == true) {
        return false;
    }
    client
        .get(format!(
            "http://127.0.0.1:{}{}",
            r.port, r.job.spec.health_path
        ))
        .send()
        .is_ok_and(|r| r.status().is_success())
}
fn health_client() -> Result<Client> {
    Ok(Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()?)
}
fn apply(state: &mut State, settings: &Settings, job: &Job) -> Result<()> {
    validate(job)?;
    let old = state
        .services
        .get(&job.service_id)
        .cloned()
        .unwrap_or_default();
    let names = |job: &Job| {
        let mut hosts = job.domain.iter().cloned().collect::<Vec<_>>();
        if let Some(d) = &job.domains {
            hosts.extend(d.aliases.clone());
        }
        hosts
    };
    let requested = names(job);
    ensure!(
        !state.services.iter().any(|(id, s)| id != &job.service_id
            && s.active
                .as_ref()
                .is_some_and(|r| names(&r.job).iter().any(|h| requested.contains(h)))),
        "Domain collision"
    );
    state.journal = Some(Journal {
        job: job.clone(),
        old: old.clone(),
        status: "applying".into(),
        digest: None,
        error: None,
    });
    save(state)?;
    if job.spec.catalog.is_some() {
        return catalog::apply(state, settings, job);
    }
    if job.action == "stop" {
        state.services.insert(
            job.service_id.clone(),
            Service {
                app: None,
                active: None,
                previous: old.active.clone().or(old.previous.clone()),
            },
        );
        proxy(state, settings)?;
        if let Some(r) = &old.active {
            d(&["stop", "--time", "30", &r.container], 40)?;
        }
        state.journal.as_mut().context("No journal")?.status = "succeeded".into();
        save(state)?;
        return Ok(());
    }
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    ensure!(
        system.available_memory() > u64::from(job.spec.memory_mb) * 1024 * 1024 + 128 * 1024 * 1024,
        "INSUFFICIENT_CAPACITY"
    );
    let digest = pull(&job.spec).context("IMAGE_PULL_FAILED")?;
    let candidate = launch(job, &digest)?;
    let client = health_client()?;
    let start = Instant::now();
    let mut passes = 0;
    while start.elapsed() < Duration::from_secs(90) {
        if healthy(&client, &candidate) {
            passes += 1;
            if passes >= 3 {
                break;
            }
        } else {
            passes = 0;
        }
        thread::sleep(Duration::from_secs(2));
    }
    ensure!(passes >= 3, "HEALTH_CHECK_FAILED");
    state.services.insert(
        job.service_id.clone(),
        Service {
            app: None,
            active: Some(candidate),
            previous: old.active.clone().or(old.previous.clone()),
        },
    );
    proxy(state, settings).context("ROUTE_SWITCH_FAILED")?;
    // Persist the switched route before draining the previous container. Recovery always restores
    // old routes for an incomplete journal, including a crash between reload and disk write.
    save(state)?;
    thread::sleep(Duration::from_secs(10));
    if let Some(r) = &old.active {
        d(&["stop", "--time", "30", &r.container], 40)?;
    }
    if let Some(r) = &old.previous {
        if old.active.is_some() {
            remove(&r.container)?;
        }
    }
    let journal = state.journal.as_mut().context("No journal")?;
    journal.status = "succeeded".into();
    journal.digest = Some(digest);
    save(state)?;
    Ok(())
}
fn recover(state: &mut State, settings: &Settings, error: &str) -> Result<()> {
    let j = state.journal.as_ref().context("No journal")?;
    let job = j.job.clone();
    let old = j.old.clone();
    if job.spec.catalog.is_some() {
        return catalog::recover(state, settings, &job, error);
    }
    if let Some(r) = &old.active {
        d(&["start", &r.container], 30)?;
    }
    state.services.insert(job.service_id.clone(), old);
    proxy(state, settings)?;
    if job.action != "stop" {
        remove(&container(&job))?;
    }
    let j = state.journal.as_mut().context("No journal")?;
    j.status = "failed".into();
    j.error = Some(error.into());
    save(state)
}
fn receipt(client: &Client, settings: &Settings, state: &mut State) -> Result<()> {
    if let Some(j) = &state.journal {
        post(
            client,
            settings,
            "report",
            json!({"id":j.job.id,"status":j.status,"digest":j.digest,"error":j.error}),
        )?;
        state.journal = None;
        save(state)?;
    }
    Ok(())
}
fn telemetry(
    client: &Client,
    settings: &Settings,
    state: &State,
    collector: &mut metrics::Collector,
) {
    collector.retain(state);
    let health = match health_client() {
        Ok(c) => c,
        Err(_) => return,
    };
    for (id, service) in &state.services {
        let r = service.active.as_ref().or(service.previous.as_ref());
        let (status, name, mut logs) = if let Some(r) = r {
            let status = if service.active.is_none() {
                "stopped"
            } else if service
                .app
                .as_ref()
                .map(catalog::healthy)
                .unwrap_or_else(|| healthy(&health, r))
            {
                "running"
            } else if inspect(&r.container).is_ok() {
                "unhealthy"
            } else {
                "missing"
            };
            let logs = logs(&r.container).unwrap_or_default();
            (status, r.container.clone(), logs)
        } else {
            ("stopped", String::new(), String::new())
        };
        let catalog_report = service
            .app
            .as_ref()
            .and_then(|app| catalog::telemetry(app, collector, service.active.is_some()).ok());
        if let Some((_, app_logs, _)) = &catalog_report {
            logs = app_logs.clone();
        }
        for revision in [&service.active, &service.previous].into_iter().flatten() {
            for value in revision
                .job
                .spec
                .environment
                .values()
                .chain(revision.job.spec.registry.as_ref().map(|r| &r.password))
            {
                if !value.is_empty() {
                    logs = logs.replace(value, "[redacted]");
                }
            }
        }
        // Keep the tail bounded by UTF-8 bytes and avoid terminal escape injection.
        logs = logs
            .chars()
            .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
            .collect();
        if logs.len() > 10000 {
            let mut offset = logs.len() - 10000;
            while !logs.is_char_boundary(offset) {
                offset += 1;
            }
            logs = logs[offset..].into();
        }
        let metrics = if let Some((_, _, metrics)) = &catalog_report {
            metrics.clone()
        } else {
            service
                .active
                .as_ref()
                .and_then(|r| collector.sample(r).ok())
        };
        let _ = post(
            client,
            settings,
            "runtime",
            json!({"id":id,"status":status,"container":name,"logs":logs,"metrics":metrics,"catalog":catalog_report.map(|(v,_,_)|v)}),
        );
    }
}
pub fn configure(panel: &str) -> Result<()> {
    root()?;
    crate::config::panel_url(panel)?;
    ensure!(panel.starts_with("https://"), "HTTPS required");
    directory(Path::new("/etc/ephor"))?;
    directory(Path::new(STATE))?;
    if Path::new(SETTINGS).exists() {
        let existing: Settings = read(Path::new(SETTINGS))?;
        ensure!(existing.panel == panel, "Worker belongs to another panel");
        return Ok(());
    }
    // Requires Docker, but does not modify Docker configuration or stop existing workloads.
    d(&["info", "--format", "{{.OSType}}"], 15)?;
    let mut token = String::new();
    std::io::stdin().take(66).read_to_string(&mut token)?;
    let token = token.trim();
    ensure!(crate::config::token(token), "Invalid enrollment token");
    let pending = Path::new(STATE).join("enrollment.json");
    let identity = if pending.exists() {
        crate::config::Config::load(&pending)?
    } else {
        let c = crate::config::Config::new(panel)?;
        c.save(&pending, true)?;
        c
    };
    ensure!(
        identity.panel == panel,
        "Pending enrollment belongs to another panel"
    );
    // Version pin is resolved to a content digest once. Only a local administrator can change it.
    let proxy_image = pull(&Spec {
        connections: Vec::new(),
        catalog: None,
        image: "docker.io/library/caddy:2.11.9".into(),
        port: 8080,
        health_path: "/".into(),
        memory_mb: 256,
        cpus: 1.0,
        environment: BTreeMap::new(),
        registry: None,
    })?;
    let client = super::client()?;
    let response = client
        .post(format!("{panel}/api/agent/services/enroll"))
        .bearer_auth(token)
        .json(&json!({"credential":identity.credential}))
        .send()
        .map_err(|_| anyhow::anyhow!("Panel unavailable"))?;
    ensure!(
        response.status().is_success(),
        "Service enrollment rejected"
    );
    write(
        Path::new(SETTINGS),
        &Settings {
            panel: panel.into(),
            credential: identity.credential,
            proxy_image,
        },
    )?;
    save(&State::default())?;
    fs::remove_file(pending)?;
    Ok(())
}
pub fn run() -> Result<()> {
    root()?;
    directory(Path::new(STATE))?;
    let settings: Settings = read(Path::new(SETTINGS))?;
    crate::config::panel_url(&settings.panel)?;
    ensure!(
        settings.panel.starts_with("https://")
            && crate::config::token(&settings.credential)
            && image(&settings.proxy_image),
        "Invalid service worker configuration"
    );
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(Path::new(STATE).join("lock"))?;
    lock.try_lock_exclusive()
        .context("Another service worker is running")?;
    let mut state: State = read(&state_path())?;
    let client = super::client()?;
    let telemetry_settings = settings.clone();
    thread::spawn(move || {
        if let Ok(client) = super::client() {
            let mut collector = metrics::Collector::default();
            loop {
                let started = Instant::now();
                if let Ok(state) = read::<State>(&state_path()) {
                    telemetry(&client, &telemetry_settings, &state, &mut collector);
                }
                thread::sleep(Duration::from_secs(30).saturating_sub(started.elapsed()));
            }
        }
    });
    let heartbeat_settings = settings.clone();
    thread::spawn(move || {
        if let Ok(client) = super::client() {
            loop {
                let _ = post(
                    &client,
                    &heartbeat_settings,
                    "heartbeat",
                    json!({"protocol":5}),
                );
                thread::sleep(Duration::from_secs(30));
            }
        }
    });
    loop {
        let result = (|| -> Result<()> {
            if backup::resume(&client, &settings, &mut state)? {
                return Ok(());
            }
            if state
                .journal
                .as_ref()
                .is_some_and(|j| j.status == "applying")
            {
                recover(&mut state, &settings, "WORKER_INTERRUPTED")?;
            }
            receipt(&client, &settings, &mut state)?;
            if backup::poll(&client, &settings, &mut state)? {
                return Ok(());
            }
            let response = post(&client, &settings, "next", json!({"protocol":5}))?;
            if !response["job"].is_null() {
                let parsed: Result<Job, _> = serde_json::from_value(response["job"].clone());
                let job = match parsed {
                    Ok(job) if validate(&job).is_ok() => job,
                    _ => {
                        let jid = response["job"]["id"]
                            .as_str()
                            .filter(|v| id(v))
                            .context("Invalid job identity")?;
                        post(
                            &client,
                            &settings,
                            "report",
                            json!({"id":jid,"status":"failed","error":"CATALOG_WORKER_REQUIRED"}),
                        )?;
                        return Ok(());
                    }
                };
                if let Err(e) = apply(&mut state, &settings, &job) {
                    let message = e.to_string();
                    let code = if message.contains("INSUFFICIENT_CAPACITY") {
                        "INSUFFICIENT_CAPACITY"
                    } else if message.contains("IMAGE_PULL_FAILED") {
                        "IMAGE_PULL_FAILED"
                    } else if message.contains("HEALTH_CHECK_FAILED") {
                        "HEALTH_CHECK_FAILED"
                    } else if message.contains("ROUTE_SWITCH_FAILED") {
                        "ROUTE_SWITCH_FAILED"
                    } else if message.contains("DOCKER_VERSION_REQUIRED") {
                        "DOCKER_VERSION_REQUIRED"
                    } else if message.contains("BACKUP_LIMIT") {
                        "BACKUP_LIMIT"
                    } else if message.contains("BACKUP_FAILED") {
                        "BACKUP_FAILED"
                    } else if job.spec.catalog.is_some() {
                        "CATALOG_RECOVERY_REQUIRED"
                    } else {
                        "DEPLOYMENT_FAILED"
                    };
                    if state.journal.is_some() {
                        recover(&mut state, &settings, code)?;
                    } else {
                        post(
                            &client,
                            &settings,
                            "report",
                            json!({"id":job.id,"status":"failed","error":code}),
                        )?;
                    }
                }
                receipt(&client, &settings, &mut state)?;
            }
            build::poll(&client, &settings)?;
            Ok(())
        })();
        if result.is_err() {
            eprintln!("Service worker retrying; existing workloads remain running.");
        }
        thread::sleep(Duration::from_secs(30));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn job() -> Job {
        Job {
            backup_id: None,
            id: "a".repeat(36),
            service_id: "b".repeat(36),
            domain: Some("app.example.com".into()),
            domains: None,
            action: "deploy".into(),
            spec: Spec {
                connections: Vec::new(),
                catalog: None,
                image: "docker.io/library/example:1".into(),
                port: 3000,
                health_path: "/health".into(),
                memory_mb: 256,
                cpus: 0.5,
                environment: BTreeMap::new(),
                registry: None,
            },
        }
    }
    #[test]
    fn rejects_unsafe_specifications() {
        let mut j = job();
        assert!(validate(&j).is_ok());
        j.spec.image = "--privileged".into();
        assert!(validate(&j).is_err());
        j = job();
        j.spec.health_path = "//169.254.169.254/".into();
        assert!(validate(&j).is_ok()); /* URL remains fixed loopback with fixed port. */
        j.domain = Some("evil.com\nreverse_proxy localhost:2019".into());
        assert!(validate(&j).is_err());
        j = job();
        j.spec.port = 80;
        assert!(validate(&j).is_err());
    }
    #[test]
    fn routes_contain_only_active_loopback_targets() {
        let j = job();
        let mut state = State::default();
        state.services.insert(
            j.service_id.clone(),
            Service {
                app: None,
                active: Some(Revision {
                    job: j,
                    container: "name".into(),
                    digest: "digest".into(),
                    port: 32000,
                }),
                previous: None,
            },
        );
        let config = proxy_config(&state);
        assert_eq!(
            config["apps"]["http"]["servers"]["ephor"]["routes"][0]["handle"][0]["upstreams"][0]["dial"],
            "127.0.0.1:32000"
        );
        assert_eq!(config["admin"]["listen"], "unix//config/admin.sock");
    }
    #[test]
    fn application_environment_cannot_change_host_process_or_mount_policy() {
        let mut j = job();
        j.spec
            .environment
            .insert("LD_PRELOAD".into(), "/tmp/evil.so".into());
        j.spec
            .environment
            .insert("DOCKER_HOST".into(), "tcp://evil:2375".into());
        let config = container_config(&j, "digest", "network", 32000);
        assert_eq!(config["HostConfig"]["ReadonlyRootfs"], true);
        assert_eq!(config["User"], "65532:65532");
        assert!(config["HostConfig"].get("Binds").is_none());
        assert!(config["HostConfig"].get("Privileged").is_none());
        assert_eq!(
            config["HostConfig"]["PortBindings"]["3000/tcp"][0]["HostIp"],
            "127.0.0.1"
        );
        assert!(
            config["Env"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == "LD_PRELOAD=/tmp/evil.so")
        );
    }
    #[test]
    fn connections_are_bounded_and_only_allow_standalone_databases() {
        let mut j = job();
        j.spec.connections.push(Connection {
            service_id: "c".repeat(36),
            template: "postgres".into(),
        });
        assert!(validate(&j).is_ok());
        j.spec.connections.push(j.spec.connections[0].clone());
        assert!(validate(&j).is_err());
        j.spec.connections.pop();
        j.spec.connections[0].template = "ghost".into();
        assert!(validate(&j).is_err());
        j.spec.connections[0].template = "redis".into();
        j.spec.connections[0].service_id = j.service_id.clone();
        assert!(validate(&j).is_err());
        j.spec.connections[0].service_id = "../../docker.sock".into();
        assert!(validate(&j).is_err());
    }
    #[test]
    #[ignore = "requires isolated Linux Docker engine; see docs/services.md"]
    fn docker_deployment_lifecycle() {
        root().unwrap();
        directory(Path::new(STATE)).unwrap();
        let proxy_image = pull(&Spec {
            image: "docker.io/library/caddy:2.11.9".into(),
            ..job().spec
        })
        .unwrap();
        let settings = Settings {
            panel: "https://unused.example.org".into(),
            credential: "a".repeat(64),
            proxy_image,
        };
        let mut state = State::default();
        let mut first = job();
        first.id = "1".repeat(36);
        first.service_id = "a".repeat(36);
        first.domain = Some("example.org".into());
        first.domains = Some(Domains {
            primary: first.domain.clone(),
            aliases: vec!["www.example.org".into()],
            redirect: true,
        });
        first.spec.image = "docker.io/hashicorp/http-echo:1.0.0".into();
        first.spec.port = 5678;
        first.spec.health_path = "/".into();
        apply(&mut state, &settings, &first).unwrap();
        let initial = state.services[&first.service_id].active.clone().unwrap();
        assert!(healthy(&health_client().unwrap(), &initial));
        let mut collector = metrics::Collector::default();
        let sample = collector.sample(&initial).unwrap();
        assert!(sample["memoryBytes"].as_u64().unwrap() > 0);
        assert!(sample["processes"].as_u64().unwrap() > 0);
        assert!(sample["cpuPercent"].is_null());
        thread::sleep(Duration::from_secs(1));
        let sample = collector.sample(&initial).unwrap();
        assert!(
            sample["cpuPercent"]
                .as_f64()
                .is_some_and(|v| (0.0..=100.0).contains(&v))
        );
        assert!(sample["networkRxBytesPerSecond"].as_f64().is_some());
        let view = inspect(&initial.container).unwrap();
        assert_eq!(view["HostConfig"]["ReadonlyRootfs"], true);
        assert_eq!(view["HostConfig"]["Privileged"], false);
        assert_eq!(view["Config"]["User"], "65532:65532");
        let mut second = first.clone();
        second.id = "2".repeat(36);
        second.service_id = "b".repeat(36);
        second.domain = Some("second.example.org".into());
        second.domains = None;
        apply(&mut state, &settings, &second).unwrap();
        assert!(healthy(&health_client().unwrap(), &initial));
        assert_eq!(
            state
                .services
                .values()
                .filter(|s| s.active.is_some())
                .count(),
            2
        );
        // Caddy serves the first application, using only its internal test CA.
        // SNI is required by TLS. curl connects the hostname to loopback without changing DNS.
        let status = Command::new("curl")
            .args([
                "-fk",
                "--noproxy",
                "*",
                "--resolve",
                "example.org:443:127.0.0.1",
                "https://example.org/",
            ])
            .status()
            .unwrap();
        assert!(status.success());
        let redirect = Client::builder()
            .no_proxy()
            .danger_accept_invalid_certs(true)
            .redirect(reqwest::redirect::Policy::none())
            .resolve("www.example.org", "127.0.0.1:443".parse().unwrap())
            .build()
            .unwrap()
            .get("https://www.example.org/account?next=home")
            .send()
            .unwrap();
        assert_eq!(redirect.status().as_u16(), 308);
        assert_eq!(
            redirect.headers()["location"],
            "https://example.org/account?next=home"
        );
        // An interrupted switch restores the original route and revision.
        let mut update = first.clone();
        update.id = "3".repeat(36);
        let old = state.services[&first.service_id].clone();
        state.journal = Some(Journal {
            job: update.clone(),
            old: old.clone(),
            status: "applying".into(),
            digest: None,
            error: None,
        });
        save(&state).unwrap();
        let candidate = launch(&update, &initial.digest).unwrap();
        state.services.insert(
            first.service_id.clone(),
            Service {
                app: None,
                active: Some(candidate.clone()),
                previous: old.active.clone(),
            },
        );
        proxy(&state, &settings).unwrap();
        save(&state).unwrap();
        let mut reloaded: State = read(&state_path()).unwrap();
        recover(&mut reloaded, &settings, "WORKER_INTERRUPTED").unwrap();
        state = reloaded;
        assert_eq!(
            state.services[&first.service_id]
                .active
                .as_ref()
                .unwrap()
                .container,
            initial.container
        );
        assert!(inspect(&candidate.container).is_err());
        assert!(healthy(&health_client().unwrap(), &initial));
        // A failed image download leaves both applications running.
        update.id = "4".repeat(36);
        update.spec.image = "docker.io/library/no-such-ephor-test-image:absent".into();
        assert!(apply(&mut state, &settings, &update).is_err());
        recover(&mut state, &settings, "IMAGE_PULL_FAILED").unwrap();
        assert!(healthy(&health_client().unwrap(), &initial));
        // A container restart preserves the pinned loopback endpoint.
        d(&["restart", &initial.container], 40).unwrap();
        assert_eq!(
            inspect(&initial.container).unwrap()["NetworkSettings"]["Ports"]["5678/tcp"][0]["HostPort"],
            initial.port.to_string()
        );
        assert!(healthy(&health_client().unwrap(), &initial));
        // A candidate that never listens on the configured port must never replace live traffic.
        update.id = "8".repeat(36);
        update.spec = first.spec.clone();
        update.spec.port = 5679;
        assert!(apply(&mut state, &settings, &update).is_err());
        recover(&mut state, &settings, "HEALTH_CHECK_FAILED").unwrap();
        assert!(healthy(&health_client().unwrap(), &initial));
        let watching = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let flag = watching.clone();
        let watcher = thread::spawn(move || {
            let client = Client::builder()
                .no_proxy()
                .danger_accept_invalid_certs(true)
                .resolve("example.org", "127.0.0.1:443".parse().unwrap())
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            let mut failures = 0;
            while flag.load(std::sync::atomic::Ordering::SeqCst) {
                if !client
                    .get("https://example.org/")
                    .send()
                    .is_ok_and(|r| r.status().is_success())
                {
                    failures += 1;
                }
                thread::sleep(Duration::from_millis(100));
            }
            failures
        });
        // Successful deploy retains previous revision and supports rolling back its exact digest.
        update.id = "5".repeat(36);
        update.spec = first.spec.clone();
        apply(&mut state, &settings, &update).unwrap();
        assert_eq!(
            state.services[&first.service_id]
                .previous
                .as_ref()
                .unwrap()
                .container,
            initial.container
        );
        update.id = "6".repeat(36);
        update.action = "rollback".into();
        update.spec.image = initial.digest;
        apply(&mut state, &settings, &update).unwrap();
        assert!(healthy(
            &health_client().unwrap(),
            state.services[&first.service_id].active.as_ref().unwrap()
        ));
        watching.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            watcher.join().unwrap(),
            0,
            "Live traffic failed during deployment or rollback"
        );
        update.id = "7".repeat(36);
        update.action = "stop".into();
        apply(&mut state, &settings, &update).unwrap();
        assert!(state.services[&first.service_id].active.is_none());
        assert!(healthy(
            &health_client().unwrap(),
            state.services[&second.service_id].active.as_ref().unwrap()
        ));
        for service in state.services.values() {
            for r in [&service.active, &service.previous].into_iter().flatten() {
                remove(&r.container).unwrap();
            }
        }
        remove(PROXY).unwrap();
    }
    #[test]
    fn encodes_registry_credentials() {
        assert_eq!(base64(b"user:password"), "dXNlcjpwYXNzd29yZA==");
    }
}
