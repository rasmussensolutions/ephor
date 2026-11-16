//! Restic runs in a fixed, digest-pinned container. Only named Ephor volumes are
//! mounted. Credentials travel over the Docker Unix API, never process arguments.
use super::*;
const RESTIC: &str = "docker.io/restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Destination {
    provider: String,
    endpoint: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_key: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task {
    id: String,
    action: String,
    repository: String,
    password: String,
    destination: Destination,
    job: Option<Job>,
    snapshot: Option<String>,
    source_service_id: Option<String>,
    architecture: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Pending {
    task: Task,
    status: String,
    snapshot: Option<String>,
    error: Option<String>,
}
fn pending_path() -> PathBuf {
    Path::new(STATE).join("backup.json")
}
fn safe_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn validate_task(t: &Task) -> Result<()> {
    ensure!(
        id(&t.id) && ["check", "backup", "restore"].contains(&t.action.as_str()),
        "Invalid backup task"
    );
    ensure!(
        t.password.len() == 64 && t.password.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid backup key"
    );
    let parts: Vec<_> = t.repository.split('/').collect();
    ensure!(
        parts.len() == 3
            && parts[0] == "ephor"
            && id(parts[1])
            && (id(parts[2]) || parts[2] == "check"),
        "Invalid repository"
    );
    let d = &t.destination;
    ensure!(
        safe_segment(&d.region) && safe_segment(&d.bucket) && d.bucket.len() >= 3,
        "Invalid storage location"
    );
    for key in [&d.access_key, &d.secret_key] {
        ensure!(
            (8..=256).contains(&key.len()) && key.bytes().all(|b| (33..=126).contains(&b)),
            "Invalid storage credential"
        );
    }
    #[cfg(test)]
    if d.provider == "fixture" {
        ensure!(
            d.endpoint.starts_with("http://172.") && d.endpoint.ends_with(":5000"),
            "Invalid isolated fixture"
        );
        if let Some(job) = &t.job {
            validate(job)?;
        }
        return Ok(());
    }
    let endpoint = reqwest::Url::parse(&d.endpoint)?;
    ensure!(
        endpoint.scheme() == "https"
            && endpoint.username().is_empty()
            && endpoint.password().is_none()
            && endpoint.port().is_none()
            && endpoint.path() == "/"
            && endpoint.query().is_none()
            && endpoint.fragment().is_none(),
        "Invalid storage endpoint"
    );
    let host = endpoint.host_str().context("No storage host")?;
    let expected = match d.provider.as_str() {
        "s3" => format!("s3.{}.amazonaws.com", d.region),
        "b2" => format!("s3.{}.backblazeb2.com", d.region),
        "spaces" => format!("{}.digitaloceanspaces.com", d.region),
        "wasabi" => format!("s3.{}.wasabisys.com", d.region),
        "hetzner" => format!("{}.your-objectstorage.com", d.region),
        "r2" => {
            let account = host
                .strip_suffix(".r2.cloudflarestorage.com")
                .context("Invalid R2 host")?;
            let account = [".eu", ".us", ".fedramp"]
                .iter()
                .find_map(|suffix| account.strip_suffix(suffix))
                .unwrap_or(account);
            ensure!(
                account.len() == 32
                    && account.bytes().all(|b| b.is_ascii_hexdigit())
                    && d.region == "auto",
                "Invalid R2 account"
            );
            host.into()
        }
        _ => anyhow::bail!("Unsupported storage provider"),
    };
    ensure!(host == expected, "Storage endpoint mismatch");
    if t.action != "check" {
        let job = t.job.as_ref().context("No service job")?;
        validate(job)?;
        ensure!(
            t.architecture.as_deref() == Some(std::env::consts::ARCH),
            "Backup architecture mismatch"
        );
        ensure!(
            job.id == t.id
                && job.spec.catalog.is_some()
                && job.action
                    == if t.action == "backup" {
                        "backup"
                    } else {
                        "deploy"
                    },
            "Invalid backup service"
        );
    }
    if t.action == "restore" {
        ensure!(
            t.snapshot
                .as_ref()
                .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                && t.source_service_id.as_ref().is_some_and(|s| id(s)),
            "Invalid snapshot"
        );
    }
    Ok(())
}
fn owner(t: &Task) -> &str {
    t.job
        .as_ref()
        .map_or(t.id.as_str(), |j| j.service_id.as_str())
}
fn helper_name(t: &Task) -> String {
    format!("ephor-restic-{}", t.id)
}
fn staging(t: &Task) -> String {
    format!("ephor-transfer-{}", t.id)
}
fn pull_restic() -> Result<()> {
    let spec = Spec {
        connections: Vec::new(),
        catalog: None,
        image: RESTIC.into(),
        port: 8080,
        health_path: "/".into(),
        memory_mb: 512,
        cpus: 1.0,
        environment: BTreeMap::new(),
        registry: None,
    };
    pull(&spec)?;
    Ok(())
}
fn run(
    t: &Task,
    args: &[&str],
    mounts: Vec<Value>,
    script: Option<&str>,
    manifest: Option<&str>,
) -> Result<String> {
    let name = helper_name(t);
    catalog::remove_owned(&name, owner(t))?;
    let mut env = vec![
        format!(
            "RESTIC_REPOSITORY=s3:{}/{}/{}",
            t.destination.endpoint, t.destination.bucket, t.repository
        ),
        format!("RESTIC_PASSWORD={}", t.password),
        format!("AWS_ACCESS_KEY_ID={}", t.destination.access_key),
        format!("AWS_SECRET_ACCESS_KEY={}", t.destination.secret_key),
        format!("AWS_DEFAULT_REGION={}", t.destination.region),
        "HOME=/tmp".into(),
        "TMPDIR=/tmp".into(),
    ];
    if let Some(m) = manifest {
        env.push(format!("EPHOR_MANIFEST={m}"));
    }
    let (entry, command) = if let Some(s) = script {
        (vec!["/bin/sh"], vec!["-ec", s])
    } else {
        (
            vec!["/usr/bin/restic"],
            [
                vec![
                    "--no-cache",
                    "--retry-lock",
                    "30s",
                    "-o",
                    "s3.bucket-lookup=path",
                ],
                args.to_vec(),
            ]
            .concat(),
        )
    };
    catalog::api(
        reqwest::Method::POST,
        &format!("/containers/create?name={name}"),
        json!({"Image":RESTIC,"User":"0:0","Entrypoint":entry,"Cmd":command,"Env":env,"Labels":{"ephor.managed":"1","ephor.service":owner(t),"ephor.role":"backup-helper"},"HostConfig":{"NetworkMode":if script.is_some(){"none"}else{"bridge"},"ReadonlyRootfs":true,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"Memory":536870912,"MemorySwap":536870912,"NanoCpus":1000000000,"PidsLimit":64,"Tmpfs":{"/tmp":"rw,nosuid,nodev,noexec,size=128m,mode=1777"},"Mounts":mounts,"LogConfig":{"Type":"local","Config":{"max-size":"1m","max-file":"1","compress":"false"}}}}),
    )?;
    let result = (|| {
        d(&["start", &name], 30)?;
        let code = d(&["wait", &name], 7200)?;
        ensure!(code == "0", "Restic operation failed");
        d(&["logs", &name], 30)
    })();
    #[cfg(test)]
    if result.is_err() {
        eprintln!(
            "Restic test command {args:?}, state: {:?}",
            inspect(&name).map(|v| v["State"].clone())
        );
        let _ = Command::new(DOCKER).args(["logs", &name]).status();
    }
    let cleanup = catalog::remove_owned(&name, owner(t));
    let output = result?;
    cleanup?;
    Ok(output)
}
fn ensure_repository(t: &Task) -> Result<()> {
    // Init uses exclusive creation. A wrong password or inaccessible existing repo
    // cannot be replaced: initialization fails and the job is reported as failed.
    if run(t, &["cat", "config"], vec![], None, None).is_err() {
        run(t, &["init"], vec![], None, None)?;
    }
    Ok(())
}
fn snapshot_id(output: &str) -> Result<String> {
    let rows: Vec<Value> = serde_json::from_str(output)?;
    ensure!(rows.len() == 1, "Expected one snapshot");
    let id = rows[0]["id"].as_str().context("Missing snapshot id")?;
    ensure!(
        id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid snapshot id"
    );
    Ok(id.into())
}
fn execute(t: &Task, state: &mut State, settings: &Settings) -> Result<Option<String>> {
    validate_task(t)?;
    pull_restic().context("Pull pinned Restic image")?;
    let sid = owner(t);
    let stage = staging(t);
    catalog::ensure_volume(sid, &stage, "transfer", true)?;
    if t.action == "restore" {
        let snapshot = t.snapshot.as_deref().context("No snapshot")?;
        let manifest: catalog::ExportManifest = serde_json::from_str(&run(
            t,
            &["dump", snapshot, "/data/manifest.json"],
            vec![],
            None,
            None,
        )?)?;
        let job = t.job.as_ref().context("No job")?;
        let source = t.source_service_id.as_deref().context("No source")?;
        catalog::validate_import(job, source, &manifest)?;
        run(
            t,
            &["restore", snapshot, "--target", "/restore", "--verify"],
            vec![catalog::mount(&stage, "/restore", false)],
            None,
            None,
        )?;
        catalog::import(state, settings, job, source, &manifest, &stage)?;
        return Ok(None);
    }
    ensure_repository(t).context("Initialize or open Restic repository")?;
    let (manifest, mut mounts) = if t.action == "backup" {
        let job = t.job.as_ref().context("No job")?;
        // The local snapshot finishes and the app resumes before any upload.
        apply(state, settings, job)?;
        let (m, mounts) = catalog::export(state, &job.service_id, &job.id)?;
        (serde_json::to_string(&m)?, mounts)
    } else {
        (format!("ephor-storage-check:{}", t.id), vec![])
    };
    let directories = mounts
        .iter()
        .filter_map(|m| m["Target"].as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let prepare = format!(
        "mkdir -p /data/volumes {directories}; printf '%s' \"$EPHOR_MANIFEST\" > /data/manifest.json; sync"
    );
    run(
        t,
        &[],
        vec![catalog::mount(&stage, "/data", false)],
        Some(&prepare),
        Some(&manifest),
    )?;
    mounts.insert(0, catalog::mount(&stage, "/data", true));
    run(
        t,
        &["backup", "--quiet", "--host", sid, "--tag", &t.id, "/data"],
        mounts,
        None,
        None,
    )?;
    let snapshot = snapshot_id(&run(
        t,
        &["snapshots", "--json", "--tag", &t.id],
        vec![],
        None,
        None,
    )?)?;
    let retrieved = run(
        t,
        &["dump", &snapshot, "/data/manifest.json"],
        vec![],
        None,
        None,
    )?;
    ensure!(retrieved == manifest, "Backup read-back mismatch");
    // Metadata validation plus a complete data read catches corrupt uploads before success.
    run(t, &["check", "--read-data"], vec![], None, None)?;
    if let Some(job) = &t.job {
        catalog::discard_export(state, &job.service_id, &job.id)?;
    }
    Ok(Some(snapshot))
}
fn cleanup(t: &Task) -> Result<()> {
    catalog::remove_owned(&helper_name(t), owner(t))?;
    let volume = staging(t);
    let r = docker_client()?
        .get(format!("http://localhost/volumes/{volume}"))
        .send()?;
    if r.status().as_u16() != 404 {
        catalog::existing_volume(owner(t), &volume, "transfer")?;
        catalog::api(
            reqwest::Method::DELETE,
            &format!("/volumes/{volume}"),
            Value::Null,
        )?;
    }
    Ok(())
}
fn acknowledge(
    client: &Client,
    settings: &Settings,
    state: &mut State,
    pending: &Pending,
) -> Result<()> {
    post(
        client,
        settings,
        "backup-report",
        json!({"id":pending.task.id,"status":pending.status,"snapshot":pending.snapshot,"error":pending.error}),
    )?;
    if state
        .journal
        .as_ref()
        .is_some_and(|j| j.job.id == pending.task.id)
    {
        state.journal = None;
        save(state)?;
    }
    fs::remove_file(pending_path())?;
    File::open(STATE)?.sync_all()?;
    Ok(())
}
// Called before ordinary deployment recovery. An interrupted off-site operation
// owns its local catalog journal and must never send it as a deployment receipt.
pub(super) fn resume(client: &Client, settings: &Settings, state: &mut State) -> Result<bool> {
    if !pending_path().exists() {
        return Ok(false);
    }
    let mut pending: Pending = read(&pending_path())?;
    validate_task(&pending.task)?;
    if pending.status == "running" {
        if state
            .journal
            .as_ref()
            .is_some_and(|j| j.job.id == pending.task.id && j.status == "applying")
        {
            recover(state, settings, "BACKUP_INTERRUPTED")?;
        }
        pending.status = "failed".into();
        pending.error = Some("BACKUP_INTERRUPTED".into());
        write(&pending_path(), &pending)?;
    }
    for suffix in ["init", "backup", "restore"] {
        catalog::remove_owned(
            &format!("ephor-helper-{}-{suffix}", owner(&pending.task)),
            owner(&pending.task),
        )?;
    }
    cleanup(&pending.task)?;
    acknowledge(client, settings, state, &pending)?;
    Ok(true)
}
pub(super) fn poll(client: &Client, settings: &Settings, state: &mut State) -> Result<bool> {
    let response = post(client, settings, "backup-next", json!({"protocol":5}))?;
    if response["job"].is_null() {
        return Ok(false);
    }
    let parsed: Result<Task, _> = serde_json::from_value(response["job"].clone());
    let task = match parsed {
        Ok(task) if validate_task(&task).is_ok() => task,
        _ => {
            let jid = response["job"]["id"]
                .as_str()
                .filter(|v| id(v))
                .context("Invalid backup identity")?;
            post(
                client,
                settings,
                "backup-report",
                json!({"id":jid,"status":"failed","error":"BACKUP_WORKER_REQUIRED"}),
            )?;
            return Ok(true);
        }
    };
    let mut pending = Pending {
        task,
        status: "running".into(),
        snapshot: None,
        error: None,
    };
    write(&pending_path(), &pending)?;
    match execute(&pending.task, state, settings) {
        Ok(snapshot) => {
            pending.status = "succeeded".into();
            pending.snapshot = snapshot;
        }
        Err(error) => {
            if state
                .journal
                .as_ref()
                .is_some_and(|j| j.job.id == pending.task.id && j.status == "applying")
            {
                recover(state, settings, "BACKUP_APP_FAILED")?;
            }
            pending.status = "failed".into();
            pending.error = Some(
                if error.to_string() == "CATALOG_RECIPE_MISMATCH" {
                    "BACKUP_RECIPE_MISMATCH"
                } else if pending.task.action == "restore" {
                    "BACKUP_RESTORE_FAILED"
                } else if state.journal.as_ref().is_some_and(|j| j.status == "failed") {
                    "BACKUP_APP_FAILED"
                } else {
                    "BACKUP_STORAGE_FAILED"
                }
                .into(),
            );
        }
    }
    write(&pending_path(), &pending)?;
    cleanup(&pending.task)?;
    acknowledge(client, settings, state, &pending)?;
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn task() -> Task {
        Task {
            id: "11111111-1111-4111-8111-111111111111".into(),
            action: "check".into(),
            repository: "ephor/11111111-1111-4111-8111-111111111111/check".into(),
            password: "a".repeat(64),
            destination: Destination {
                provider: "r2".into(),
                endpoint: format!("https://{}.r2.cloudflarestorage.com", "a".repeat(32)),
                region: "auto".into(),
                bucket: "ephor-backups".into(),
                access_key: "test-access-key".into(),
                secret_key: "test-secret-key".into(),
            },
            job: None,
            snapshot: None,
            source_service_id: None,
            architecture: None,
        }
    }
    #[test]
    fn storage_boundary_rejects_hosts_paths_and_commands() {
        let good = task();
        assert!(validate_task(&good).is_ok());
        for jurisdiction in ["eu", "us", "fedramp"] {
            let mut regional = good.clone();
            regional.destination.endpoint = format!(
                "https://{}.{}.r2.cloudflarestorage.com",
                "a".repeat(32),
                jurisdiction
            );
            assert!(validate_task(&regional).is_ok());
        }
        for endpoint in [
            "http://localhost",
            "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.invalid.r2.cloudflarestorage.com",
            "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.eu.r2.cloudflarestorage.com.evil.test",
            "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.eu.us.r2.cloudflarestorage.com",
            "https://169.254.169.254",
            "https://s3.us-east-1.amazonaws.com.evil.test",
            "https://user:pass@s3.us-east-1.amazonaws.com",
            "https://s3.us-east-1.amazonaws.com/path",
        ] {
            let mut t = good.clone();
            t.destination.endpoint = endpoint.into();
            assert!(validate_task(&t).is_err());
        }
        let mut t = good.clone();
        t.repository = "ephor/../../etc".into();
        assert!(validate_task(&t).is_err());
        let mut t = good.clone();
        t.action = "prune".into();
        assert!(validate_task(&t).is_err());
        let mut t = good;
        t.destination.secret_key = "secret\nAWS_CONFIG_FILE=/etc/passwd".into();
        assert!(validate_task(&t).is_err());
    }
    #[test]
    fn snapshot_ids_are_exact_and_unambiguous() {
        assert!(snapshot_id("[]").is_err());
        assert!(snapshot_id("[{\"id\":\"latest\"}]").is_err());
        assert_eq!(
            snapshot_id(&format!("[{{\"id\":\"{}\"}}]", "a".repeat(64))).unwrap(),
            "a".repeat(64)
        );
    }
    #[test]
    #[ignore = "requires isolated Linux Docker engine and internet"]
    fn restic_s3_roundtrip_after_source_loss() {
        root().unwrap();
        directory(Path::new(STATE)).unwrap();
        let uid = || format!("{:032x}0000", rand::random::<u128>());
        let fixture_name = format!("ephor-s3-{}", uid());
        d(
            &[
                "run",
                "-d",
                "--name",
                &fixture_name,
                "motoserver/moto:5.1.21",
            ],
            180,
        )
        .unwrap();
        let address =
            inspect(&fixture_name).unwrap()["NetworkSettings"]["Networks"]["bridge"]["IPAddress"]
                .as_str()
                .unwrap()
                .to_owned();
        let endpoint = format!("http://{address}:5000");
        let mut ready = false;
        for _ in 0..30 {
            if Client::new()
                .get(format!("{endpoint}/"))
                .send()
                .is_ok_and(|r| r.status().is_success())
            {
                ready = true;
                break;
            }
            thread::sleep(Duration::from_secs(1));
        }
        assert!(ready, "S3 fixture did not start");
        let created = Client::new()
            .put(format!("{endpoint}/ephor-backups"))
            .send()
            .unwrap();
        assert!(created.status().is_success(), "Create fixture bucket");
        let mut t = task();
        t.id = uid();
        t.destination = Destination {
            provider: "fixture".into(),
            endpoint,
            region: "us-east-1".into(),
            bucket: "ephor-backups".into(),
            access_key: "ephor-test".into(),
            secret_key: "ephor-test-password".into(),
        };
        let base = super::super::tests::job();
        let settings = Settings {
            panel: "https://unused.example.org".into(),
            credential: "a".repeat(64),
            proxy_image: pull(&Spec {
                image: "docker.io/library/caddy:2.11.9".into(),
                ..base.spec.clone()
            })
            .unwrap(),
        };
        let mut state = State::default();
        execute(&t, &mut state, &settings).expect("Encrypted S3 connection check");
        cleanup(&t).unwrap();
        let defs: Value = serde_json::from_str(include_str!(
            "../../../../packages/api/src/services/catalog/templates.json"
        ))
        .unwrap();
        let recipe = defs["templates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "postgres")
            .unwrap();
        let mut job = base;
        job.id = uid();
        job.service_id = uid();
        job.domain = None;
        job.domains = None;
        job.spec.catalog = Some(
            serde_json::from_value(
                json!({"template":"postgres","version":recipe["version"],"protected":false}),
            )
            .unwrap(),
        );
        job.spec.image = recipe["components"].as_array().unwrap().last().unwrap()["image"]
            .as_str()
            .unwrap()
            .into();
        job.spec.port = 5432;
        job.spec.environment = recipe["secrets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| (v.as_str().unwrap().to_owned(), "a".repeat(64)))
            .collect();
        apply(&mut state, &settings, &job).unwrap();
        state.journal = None;
        save(&state).unwrap();
        let source = job.service_id.clone();
        let container = format!("ephor-app-{source}-database");
        d(&["exec",&container,"psql","-U","ephor","-d","app","-c","CREATE TABLE durable(value text); INSERT INTO durable VALUES ('offsite survives');"],30).unwrap();
        t.id = uid();
        job.id = t.id.clone();
        job.action = "backup".into();
        t.action = "backup".into();
        t.repository = format!("ephor/{}/{}", uid(), uid());
        t.job = Some(job.clone());
        t.architecture = Some(std::env::consts::ARCH.into());
        let snapshot = execute(&t, &mut state, &settings)
            .expect("Off-site backup")
            .unwrap();
        cleanup(&t).unwrap();
        // Destroy the source containers and all source data volumes. Only S3 remains.
        for name in d(
            &[
                "ps",
                "-aq",
                "--filter",
                &format!("label=ephor.service={source}"),
            ],
            30,
        )
        .unwrap()
        .lines()
        {
            d(&["rm", "-f", name], 30).unwrap();
        }
        for name in d(
            &[
                "volume",
                "ls",
                "-q",
                "--filter",
                &format!("label=ephor.service={source}"),
            ],
            30,
        )
        .unwrap()
        .lines()
        {
            d(&["volume", "rm", name], 30).unwrap();
        }
        let mut fresh = State::default();
        save(&fresh).unwrap();
        t.id = uid();
        t.action = "restore".into();
        t.snapshot = Some(snapshot);
        t.source_service_id = Some(source);
        job.id = t.id.clone();
        job.service_id = uid();
        job.action = "deploy".into();
        t.job = Some(job.clone());
        execute(&t, &mut fresh, &settings).expect("Restore from S3 with no original machine state");
        cleanup(&t).unwrap();
        let target = format!("ephor-app-{}-database", job.service_id);
        let rows = d(
            &[
                "exec",
                &target,
                "psql",
                "-U",
                "ephor",
                "-d",
                "app",
                "-tAc",
                "SELECT value FROM durable",
            ],
            30,
        )
        .unwrap();
        assert_eq!(rows, "offsite survives");
        assert!(fresh.services[&job.service_id].active.is_some());
        // Lost panel responses must retry only the durable receipt, never restore again.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let mut reports = Vec::new();
            for status in [500, 200, 200] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut block = [0u8; 4096];
                loop {
                    let n = stream.read(&mut block).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&block[..n]);
                    if let Some(split) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..split]);
                        let size: usize = headers
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse().unwrap())
                            })
                            .unwrap();
                        if bytes.len() >= split + 4 + size {
                            reports.push(
                                serde_json::from_slice::<Value>(
                                    &bytes[split + 4..split + 4 + size],
                                )
                                .unwrap(),
                            );
                            break;
                        }
                    }
                }
                write!(stream,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
            }
            reports
        });
        let reporting = Settings {
            panel: format!("http://{address}"),
            ..settings.clone()
        };
        let receipt = Pending {
            task: t.clone(),
            status: "succeeded".into(),
            snapshot: None,
            error: None,
        };
        write(&pending_path(), &receipt).unwrap();
        let client = Client::new();
        assert!(resume(&client, &reporting, &mut fresh).is_err());
        assert!(pending_path().exists());
        assert!(resume(&client, &reporting, &mut fresh).unwrap());
        assert!(!pending_path().exists());
        assert!(fresh.journal.is_none());
        assert!(fresh.services[&job.service_id].active.is_some());
        // A crash before receiving a completed result is reported as interrupted.
        let interrupted = Pending {
            task: Task {
                id: uid(),
                job: None,
                action: "check".into(),
                ..t.clone()
            },
            status: "running".into(),
            snapshot: None,
            error: None,
        };
        write(&pending_path(), &interrupted).unwrap();
        assert!(resume(&client, &reporting, &mut fresh).unwrap());
        let reports = server.join().unwrap();
        assert_eq!(reports[0], reports[1]);
        assert_eq!(reports[2]["error"], "BACKUP_INTERRUPTED");
        assert_eq!(reports[2]["status"], "failed");

        // An existing service can never be overwritten by replaying a restore.
        assert!(execute(&t, &mut fresh, &settings).is_err());
        d(&["rm", "-f", &fixture_name], 30).unwrap();
    }
}
