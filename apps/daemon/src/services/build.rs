//! Source builds run in disposable, resource-limited builders. No runtime secrets enter builds.
use super::*;
use std::sync::{Arc, Mutex};

const RAILPACK: &str = "/usr/local/libexec/ephor-railpack";
const BUILDKIT: &str = "docker.io/moby/buildkit:v0.35.0";
const FRONTEND: &str = "ghcr.io/railwayapp/railpack-frontend:v0.43.0";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Build {
    id: String,
    service_id: String,
    repository: String,
    sha: String,
    token: String,
    context: String,
    dockerfile: String,
    build_type: String,
    build_memory_mb: u32,
    build_cpus: f64,
    image: String,
    registry: Option<Registry>,
    variables: BTreeMap<String, String>,
}
#[derive(Serialize, Deserialize)]
struct Pending {
    id: String,
    digest: Option<String>,
    error: Option<String>,
}
fn safe_path(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 150
        && !s.starts_with('/')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
        && !s.split('/').any(|p| p == ".." || p == ".git")
}
fn validate_build(b: &Build) -> Result<()> {
    ensure!(id(&b.id) && id(&b.service_id), "Invalid build identity");
    ensure!(
        b.repository.split('/').count() == 2
            && b.repository.len() <= 200
            && b.repository.split('/').all(|p| !p.is_empty()
                && !p.starts_with('-')
                && p != "."
                && p != ".."
                && p.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))),
        "Invalid repository"
    );
    ensure!(
        b.sha.len() == 40 && b.sha.bytes().all(|c| c.is_ascii_hexdigit()),
        "Invalid commit"
    );
    ensure!(
        !b.token.is_empty() && b.token.len() <= 1000 && !b.token.contains(['\r', '\n', '\0']),
        "Invalid source credential"
    );
    ensure!(
        safe_path(&b.context)
            && safe_path(&b.dockerfile)
            && ["auto", "railpack", "dockerfile"].contains(&b.build_type.as_str()),
        "Invalid build instructions"
    );
    ensure!(
        (512..=32768).contains(&b.build_memory_mb)
            && b.build_cpus.is_finite()
            && (0.25..=16.0).contains(&b.build_cpus),
        "Invalid build limits"
    );
    ensure!(
        image(&b.image) && b.image.ends_with(&format!("/{}:{}", b.service_id, b.id)),
        "Invalid build destination"
    );
    ensure!(
        b.variables.len() <= 32 && serde_json::to_vec(&b.variables)?.len() <= 8000,
        "Invalid build variables"
    );
    for (k, v) in &b.variables {
        ensure!(
            !k.is_empty()
                && k.len() <= 64
                && k.bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
                && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && v.len() <= 4096
                && !v.contains('\0'),
            "Invalid build variable"
        );
    }
    if let Some(r) = &b.registry {
        ensure!(
            Some(r.server.as_str()) == b.image.split('/').next()
                && !r.username.is_empty()
                && !r.password.is_empty()
                && r.password.len() <= 4096,
            "Invalid build registry"
        );
    }
    Ok(())
}
struct Progress<'a> {
    client: &'a Client,
    settings: &'a Settings,
    job: &'a Build,
    phase: &'static str,
    logs: Arc<Mutex<String>>,
    last: Instant,
}
impl Progress<'_> {
    fn send(&mut self) -> Result<()> {
        let mut logs = self
            .logs
            .lock()
            .map_err(|_| anyhow::anyhow!("Log lock"))?
            .clone();
        for secret in std::iter::once(&self.job.token)
            .chain(self.job.registry.as_ref().map(|r| &r.password))
            .chain(self.job.variables.values())
        {
            if !secret.is_empty() {
                logs = logs.replace(secret, "[redacted]");
            }
        }
        // Git's HTTP authorization contains a base64-encoded token.
        logs = logs.replace(
            &base64(format!("x-access-token:{}", self.job.token).as_bytes()),
            "[redacted]",
        );
        logs = logs
            .chars()
            .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
            .collect();
        if logs.len() > 16000 {
            let mut cut = logs.len() - 16000;
            while !logs.is_char_boundary(cut) {
                cut += 1;
            }
            logs.drain(..cut);
        }
        let value = post(
            self.client,
            self.settings,
            "build-progress",
            json!({"id":self.job.id,"phase":self.phase,"logs":logs}),
        )?;
        ensure!(value["active"] == true, "Build cancelled");
        self.last = Instant::now();
        Ok(())
    }
    fn run(&mut self, cmd: &mut Command, seconds: u64) -> Result<String> {
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        let mut child = cmd.spawn().context("BUILD_TOOLS_REQUIRED")?;
        let mut readers = Vec::new();
        let output = Arc::new(Mutex::new(String::new()));
        for mut pipe in [
            Box::new(child.stdout.take().context("No stdout")?) as Box<dyn Read + Send>,
            Box::new(child.stderr.take().context("No stderr")?),
        ] {
            let logs = self.logs.clone();
            let output = output.clone();
            readers.push(thread::spawn(move || {
                let mut block = [0u8; 4096];
                while let Ok(n) = pipe.read(&mut block) {
                    if n == 0 {
                        break;
                    }
                    let text = String::from_utf8_lossy(&block[..n]);
                    for buffer in [&logs, &output] {
                        if let Ok(mut s) = buffer.lock() {
                            s.push_str(&text);
                            if s.len() > 12000 {
                                let mut cut = s.len() - 12000;
                                while !s.is_char_boundary(cut) {
                                    cut += 1;
                                }
                                s.drain(..cut);
                            }
                        }
                    }
                }
            }));
        }
        let started = Instant::now();
        let result = (|| -> Result<()> {
            loop {
                if let Some(status) = child.try_wait()? {
                    ensure!(status.success(), "Build command failed");
                    break;
                }
                ensure!(
                    started.elapsed() < Duration::from_secs(seconds),
                    "BUILD_TIMED_OUT"
                );
                if self.last.elapsed() > Duration::from_secs(10) {
                    self.send()?;
                    ensure!(
                        free_space() > 2 * 1024 * 1024 * 1024,
                        "INSUFFICIENT_CAPACITY"
                    );
                }
                thread::sleep(Duration::from_millis(100));
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
        }
        for reader in readers {
            let _ = reader.join();
        }
        result?;
        let value = output
            .lock()
            .map_err(|_| anyhow::anyhow!("Output lock"))?
            .clone();
        Ok(value)
    }
    fn docker(&mut self, args: &[String], config: &Path, seconds: u64) -> Result<String> {
        let mut cmd = Command::new(DOCKER);
        cmd.env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("DOCKER_HOST", "unix:///var/run/docker.sock")
            .arg("--config")
            .arg(config)
            .args(args);
        self.run(&mut cmd, seconds)
    }
}
fn free_space() -> u64 {
    sysinfo::Disks::new_with_refreshed_list()
        .iter()
        .filter(|d| Path::new(STATE).starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
        .unwrap_or(0)
}
fn git(
    progress: &mut Progress<'_>,
    directory: &Path,
    config: &Path,
    args: &[&str],
) -> Result<String> {
    let mut cmd = Command::new("/usr/bin/git");
    cmd.env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", config)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ALLOW_PROTOCOL", "https")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .current_dir(directory)
        .args(args);
    progress.run(&mut cmd, 300)
}
fn within(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = root.join(relative).canonicalize()?;
    ensure!(
        path.starts_with(root.canonicalize()?),
        "Build path escapes repository"
    );
    Ok(path)
}
// The service's private umask protects credentials. Only the checked-out source
// becomes readable to the unprivileged planner; never follow repository symlinks.
fn source_permissions(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
        for entry in fs::read_dir(path)? {
            source_permissions(&entry?.path())?;
        }
    } else if meta.is_file() {
        let mode = if meta.permissions().mode() & 0o111 != 0 {
            0o755
        } else {
            0o644
        };
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}
fn cleanup(id: &str) {
    let root = Path::new(STATE).join("builds").join(id);
    let config = root.join("docker");
    let _ = docker(
        &[
            "buildx".into(),
            "rm".into(),
            "--force".into(),
            format!("ephor-build-{id}"),
        ],
        None,
        30,
        Some(&config),
    );
    // BuildKit is created by buildx with a deterministic name. Kill it after cancellation/timeout.
    let _ = d(
        &["rm", "-f", &format!("buildx_buildkit_ephor-build-{id}0")],
        30,
    );
    let _ = d(&["rm", "-f", &format!("ephor-plan-{id}")], 30);
    let _ = fs::remove_dir_all(root);
}
fn execute(progress: &mut Progress<'_>) -> Result<String> {
    let b = progress.job;
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    ensure!(
        system.available_memory() > u64::from(b.build_memory_mb) * 1024 * 1024 + 256 * 1024 * 1024
            && free_space() > 5 * 1024 * 1024 * 1024,
        "INSUFFICIENT_CAPACITY"
    );
    let builds = Path::new(STATE).join("builds");
    directory(&builds)?;
    let root = builds.join(&b.id);
    directory(&root)?;
    let source = root.join("source");
    directory(&source)?;
    let config = root.join("docker");
    directory(&config)?;
    let auth = if let Some(r) = &b.registry {
        json!({"auths":{r.server.clone():{"auth":base64(format!("{}:{}",r.username,r.password).as_bytes())}}})
    } else {
        json!({"auths":{}})
    };
    write(&config.join("config.json"), &auth)?;
    let credential = root.join("gitconfig");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&credential)?;
    writeln!(
        file,
        "[http \"https://github.com/\"]\nextraHeader = AUTHORIZATION: basic {}\n[core]\nhooksPath = /dev/null\n[credential]\nhelper =\n[protocol \"file\"]\nallow = never",
        base64(format!("x-access-token:{}", b.token).as_bytes())
    )?;
    git(progress, &source, &credential, &["init", "--template="])?;
    git(
        progress,
        &source,
        &credential,
        &[
            "remote",
            "add",
            "origin",
            &format!("https://github.com/{}.git", b.repository),
        ],
    )?;
    git(
        progress,
        &source,
        &credential,
        &["fetch", "--depth=1", "origin", &b.sha],
    )
    .context("FETCH_FAILED")?;
    git(
        progress,
        &source,
        &credential,
        &["checkout", "--detach", "FETCH_HEAD"],
    )?;
    let head = git(progress, &source, &credential, &["rev-parse", "HEAD"])?;
    ensure!(head.trim() == b.sha, "Commit mismatch");
    fs::remove_file(credential)?;
    fs::remove_dir_all(source.join(".git"))?;
    source_permissions(&source)?;
    build_image(progress, &root, &source, &config)
}
fn build_image(
    progress: &mut Progress<'_>,
    root: &Path,
    source: &Path,
    config: &Path,
) -> Result<String> {
    let b = progress.job;
    let context = within(source, &b.context)?;
    ensure!(context.is_dir(), "Invalid build context");
    let dockerfile = context.join(&b.dockerfile);
    let auto = b.build_type == "railpack" || (b.build_type == "auto" && !dockerfile.exists());
    let mut arguments = vec![
        "buildx".into(),
        "build".into(),
        "--builder".into(),
        format!("ephor-build-{}", b.id),
        "--progress=plain".into(),
        "--provenance=false".into(),
        "--label".into(),
        format!("ephor.service={}", b.service_id),
        "--tag".into(),
        b.image.clone(),
        "--metadata-file".into(),
        root.join("metadata.json").display().to_string(),
    ];
    let build_file = if auto {
        ensure!(Path::new(RAILPACK).is_file(), "BUILD_TOOLS_REQUIRED");
        progress.phase = "planning";
        progress.send()?;
        let out = root.join("plan");
        directory(&out)?;
        fs::set_permissions(&out, fs::Permissions::from_mode(0o777))?;
        // Analyze untrusted manifests in a restricted container, never as a host process.
        let mut command = vec![
            "prepare".to_string(),
            "/source".into(),
            "--plan-out".into(),
            "/output/plan.json".into(),
            "--info-out".into(),
            "/output/info.json".into(),
        ];
        for (k, v) in &b.variables {
            command.push("--env".into());
            command.push(format!("{k}={v}"));
        }
        let name = format!("ephor-plan-{}", b.id);
        let body = json!({"Image":"docker.io/library/alpine:3.22","User":"65532:65532","Entrypoint":["/usr/local/bin/railpack"],"Cmd":command,"WorkingDir":"/tmp","Env":["HOME=/tmp","PATH=/usr/local/bin:/usr/bin:/bin"],"HostConfig":{"ReadonlyRootfs":true,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"Memory":u64::from(b.build_memory_mb)*1024*1024,"MemorySwap":u64::from(b.build_memory_mb)*1024*1024,"NanoCpus":(b.build_cpus*1_000_000_000.0) as u64,"PidsLimit":128,"Tmpfs":{"/tmp":"rw,nosuid,exec,size=256m,mode=1777"},"Binds":[format!("{}:/source:ro",context.display()),format!("{}:/output:rw",out.display()),format!("{RAILPACK}:/usr/local/bin/railpack:ro")],"LogConfig":{"Type":"local","Config":{"max-size":"10m","max-file":"2"}}}});
        progress.docker(
            &["pull".into(), "docker.io/library/alpine:3.22".into()],
            config,
            180,
        )?;
        let response = docker_client()?
            .post(format!("http://localhost/containers/create?name={name}"))
            .json(&body)
            .send()?;
        ensure!(response.status().is_success(), "Planner creation failed");
        progress.docker(&["start".into(), name.clone()], config, 30)?;
        progress.docker(&["wait".into(), name.clone()], config, 300)?;
        if let Ok(text) = logs(&name) {
            progress
                .logs
                .lock()
                .map_err(|_| anyhow::anyhow!("Log lock"))?
                .push_str(&text);
        }
        ensure!(
            inspect(&name)?["State"]["ExitCode"] == 0,
            "Application detection failed; check build logs"
        );
        let plan = out.join("plan.json");
        let meta = fs::symlink_metadata(&plan)?;
        ensure!(
            meta.is_file() && meta.len() <= 2_000_000,
            "Invalid build plan"
        );
        let bytes = fs::read(&plan)?;
        let _: Value = serde_json::from_slice(&bytes)?;
        arguments.extend([
            "--build-arg".into(),
            format!("BUILDKIT_SYNTAX={FRONTEND}"),
            "--build-arg".into(),
            format!("cache-key={}", b.service_id),
        ]);
        plan
    } else {
        within(&context, &b.dockerfile)?
    };
    ensure!(build_file.is_file(), "Dockerfile missing");
    progress.phase = "building";
    progress.send()?;
    let memory = format!("{}m", b.build_memory_mb);
    let quota = (b.build_cpus * 100000.0).round().to_string();
    progress.docker(&["buildx".into(),"create".into(),"--name".into(),format!("ephor-build-{}",b.id),"--driver=docker-container".into(),format!("--driver-opt=image={BUILDKIT},memory={memory},memory-swap={memory},cpu-period=100000,cpu-quota={quota}"),"--buildkitd-flags=--oci-worker-net=bridge --oci-worker-gc-keepstorage=1024".into()],config,120)?;
    for (k, v) in &b.variables {
        let path = root.join(format!("secret-{k}"));
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        f.write_all(v.as_bytes())?;
        arguments.extend(["--secret".into(), format!("id={k},src={}", path.display())]);
    }
    arguments.extend([
        "--file".into(),
        build_file.display().to_string(),
        if b.registry.is_some() {
            "--push".into()
        } else {
            "--load".into()
        },
        context.display().to_string(),
    ]);
    progress.docker(&arguments, config, 1200)?;
    progress.phase = "publishing";
    progress.send()?;
    let digest = if b.registry.is_some() {
        let bytes = fs::read(root.join("metadata.json"))?;
        ensure!(bytes.len() < 100000, "Invalid build metadata");
        let value: Value = serde_json::from_slice(&bytes)?;
        value["containerimage.digest"]
            .as_str()
            .context("Missing build digest")?
            .to_string()
    } else {
        inspect(&b.image)?["Id"]
            .as_str()
            .context("Missing image ID")?
            .to_string()
    };
    ensure!(
        digest.starts_with("sha256:")
            && digest.len() == 71
            && digest[7..].bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid digest"
    );
    Ok(format!(
        "{}@{digest}",
        b.image.rsplit_once(':').context("No image tag")?.0
    ))
}
pub(super) fn poll(client: &Client, settings: &Settings) -> Result<()> {
    let pending = Path::new(STATE).join("build-receipt.json");
    if pending.exists() {
        let mut receipt: Pending = read(&pending)?;
        ensure!(id(&receipt.id), "Invalid build receipt");
        cleanup(&receipt.id);
        if receipt.digest.is_none() && receipt.error.is_none() {
            receipt.error = Some("BUILD_INTERRUPTED".into());
            write(&pending, &receipt)?;
        }
        post(
            client,
            settings,
            "build-report",
            serde_json::to_value(receipt)?,
        )?;
        fs::remove_file(&pending)?;
    }
    let response = post(client, settings, "build-next", json!({"protocol":PROTOCOL}))?;
    if response["job"].is_null() {
        return Ok(());
    }
    let job: Build = serde_json::from_value(response["job"].clone())?;
    validate_build(&job)?;
    write(
        &pending,
        &Pending {
            id: job.id.clone(),
            digest: None,
            error: None,
        },
    )?;
    let mut progress = Progress {
        client,
        settings,
        job: &job,
        phase: "fetching",
        logs: Arc::new(Mutex::new(String::new())),
        last: Instant::now(),
    };
    let result = execute(&mut progress);
    let _ = progress.send();
    let receipt = match result {
        Ok(digest) => Pending {
            id: job.id.clone(),
            digest: Some(digest),
            error: None,
        },
        Err(e) => {
            let message = e.to_string();
            let code = [
                "FETCH_FAILED",
                "INSUFFICIENT_CAPACITY",
                "BUILD_TOOLS_REQUIRED",
                "BUILD_TIMED_OUT",
            ]
            .into_iter()
            .find(|c| message.contains(c))
            .unwrap_or("BUILD_FAILED");
            Pending {
                id: job.id.clone(),
                digest: None,
                error: Some(code.into()),
            }
        }
    };
    write(&pending, &receipt)?;
    cleanup(&job.id);
    post(
        client,
        settings,
        "build-report",
        serde_json::to_value(receipt)?,
    )?;
    fs::remove_file(pending)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_cannot_escape_checkout() {
        for p in [
            "../secret",
            "/etc/passwd",
            "a/../../b",
            ".git/config",
            "a/.git/hooks",
        ] {
            assert!(!safe_path(p));
        }
        for p in [".", "apps/web", "Dockerfile"] {
            assert!(safe_path(p));
        }
    }
    #[test]
    #[ignore = "requires isolated Linux Docker engine and internet"]
    fn docker_source_builds() -> Result<()> {
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicBool, Ordering};
        directory(Path::new(STATE))?;
        directory(&Path::new(STATE).join("builds"))?;
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let server = thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                        let mut bytes = Vec::new();
                        let mut buf = [0; 4096];
                        while let Ok(n) = stream.read(&mut buf) {
                            if n == 0 {
                                break;
                            }
                            bytes.extend_from_slice(&buf[..n]);
                            if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                                let headers =
                                    String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                                let len = headers
                                    .lines()
                                    .find_map(|l| {
                                        l.strip_prefix("content-length:")
                                            .and_then(|v| v.trim().parse::<usize>().ok())
                                    })
                                    .unwrap_or(0);
                                if bytes.len() >= end + 4 + len {
                                    break;
                                }
                            }
                        }
                        let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"active\":true}");
                    }
                    Err(_) => thread::sleep(Duration::from_millis(10)),
                }
            }
        });
        let settings = Settings {
            panel: format!("http://{addr}"),
            credential: "f".repeat(64),
            proxy_image: String::new(),
        };
        let client = health_client()?;
        for automatic in [false, true] {
            let id = if automatic {
                "c".repeat(36)
            } else {
                "d".repeat(36)
            };
            let job = Build {
                id: id.clone(),
                service_id: "e".repeat(36),
                repository: "acme/web".into(),
                sha: "a".repeat(40),
                token: "test-token".into(),
                context: ".".into(),
                dockerfile: "Dockerfile".into(),
                build_type: if automatic {
                    "auto".into()
                } else {
                    "dockerfile".into()
                },
                build_memory_mb: 1024,
                build_cpus: 1.0,
                image: format!("ephor.local/{}:{id}", "e".repeat(36)),
                registry: None,
                variables: BTreeMap::new(),
            };
            validate_build(&job)?;
            cleanup(&id);
            let root = Path::new(STATE).join("builds").join(&id);
            directory(&root)?;
            let source = root.join("source");
            directory(&source)?;
            fs::set_permissions(&source, fs::Permissions::from_mode(0o755))?;
            let config = root.join("docker");
            directory(&config)?;
            write(&config.join("config.json"), &json!({"auths":{}}))?;
            if automatic {
                fs::write(
                    source.join("package.json"),
                    r#"{"name":"ephor-build-test","version":"1.0.0","scripts":{"start":"node server.js"},"engines":{"node":"22"}}"#,
                )?;
                fs::write(
                    source.join("server.js"),
                    "require('http').createServer((req,res)=>res.end('railpack healthy')).listen(process.env.PORT || 3000,'0.0.0.0');",
                )?;
            } else {
                fs::write(
                    source.join("Dockerfile"),
                    "FROM busybox:1.37\nWORKDIR /app\nCOPY index.html .\nCMD [\"httpd\",\"-f\",\"-p\",\"3000\"]\n",
                )?;
                fs::write(source.join("index.html"), "dockerfile healthy")?;
            }
            let mut progress = Progress {
                client: &client,
                settings: &settings,
                job: &job,
                phase: "building",
                logs: Arc::new(Mutex::new(String::new())),
                last: Instant::now(),
            };
            let result = build_image(&mut progress, &root, &source, &config);
            if result.is_err() {
                eprintln!("Build log: {}", progress.logs.lock().unwrap());
            }
            let digest = result?;
            let deploy = Job {
                backup_id: None,
                id: job.id.clone(),
                service_id: job.service_id.clone(),
                domain: None,
                domains: None,
                action: "deploy".into(),
                spec: Spec {
                    volumes: Vec::new(),
                    connections: Vec::new(),
                    catalog: None,
                    image: digest.clone(),
                    port: 3000,
                    health_path: "/".into(),
                    memory_mb: 128,
                    cpus: 0.5,
                    environment: BTreeMap::new(),
                    registry: None,
                },
            };
            assert_eq!(pull(&deploy.spec)?, digest);
            let revision = launch(&deploy, &digest)?;
            for _ in 0..30 {
                if healthy(&client, &revision) {
                    break;
                }
                thread::sleep(Duration::from_millis(500));
            }
            assert!(
                healthy(&client, &revision),
                "Built application should run without root on a read-only filesystem"
            );
            remove(&revision.container)?;
            cleanup(&id);
        }
        stop.store(true, Ordering::Relaxed);
        server.join().unwrap();
        Ok(())
    }
}
