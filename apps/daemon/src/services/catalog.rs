//! Reviewed catalog recipes are compiled into the worker. Requests select a recipe;
//! they cannot provide mounts, executable commands, capabilities, images or networks.
use super::*;
use sha2::{Digest, Sha256};

const DEFINITIONS: &str =
    include_str!("../../../../packages/api/src/services/catalog/templates.json");
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Selection {
    template: String,
    version: u32,
    protected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resources: Option<Resources>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resources {
    memory_mb: u32,
    cpus: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    redis_maxmemory_mb: Option<u32>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Definitions {
    helper_image: String,
    templates: Vec<Template>,
}
#[derive(Clone, Deserialize)]
struct Template {
    id: String,
    version: u32,
    web: bool,
    components: Vec<Component>,
    secrets: Vec<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Component {
    id: String,
    image: String,
    port: u16,
    memory_mb: u32,
    cpus: f64,
    user: String,
    environment: BTreeMap<String, String>,
    volumes: Vec<Volume>,
    health: Vec<String>,
    command: Vec<String>,
    capabilities: Vec<String>,
    tmpfs: BTreeMap<String, String>,
    internal: bool,
}
#[derive(Clone, Deserialize)]
struct Volume {
    key: String,
    target: String,
    uid: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Backup {
    id: String,
    created_at: u64,
    volumes: BTreeMap<String, String>,
    #[serde(default)]
    spec: Option<Spec>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct App {
    job: Job,
    recipe_hash: String,
    provisioned: bool,
    volumes: BTreeMap<String, String>,
    #[serde(default)]
    detached_volumes: BTreeMap<String, String>,
    #[serde(default)]
    uninitialized_volumes: std::collections::BTreeSet<String>,
    backups: Vec<Backup>,
    port: u16,
    access_hash: String,
    pub(super) recovery_required: bool,
}
fn definitions() -> Result<Definitions> {
    Ok(serde_json::from_str(DEFINITIONS)?)
}
fn recipe(job: &Job) -> Result<Template> {
    if job.spec.custom_storage() {
        validate_volumes(&job.spec)?;
        return Ok(Template {
            id: "custom".into(),
            version: 1,
            web: true,
            secrets: vec![],
            components: vec![Component {
                id: "web".into(),
                image: job.spec.image.clone(),
                port: job.spec.port,
                memory_mb: job.spec.memory_mb,
                cpus: job.spec.cpus,
                user: "65532:65532".into(),
                environment: job.spec.environment.clone(),
                volumes: job
                    .spec
                    .volumes
                    .iter()
                    .map(|v| Volume {
                        key: v.name.clone(),
                        target: v.mount_path.clone(),
                        uid: 65532,
                    })
                    .collect(),
                health: vec!["NONE".into()],
                command: vec![],
                capabilities: vec![],
                tmpfs: BTreeMap::new(),
                internal: false,
            }],
        });
    }
    let selection = job.spec.catalog.as_ref().context("Not a catalog app")?;
    definitions()?
        .templates
        .into_iter()
        .find(|t| t.id == selection.template && t.version == selection.version)
        .context("CATALOG_WORKER_REQUIRED")
}
fn raw_recipe(t: &Template) -> Value {
    if t.id == "custom" {
        return json!({"customStorageVersion":1,"volumes":t.components[0].volumes.iter().map(|v| json!({"name":v.key,"mountPath":v.target})).collect::<Vec<_>>()});
    }
    let value: Value = serde_json::from_str(DEFINITIONS).expect("Compiled catalog JSON");
    value["templates"]
        .as_array()
        .expect("templates")
        .iter()
        .find(|v| v["id"] == t.id && v["version"] == t.version)
        .expect("template")
        .clone()
}
fn hash_recipe(raw: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(raw).expect("recipe"))
    )
}
fn runtime_recipe_hash(mut raw: Value) -> String {
    // Presentation changes must not invalidate deployed data or remote backups.
    // Retain every other field, including unknown future operational fields.
    for key in ["name", "category", "description", "technology", "notes"] {
        raw.as_object_mut().expect("template object").remove(key);
    }
    hash_recipe(&raw)
}
fn recipe_hash(t: &Template) -> String {
    runtime_recipe_hash(raw_recipe(t))
}
fn compatible_recipe_hash(saved: &str, t: &Template) -> bool {
    let mut raw = raw_recipe(t);
    if saved == recipe_hash(t) || saved == hash_recipe(&raw) {
        return true;
    }
    // The initial Uptime Kuma recipe used no technology icon. Accept that
    // historical fingerprint only when every operational field still matches.
    if t.id == "uptime-kuma" && t.version == 1 {
        raw["technology"] = Value::Null;
        return saved == hash_recipe(&raw);
    }
    false
}
pub(super) fn validate(job: &Job) -> Result<()> {
    let t = recipe(job)?;
    if let Some(r) = job.spec.catalog.as_ref().and_then(|c| c.resources.as_ref()) {
        ensure!(
            ["postgres", "redis", "qdrant"].contains(&t.id.as_str())
                && (128..=65536).contains(&r.memory_mb)
                && r.cpus.is_finite()
                && (0.1..=32.0).contains(&r.cpus),
            "Invalid database resources"
        );
        ensure!(
            if t.id == "redis" {
                r.redis_maxmemory_mb
                    .is_some_and(|m| m >= 16 && m <= r.memory_mb * 3 / 4)
            } else {
                r.redis_maxmemory_mb.is_none()
            },
            "Invalid Redis memory limit"
        );
    }
    ensure!(
        t.components.len() <= 8 && !t.components.is_empty(),
        "Invalid template"
    );
    ensure!(
        job.spec.image == t.components.last().context("No main component")?.image
            && (t.id == "custom" || job.spec.registry.is_none()),
        "Catalog image override rejected"
    );
    ensure!(
        t.id == "custom"
            || (job.spec.environment.len() == t.secrets.len()
                && t.secrets.iter().all(|k| job
                    .spec
                    .environment
                    .get(k)
                    .is_some_and(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())))),
        "Invalid catalog secrets"
    );
    ensure!(
        if t.id == "custom" {
            true
        } else if t.web {
            job.domain.is_some()
        } else {
            job.domain.is_none()
        },
        "Invalid catalog domain"
    );
    ensure!(
        ["deploy", "stop", "backup", "restore", "delete-backup"].contains(&job.action.as_str()),
        "Stateful rollback is prohibited"
    );
    if ["restore", "delete-backup"].contains(&job.action.as_str()) {
        ensure!(
            job.backup_id.as_ref().is_some_and(|v| id(v)),
            "Invalid backup identity"
        );
    }
    Ok(())
}
fn name(sid: &str, component: &str) -> String {
    format!("ephor-app-{sid}-{component}")
}
fn network(sid: &str, private: bool) -> String {
    format!(
        "ephor-app-{sid}-{}",
        if private { "private" } else { "egress" }
    )
}
// Join only the selected standalone database's managed network. Container names
// are globally unique, so two PostgreSQL connections cannot collide in DNS.
pub(super) fn connect(container: &str, connection: &Connection) -> Result<()> {
    let sid = &connection.service_id;
    let component = match connection.template.as_str() {
        "postgres" => "database",
        "redis" => "redis",
        "qdrant" => "qdrant",
        _ => anyhow::bail!("Unsupported service connection"),
    };
    let target = inspect(&name(sid, component))?;
    verify_labels(&target["Config"]["Labels"], sid, "component")?;
    ensure!(
        target["State"]["Running"] == true,
        "Connected database is not running"
    );
    let n = network(sid, false);
    let response = docker_client()?
        .get(format!("http://localhost/networks/{n}"))
        .send()?;
    ensure!(
        response.status().is_success(),
        "Connection network unavailable"
    );
    let info: Value = response.json()?;
    verify_labels(&info["Labels"], sid, "network")?;
    ensure!(
        info["Driver"] == "bridge" && info["Internal"] == false,
        "Connection network policy mismatch"
    );
    api(
        reqwest::Method::POST,
        &format!("/networks/{n}/connect"),
        json!({"Container":container,"EndpointConfig":{}}),
    )?;
    Ok(())
}
fn volume_name(sid: &str, generation: &str, key: &str) -> String {
    format!("ephor-data-{sid}-{generation}-{key}")
}
fn labels(sid: &str, role: &str) -> Value {
    json!({"ephor.managed":"1","ephor.service":sid,"ephor.role":role})
}
fn verify_labels(v: &Value, sid: &str, role: &str) -> Result<()> {
    ensure!(
        v["ephor.managed"] == "1" && v["ephor.service"] == sid && v["ephor.role"] == role,
        "Foreign resource collision"
    );
    Ok(())
}
pub(super) fn api(method: reqwest::Method, path: &str, body: Value) -> Result<Value> {
    let r = docker_client()?
        .request(method, format!("http://localhost{path}"))
        .json(&body)
        .send()?;
    ensure!(r.status().is_success(), "Docker catalog operation rejected");
    let mut bytes = Vec::new();
    r.take(1_048_577).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 1_048_576, "Docker response too large");
    if bytes.is_empty() {
        Ok(Value::Null)
    } else {
        Ok(serde_json::from_slice(&bytes)?)
    }
}
fn ensure_network(sid: &str, private: bool) -> Result<()> {
    let n = network(sid, private);
    match docker_client()?
        .get(format!("http://localhost/networks/{n}"))
        .send()?
    {
        r if r.status().is_success() => {
            let v: Value = r.json()?;
            verify_labels(&v["Labels"], sid, "network")?;
            ensure!(
                v["Internal"] == private && v["Driver"] == "bridge",
                "Network policy mismatch"
            );
        }
        r if r.status().as_u16() == 404 => {
            api(
                reqwest::Method::POST,
                "/networks/create",
                json!({"Name":n,"Driver":"bridge","Internal":private,"Labels":labels(sid,"network")}),
            )?;
        }
        _ => anyhow::bail!("Cannot inspect network"),
    }
    Ok(())
}
pub(super) fn ensure_volume(sid: &str, n: &str, role: &str, new: bool) -> Result<bool> {
    let r = docker_client()?
        .get(format!("http://localhost/volumes/{n}"))
        .send()?;
    if r.status().is_success() {
        let v: Value = r.json()?;
        verify_labels(&v["Labels"], sid, role)?;
        ensure!(
            v["Driver"] == "local" && v["Options"].as_object().is_none_or(|o| o.is_empty()),
            "Unsafe volume driver/options"
        );
        ensure!(!new, "Volume already exists");
        return Ok(false);
    }
    ensure!(r.status().as_u16() == 404, "Cannot inspect volume");
    api(
        reqwest::Method::POST,
        "/volumes/create",
        json!({"Name":n,"Driver":"local","Labels":labels(sid,role)}),
    )?;
    Ok(true)
}
pub(super) fn existing_volume(sid: &str, n: &str, role: &str) -> Result<()> {
    let v = api(reqwest::Method::GET, &format!("/volumes/{n}"), Value::Null)?;
    verify_labels(&v["Labels"], sid, role)?;
    ensure!(
        v["Driver"] == "local" && v["Options"].as_object().is_none_or(|o| o.is_empty()),
        "Unsafe volume"
    );
    Ok(())
}
pub(super) fn mount(source: &str, target: &str, readonly: bool) -> Value {
    json!({"Type":"volume","Source":source,"Target":target,"ReadOnly":readonly,"VolumeOptions":{"NoCopy":true}})
}
pub(super) fn helper(
    sid: &str,
    suffix: &str,
    mounts: Vec<Value>,
    command: Vec<String>,
    seconds: u64,
) -> Result<()> {
    let n = format!("ephor-helper-{sid}-{suffix}");
    remove_owned(&n, sid)?;
    let body = json!({"Image":definitions()?.helper_image,"User":"0:0","Cmd":command,"Labels":labels(sid,"helper"),"HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"CapDrop":["ALL"],"CapAdd":["CHOWN","DAC_OVERRIDE","FOWNER"],"SecurityOpt":["no-new-privileges"],"Memory":67108864,"MemorySwap":67108864,"NanoCpus":500000000,"PidsLimit":32,"Mounts":mounts,"LogConfig":{"Type":"none"}}});
    // Test fixtures contain synthetic data; production storage helpers never log it.
    #[cfg(test)]
    let body = {
        let mut body = body;
        body["HostConfig"]["LogConfig"] = json!({"Type":"local"});
        body
    };
    api(
        reqwest::Method::POST,
        &format!("/containers/create?name={n}"),
        body,
    )?;
    let result = (|| -> Result<()> {
        d(&["start", &n], 30)?;
        let code = d(&["wait", &n], seconds)?;
        #[cfg(test)]
        if code != "0" {
            eprintln!(
                "Storage test helper {suffix} exited {code}: {:?}\n{}",
                inspect(&n).map(|v| v["State"].clone()),
                logs(&n).unwrap_or_default()
            );
        }
        ensure!(code == "0", "Storage operation failed");
        Ok(())
    })();
    let cleanup = remove_owned(&n, sid);
    result.and(cleanup)
}
pub(super) fn remove_owned(n: &str, sid: &str) -> Result<()> {
    let r = docker_client()?
        .get(format!("http://localhost/containers/{n}/json"))
        .send()?;
    if r.status().as_u16() == 404 {
        return Ok(());
    }
    ensure!(r.status().is_success(), "Cannot inspect managed container");
    let v: Value = r.json()?;
    ensure!(
        v["Config"]["Labels"]["ephor.managed"] == "1"
            && v["Config"]["Labels"]["ephor.service"] == sid,
        "Foreign container collision"
    );
    d(&["rm", "-f", n], 30)?;
    Ok(())
}
fn config(job: &Job, c: &Component, app: &App) -> Result<Value> {
    let sid = &job.service_id;
    let mut env = c.environment.clone();
    if job.spec.custom_storage() {
        env.entry("PORT".into())
            .or_insert(job.spec.port.to_string());
        env.entry("HOST".into()).or_insert("0.0.0.0".into());
    }
    for value in env.values_mut().filter(|_| !job.spec.custom_storage()) {
        for (key, secret) in &job.spec.environment {
            *value = value.replace(&format!("${{{key}}}"), secret);
        }
    }
    let n = network(sid, c.internal);
    let port = format!("{}/tcp", c.port);
    let t = recipe(job)?;
    let main = t.components.last().context("No main component")?.id == c.id;
    let mounts = c
        .volumes
        .iter()
        .map(|v| mount(&app.volumes[&v.key], &v.target, false))
        .collect::<Vec<_>>();
    let mut tmpfs = c.tmpfs.clone();
    tmpfs.insert("/tmp".into(), "rw,nosuid,size=128m,mode=1777".into());
    let mut body = json!({"Image":if c.image.starts_with("ephor.local/") {c.image.split_once('@').map(|(_,d)|d).unwrap_or(&c.image)} else {&c.image},"User":c.user,"Env":env.iter().map(|(k,v)|format!("{k}={v}")).collect::<Vec<_>>(),"Labels":labels(sid,"component"),"Healthcheck":{"Test":c.health,"Interval":5_000_000_000_u64,"Timeout":3_000_000_000_u64,"Retries":3,"StartPeriod":20_000_000_000_u64},"HostConfig":{"NetworkMode":n,"RestartPolicy":{"Name":"unless-stopped"},"ReadonlyRootfs":true,"CapDrop":["ALL"],"CapAdd":c.capabilities,"SecurityOpt":["no-new-privileges"],"Tmpfs":tmpfs,"Mounts":mounts,"Memory":u64::from(c.memory_mb)*1024*1024,"MemorySwap":u64::from(c.memory_mb)*1024*1024,"NanoCpus":(c.cpus*1e9) as u64,"PidsLimit":256,"LogConfig":{"Type":"local","Config":{"max-size":"10m","max-file":"3"}}},"NetworkingConfig":{"EndpointsConfig":{n:{"Aliases":[c.id]}}}});
    if job.spec.custom_storage() {
        body["HostConfig"]["Init"] = json!(true);
    }
    if let Some(r) = job.spec.catalog.as_ref().and_then(|c| c.resources.as_ref()) {
        body["HostConfig"]["Memory"] = json!(u64::from(r.memory_mb) * 1024 * 1024);
        body["HostConfig"]["MemorySwap"] = body["HostConfig"]["Memory"].clone();
        body["HostConfig"]["NanoCpus"] = json!((r.cpus * 1e9) as u64);
    }
    if !c.command.is_empty() {
        body["Cmd"] = json!(c.command);
        if let Some(m) = job
            .spec
            .catalog
            .as_ref()
            .and_then(|c| c.resources.as_ref())
            .and_then(|r| r.redis_maxmemory_mb)
        {
            body["Cmd"] = json!(
                c.command
                    .iter()
                    .map(|s| s.replace("--maxmemory 96mb", &format!("--maxmemory {m}mb")))
                    .collect::<Vec<_>>()
            );
        }
    }
    if main {
        body["HostConfig"]["PortBindings"] =
            json!({port.clone():[{"HostIp":"127.0.0.1","HostPort":app.port.to_string()}]});
        body["ExposedPorts"] = json!({port:{}});
    }
    Ok(body)
}
fn stop_components(sid: &str, t: &Template, require_clean: bool) -> Result<()> {
    for c in t.components.iter().rev() {
        let n = name(sid, &c.id);
        let r = docker_client()?
            .get(format!("http://localhost/containers/{n}/json"))
            .send()?;
        if r.status().as_u16() == 404 {
            continue;
        }
        ensure!(r.status().is_success(), "Cannot inspect component");
        let v: Value = r.json()?;
        verify_labels(&v["Config"]["Labels"], sid, "component")?;
        // Disable auto-restart before mutation, including host reboot mid-restore.
        api(
            reqwest::Method::POST,
            &format!("/containers/{n}/update"),
            json!({"RestartPolicy":{"Name":"no"}}),
        )?;
        let was_running = v["State"]["Running"] == true;
        if was_running {
            d(&["stop", "--time", "60", &n], 75)?;
        }
        let v = inspect(&n)?;
        ensure!(
            v["State"]["Running"] == false
                && (!require_clean || !was_running || v["State"]["ExitCode"] != 137),
            "Component did not stop cleanly; backup aborted"
        );
    }
    Ok(())
}
fn start_components(job: &Job, app: &App, t: &Template) -> Result<()> {
    let sid = &job.service_id;
    for c in &t.components {
        let n = name(sid, &c.id);
        remove_owned(&n, sid)?;
        api(
            reqwest::Method::POST,
            &format!("/containers/create?name={n}"),
            config(job, c, app)?,
        )?;
        if !c.internal {
            api(
                reqwest::Method::POST,
                &format!("/networks/{}/connect", network(sid, true)),
                json!({"Container":n,"EndpointConfig":{"Aliases":[c.id]}}),
            )?;
        }
        for connection in &job.spec.connections {
            connect(&n, connection)?;
        }
        d(&["start", &n], 30)?;
        let start = Instant::now();
        let mut passes = 0;
        while start.elapsed() < Duration::from_secs(180) {
            let v = inspect(&n)?;
            if component_healthy(job, app, c, &v) {
                passes += 1;
            } else {
                passes = 0;
            }
            if passes >= 3 {
                break;
            }
            thread::sleep(Duration::from_secs(2));
        }
        ensure!(passes >= 3, "HEALTH_CHECK_FAILED");
    }
    Ok(())
}
fn cold_backup(sid: &str, app: &mut App, backup_id: &str) -> Result<()> {
    ensure!(app.backups.len() < 20, "BACKUP_LIMIT");
    let mut volumes = BTreeMap::new();
    for (key, src) in &app.volumes {
        existing_volume(sid, src, "data")?;
        let dst = format!("ephor-backup-{sid}-{backup_id}-{key}");
        ensure_volume(sid, &dst, "backup", true)?;
        // Require free space for the uncompressed archive plus 1 GiB. Pipeline-free tar
        // and checksum failures abort without publishing an incomplete backup record.
        helper(sid,"backup",vec![mount(src,"/source",true),mount(&dst,"/backup",false)],vec!["sh".into(),"-ec".into(),"needed=$(du -sk /source | cut -f1); available=$(df -Pk /backup | tail -1 | awk '{print $4}'); test \"$available\" -gt $((needed + 1048576)); tar -cpf /backup/data.tar -C /source .; cd /backup; sha256sum data.tar > SHA256SUMS; sync; sha256sum -c SHA256SUMS".into()],1800)?;
        volumes.insert(key.clone(), dst);
    }
    app.backups.push(Backup {
        spec: Some(app.job.spec.clone()),
        id: backup_id.into(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as u64,
        volumes,
    });
    Ok(())
}
fn revision(job: &Job, app: &App, t: &Template) -> Revision {
    let main = t.components.last().expect("main");
    Revision {
        job: job.clone(),
        container: name(&job.service_id, &main.id),
        digest: main.image.clone(),
        port: app.port,
    }
}
// Volume names are stable identities. Detaching never deletes data, and changing
// a mount path must not allocate an empty replacement for an existing name.
fn plan_storage(app: &mut App, job: &Job) {
    let old = std::mem::take(&mut app.volumes);
    app.detached_volumes.extend(old);
    for volume in &job.spec.volumes {
        let name = app
            .detached_volumes
            .remove(&volume.name)
            .unwrap_or_else(|| {
                let name = volume_name(&job.service_id, &job.id, &volume.name);
                app.uninitialized_volumes.insert(name.clone());
                name
            });
        app.volumes.insert(volume.name.clone(), name);
    }
}
fn provision_volumes(state: &mut State, app: &mut App, t: &Template) -> Result<()> {
    let sid = app.job.service_id.clone();
    if !app.provisioned {
        app.uninitialized_volumes
            .extend(app.volumes.values().cloned());
        app.provisioned = true;
    }
    state.services.get_mut(&sid).context("No service")?.app = Some(app.clone());
    save(state)?;
    for c in &t.components {
        for v in &c.volumes {
            let n = app
                .volumes
                .get(&v.key)
                .context("Missing volume mapping")?
                .clone();
            if app.uninitialized_volumes.contains(&n) {
                ensure_volume(&sid, &n, "data", false)?;
                helper(
                    &sid,
                    "init",
                    vec![mount(&n, "/data", false)],
                    vec![
                        "chown".into(),
                        format!("{}:{}", v.uid, v.uid),
                        "/data".into(),
                    ],
                    30,
                )?;
                app.uninitialized_volumes.remove(&n);
                state.services.get_mut(&sid).context("No service")?.app = Some(app.clone());
                save(state)?;
            } else {
                existing_volume(&sid, &n, "data")?;
            }
        }
    }
    Ok(())
}
fn stop_legacy(state: &State, sid: &str) -> Result<()> {
    if let Some(old) = state
        .journal
        .as_ref()
        .map(|j| &j.old)
        .filter(|s| s.app.is_none())
    {
        for revision in old.active.iter().chain(old.previous.iter()) {
            let response = docker_client()?
                .get(format!(
                    "http://localhost/containers/{}/json",
                    revision.container
                ))
                .send()?;
            if response.status().as_u16() == 404 {
                continue;
            }
            ensure!(
                response.status().is_success(),
                "Cannot inspect previous container"
            );
            let info: Value = response.json()?;
            ensure!(
                info["Config"]["Labels"]["ephor.managed"] == "1"
                    && info["Config"]["Labels"]["ephor.service"] == sid,
                "Foreign container collision"
            );
            api(
                reqwest::Method::POST,
                &format!("/containers/{}/update", revision.container),
                json!({"RestartPolicy":{"Name":"no"}}),
            )?;
            if info["State"]["Running"] == true {
                d(&["stop", "--time", "30", &revision.container], 40)?;
            }
            // Ownership is checked before deleting an obsolete stateless container.
            remove_owned(&revision.container, sid)?;
        }
    }
    Ok(())
}
pub(super) fn apply(state: &mut State, settings: &Settings, job: &Job) -> Result<()> {
    // Resolve a custom image to an immutable identity before persisting its state.
    let mut pinned = job.clone();
    if pinned.spec.custom_storage() && job.action != "stop" {
        pinned.spec.image = pull(&pinned.spec).context("IMAGE_PULL_FAILED")?;
    }
    let job = &pinned;
    let t = recipe(job)?;
    let sid = &job.service_id;
    ensure!(
        d(&["version", "--format", "{{.Server.Version}}"], 15)?
            .split('.')
            .next()
            .and_then(|v| v.parse::<u32>().ok())
            .is_some_and(|v| v >= 28),
        "DOCKER_VERSION_REQUIRED"
    );
    let existing = state.services.get(sid).and_then(|s| s.app.clone());
    ensure!(
        (t.id == "custom" && job.action == "deploy" && job.spec.storage_version == Some(1))
            || existing.is_some()
            || state
                .services
                .get(sid)
                .is_none_or(|s| s.active.is_none() && s.previous.is_none()),
        "Cannot convert a deployed stateless service in place"
    );
    if let Some(app) = &existing {
        if t.id == "custom" && !["deploy", "import"].contains(&job.action.as_str()) {
            ensure!(
                !app.recovery_required || job.action == "stop",
                "CATALOG_RECOVERY_REQUIRED"
            );
            ensure!(
                app.job.spec.image == job.spec.image
                    && app.job.spec.environment == job.spec.environment,
                "Deployed configuration changed; recover explicitly"
            );
        }
        ensure!(
            (compatible_recipe_hash(&app.recipe_hash, &t)
                || (t.id == "custom"
                    && app.job.spec.catalog.is_none()
                    && job.action == "deploy"
                    && job.spec.storage_version == Some(1)))
                && (t.id == "custom" || app.job.spec.environment == job.spec.environment),
            "CATALOG_RECIPE_MISMATCH"
        );
    }
    if job.action == "delete-backup" {
        let mut app = existing.context("No app")?;
        let bid = job.backup_id.as_ref().context("No backup")?;
        let b = app
            .backups
            .iter()
            .find(|b| &b.id == bid)
            .context("Backup not found")?
            .clone();
        // Remove the index first. A crash can leave an orphaned snapshot, never a restorable partial one.
        app.backups.retain(|b| &b.id != bid);
        state.services.get_mut(sid).context("No service")?.app = Some(app);
        save(state)?;
        for n in b.volumes.values() {
            existing_volume(sid, n, "backup")?;
            api(
                reqwest::Method::DELETE,
                &format!("/volumes/{n}"),
                Value::Null,
            )?;
        }
        return finish(state, None);
    }
    // Resolve all downloads and capacity before removing traffic or stopping an app.
    if job.action != "stop" {
        let mut system = sysinfo::System::new();
        system.refresh_memory();
        let requested = job
            .spec
            .catalog
            .as_ref()
            .and_then(|c| c.resources.as_ref())
            .map_or_else(
                || {
                    t.components
                        .iter()
                        .map(|c| u64::from(c.memory_mb))
                        .sum::<u64>()
                },
                |r| u64::from(r.memory_mb),
            );
        let previous = existing
            .as_ref()
            .map_or(0, |a| u64::from(a.job.spec.memory_mb));
        ensure!(
            system.available_memory()
                > requested.saturating_sub(previous) * 1024 * 1024 + 128 * 1024 * 1024,
            "INSUFFICIENT_CAPACITY"
        );
        if existing.is_none() {
            ensure!(
                system.available_memory()
                    > t.components
                        .iter()
                        .map(|c| u64::from(c.memory_mb) * 1024 * 1024)
                        .sum::<u64>()
                        + 128 * 1024 * 1024,
                "INSUFFICIENT_CAPACITY"
            );
        }
        for c in &t.components {
            let mut s = job.spec.clone();
            s.catalog = None;
            s.image = c.image.clone();
            pull(&s).context("IMAGE_PULL_FAILED")?;
        }
        let mut s = job.spec.clone();
        s.catalog = None;
        s.image = definitions()?.helper_image;
        pull(&s).context("IMAGE_PULL_FAILED")?;
    }
    let mut app = if let Some(app) = existing {
        app
    } else {
        ensure!(job.action == "deploy", "App has not been deployed");
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        App {
            job: job.clone(),
            recipe_hash: recipe_hash(&t),
            provisioned: false,
            volumes: t
                .components
                .iter()
                .flat_map(|c| {
                    c.volumes
                        .iter()
                        .map(|v| (v.key.clone(), volume_name(sid, &job.id, &v.key)))
                })
                .collect(),
            detached_volumes: BTreeMap::new(),
            uninitialized_volumes: Default::default(),
            backups: vec![],
            port: listener.local_addr()?.port(),
            access_hash: if t.web && t.id != "custom" {
                bcrypt::hash(&job.spec.environment["ACCESS_PASSWORD"], 12)?
            } else {
                String::new()
            },
            recovery_required: false,
        }
    };
    let old_template = recipe(&app.job)?;
    let needs_backup = ["backup", "restore"].contains(&job.action.as_str())
        || (job.action == "deploy" && app.provisioned);
    if needs_backup {
        ensure!(app.backups.len() < 20, "BACKUP_LIMIT");
    }
    let restore = if job.action == "restore" {
        Some(
            app.backups
                .iter()
                .find(|b| Some(&b.id) == job.backup_id.as_ref())
                .context("Backup not found")?
                .clone(),
        )
    } else {
        None
    };
    if let Some(ref snapshot) = restore {
        if t.id == "custom" {
            ensure!(
                snapshot
                    .spec
                    .as_ref()
                    .is_some_and(|s| s.image == job.spec.image
                        && s.environment == job.spec.environment
                        && s.volumes == job.spec.volumes),
                "Restore this snapshot into a separate service; current image, variables or storage differ"
            );
        }
        ensure!(
            snapshot.volumes.keys().eq(app.volumes.keys()),
            "Backup volume mismatch"
        );
    }
    let was_running = state.services.get(sid).is_some_and(|s| s.active.is_some());
    // Persist the full plan before resource creation. Failed or interrupted stateful
    // operations are stopped and explicitly resumed; data is never auto-rolled back.
    app.recovery_required = true;
    let saved = state.services.entry(sid.clone()).or_default();
    saved.previous = saved.active.take().or(saved.previous.take());
    saved.app = Some(app.clone());
    save(state)?;
    proxy(state, settings)?;
    stop_legacy(state, sid)?;
    stop_components(sid, &old_template, job.action != "stop")?;
    if job.action == "stop" {
        app.recovery_required = false;
        state.services.get_mut(sid).context("No service")?.app = Some(app);
        return finish(state, None);
    }
    ensure_network(sid, true)?;
    ensure_network(sid, false)?;
    provision_volumes(state, &mut app, &old_template)?;
    if needs_backup {
        cold_backup(sid, &mut app, &job.id).context("BACKUP_FAILED")?;
        state.services.get_mut(sid).context("No service")?.app = Some(app.clone());
        save(state)?;
    }
    if t.id == "custom" && job.action == "deploy" {
        plan_storage(&mut app, job);
        app.job = job.clone();
        app.recipe_hash = recipe_hash(&t);
        // Save the exact allocation plan before creating any new volumes. Retries
        // initialize only explicitly new volumes, never recreate missing old data.
        provision_volumes(state, &mut app, &t)?;
    }
    if let Some(backup) = restore {
        let mut restored = BTreeMap::new();
        for (key, src) in &backup.volumes {
            existing_volume(sid, src, "backup")?;
            let dst = volume_name(sid, &job.id, key);
            ensure_volume(sid, &dst, "data", true)?;
            helper(
                sid,
                "restore",
                vec![mount(src, "/backup", true), mount(&dst, "/target", false)],
                vec![
                    "sh".into(),
                    "-ec".into(),
                    "cd /backup; sha256sum -c SHA256SUMS; needed=$(du -k data.tar | cut -f1); available=$(df -Pk /target | tail -1 | awk '{print $4}'); test \"$available\" -gt $((needed + 1048576)); tar -xpf data.tar -C /target; sync"
                        .into(),
                ],
                1800,
            )?;
            restored.insert(key.clone(), dst);
        }
        ensure!(
            restored.keys().eq(app.volumes.keys()),
            "Backup volume mismatch"
        );
        app.volumes = restored;
        state.services.get_mut(sid).context("No service")?.app = Some(app.clone());
        save(state)?;
    }
    app.job = job.clone();
    app.recipe_hash = recipe_hash(&t);
    state.services.get_mut(sid).context("No service")?.app = Some(app.clone());
    save(state)?;
    if job.action != "backup" || was_running {
        start_components(job, &app, &t)?;
        let r = revision(job, &app, &t);
        state.services.get_mut(sid).context("No service")?.active = Some(r);
        state.services.get_mut(sid).context("No service")?.app = Some(app.clone());
        proxy(state, settings)?;
    }
    app.recovery_required = false;
    state.services.get_mut(sid).context("No service")?.app = Some(app);
    finish(
        state,
        if job.action == "backup" {
            None
        } else {
            Some(t.components.last().context("No main")?.image.clone())
        },
    )
}
fn finish(state: &mut State, digest: Option<String>) -> Result<()> {
    let j = state.journal.as_mut().context("No journal")?;
    j.status = "succeeded".into();
    j.digest = digest;
    save(state)
}
pub(super) fn recover(
    state: &mut State,
    settings: &Settings,
    job: &Job,
    error: &str,
) -> Result<()> {
    // If preparation failed before mutation, leave the old app online.
    if state
        .services
        .get(&job.service_id)
        .and_then(|s| s.app.as_ref())
        .is_some_and(|a| a.recovery_required)
    {
        let s = state
            .services
            .get_mut(&job.service_id)
            .context("No service")?;
        s.previous = s.active.take().or(s.previous.take());
        save(state)?;
        proxy(state, settings)?;
        stop_legacy(state, &job.service_id)?;
        for suffix in ["init", "backup", "restore"] {
            remove_owned(
                &format!("ephor-helper-{}-{suffix}", job.service_id),
                &job.service_id,
            )?;
        }
        stop_components(&job.service_id, &recipe(job)?, false)?;
    }
    let j = state.journal.as_mut().context("No journal")?;
    j.status = "failed".into();
    j.error = Some(error.into());
    save(state)
}
fn component_healthy(job: &Job, app: &App, c: &Component, info: &Value) -> bool {
    if info["State"]["Running"] != true {
        return false;
    }
    if job.spec.custom_storage()
        || job
            .spec
            .catalog
            .as_ref()
            .is_some_and(|s| s.template == "qdrant")
    {
        let path = if c.id == "qdrant" {
            "/readyz"
        } else {
            &job.spec.health_path
        };
        return health_client().is_ok_and(|client| {
            client
                .get(format!("http://127.0.0.1:{}{}", app.port, path))
                .send()
                .is_ok_and(|r| r.status().is_success())
        });
    }
    info["State"]["Health"]["Status"] == "healthy"
}
pub(super) fn healthy(app: &App) -> bool {
    recipe(&app.job).is_ok_and(|t| {
        t.components.iter().all(|c| {
            inspect(&name(&app.job.service_id, &c.id))
                .is_ok_and(|v| component_healthy(&app.job, app, c, &v))
        })
    })
}
pub(super) fn access(app: &App) -> Option<Value> {
    app.job.spec.catalog.as_ref().filter(|s|s.protected).map(|_|json!({"handler":"authentication","providers":{"http_basic":{"accounts":[{"username":"admin","password":app.access_hash}]}}}))
}
// Bound the complete report, preserving UTF-8 and redacting before truncation.
fn report_logs(mut text: String, secrets: &BTreeMap<String, String>, limit: usize) -> String {
    let mut values = secrets
        .values()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    values.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for value in values {
        text = text.replace(value, "[redacted]");
    }
    text = text
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    if text.len() > limit {
        let mut offset = text.len() - limit;
        while !text.is_char_boundary(offset) {
            offset += 1;
        }
        text = text[offset..].into();
    }
    text
}
pub(super) fn telemetry(
    app: &App,
    collector: &mut metrics::Collector,
    active: bool,
) -> Result<(Value, String, Option<Value>)> {
    let t = recipe(&app.job)?;
    let sid = &app.job.service_id;
    let mut text = String::new();
    let mut components = vec![];
    let mut samples = vec![];
    for c in &t.components {
        let n = name(sid, &c.id);
        let info = inspect(&n).ok();
        let status = match &info {
            None => "missing",
            Some(v) if v["State"]["Running"] != true => "stopped",
            Some(v) if component_healthy(&app.job, app, c, v) => "running",
            _ => "unhealthy",
        };
        let component_logs = report_logs(
            logs(&n).unwrap_or_default(),
            &app.job.spec.environment,
            6000 / t.components.len(),
        );
        text.push_str(&format!("\n[{}]\n{}", c.id, component_logs));
        let mut component_metrics = None;
        if active {
            let r = Revision {
                job: app.job.clone(),
                container: n,
                digest: c.image.clone(),
                port: app.port,
            };
            if let Ok(sample) = collector.sample(&r) {
                component_metrics = Some(sample.clone());
                samples.push(sample);
            }
        }
        components.push(json!({"name":c.id,"status":status,"image":c.image,"logs":component_logs,"metrics":component_metrics}));
    }
    text = report_logs(text, &app.job.spec.environment, 4000);
    let stats = if samples.len() == t.components.len() {
        let mut stats = samples[0].clone();
        for key in [
            "cpuPercent",
            "memoryBytes",
            "memoryLimitBytes",
            "networkRxBytesPerSecond",
            "networkTxBytesPerSecond",
            "processes",
            "restarts",
        ] {
            stats[key] = if samples.iter().any(|s| s[key].is_null()) {
                Value::Null
            } else if [
                "cpuPercent",
                "networkRxBytesPerSecond",
                "networkTxBytesPerSecond",
            ]
            .contains(&key)
            {
                json!(
                    samples
                        .iter()
                        .map(|s| s[key].as_f64().unwrap_or(0.0))
                        .sum::<f64>()
                        .min(if key == "cpuPercent" { 100.0 } else { f64::MAX })
                )
            } else {
                json!(
                    samples
                        .iter()
                        .map(|s| s[key].as_u64().unwrap_or(0))
                        .sum::<u64>()
                )
            };
        }
        stats["uptimeSeconds"] = json!(
            samples
                .iter()
                .map(|s| s["uptimeSeconds"].as_u64().unwrap_or(0))
                .min()
                .unwrap_or(0)
        );
        Some(stats)
    } else {
        None
    };
    let volumes = t
        .components
        .iter()
        .flat_map(|c| {
            c.volumes
                .iter()
                .map(|v| json!({"name":app.volumes[&v.key],"target":v.target,"component":c.id}))
        })
        .collect::<Vec<_>>();
    Ok((
        json!({"components":components,"volumes":volumes,"backups":app.backups.iter().map(|b|json!({"id":b.id,"createdAt":b.created_at,"volumes":b.volumes.values().collect::<Vec<_>>()})).collect::<Vec<_>>(),"port":app.port,"recoveryRequired":app.recovery_required}),
        text,
        stats,
    ))
}
pub(super) fn contains_container(app: &App, n: &str) -> bool {
    recipe(&app.job).is_ok_and(|t| {
        t.components
            .iter()
            .any(|c| name(&app.job.service_id, &c.id) == n)
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn component_log_tails_redact_before_truncating_and_preserve_utf8() {
        let secrets =
            std::collections::BTreeMap::from([("PASSWORD".into(), "secret-value".into())]);
        let full = super::report_logs("old\u{1b}\nsecret-value\n新しいログ".into(), &secrets, 100);
        assert_eq!(full, "old\n[redacted]\n新しいログ");
        let tail = super::report_logs("secret-value新しいログ".into(), &secrets, 8);
        assert!(tail.len() <= 8);
        assert!(!tail.contains("value"));
        assert!("新しいログ".ends_with(&tail));
    }
    use super::*;
    #[test]
    fn storage_plan_preserves_identity_and_pending_initialization_across_restart() {
        let mut job = super::super::tests::job();
        job.spec.storage_version = Some(1);
        job.spec.volumes = vec![PersistentVolume {
            name: "data".into(),
            mount_path: "/data".into(),
        }];
        let mut app = App {
            job: job.clone(),
            recipe_hash: recipe_hash(&recipe(&job).unwrap()),
            provisioned: true,
            volumes: BTreeMap::from([("data".into(), "existing-data".into())]),
            detached_volumes: BTreeMap::new(),
            uninitialized_volumes: Default::default(),
            backups: vec![],
            port: 31000,
            access_hash: String::new(),
            recovery_required: false,
        };
        job.spec.volumes[0].mount_path = "/moved".into();
        job.spec.volumes.push(PersistentVolume {
            name: "cache".into(),
            mount_path: "/cache".into(),
        });
        plan_storage(&mut app, &job);
        assert_eq!(app.volumes["data"], "existing-data");
        let pending = app.volumes["cache"].clone();
        assert_eq!(
            app.uninitialized_volumes,
            std::collections::BTreeSet::from([pending.clone()])
        );
        let mut app: App = serde_json::from_slice(&serde_json::to_vec(&app).unwrap()).unwrap();
        job.id = "b".repeat(36);
        plan_storage(&mut app, &job);
        assert_eq!(app.volumes["cache"], pending);
        job.spec.volumes.clear();
        plan_storage(&mut app, &job);
        assert!(app.volumes.is_empty());
        assert_eq!(app.detached_volumes.len(), 2);
        assert!(job.spec.stateful());
        assert_eq!(recipe(&job).unwrap().id, "custom");
        job.spec.volumes.push(PersistentVolume {
            name: "data".into(),
            mount_path: "/back".into(),
        });
        plan_storage(&mut app, &job);
        assert_eq!(app.volumes["data"], "existing-data");
        assert!(!app.uninitialized_volumes.contains("existing-data"));
        assert_eq!(app.detached_volumes["cache"], pending);
    }
    fn job_for(t: &Template) -> Job {
        let mut job = super::super::tests::job();
        job.backup_id = None;
        job.domain = if t.web {
            Some(format!("{}.example.org", t.id))
        } else {
            None
        };
        job.spec.image = t.components.last().unwrap().image.clone();
        job.spec.catalog = Some(Selection {
            template: t.id.clone(),
            version: t.version,
            protected: t.web,
            resources: None,
        });
        job.spec.environment = t
            .secrets
            .iter()
            .map(|s| (s.clone(), "a".repeat(64)))
            .collect();
        job
    }
    fn uid() -> String {
        format!("{:032x}0000", rand::random::<u128>())
    }
    #[test]
    fn recipe_fingerprints_ignore_presentation_but_preserve_runtime_safety() {
        let t = definitions()
            .unwrap()
            .templates
            .into_iter()
            .find(|t| t.id == "uptime-kuma")
            .unwrap();
        let raw = raw_recipe(&t);
        let expected = recipe_hash(&t);
        let mut presentation = raw.clone();
        for key in ["name", "category", "description", "technology", "notes"] {
            presentation[key] = json!("Updated display text");
        }
        assert_eq!(runtime_recipe_hash(presentation), expected);
        for changed in [
            {
                let mut r = raw.clone();
                r["components"][0]["image"] = json!("different-image");
                r
            },
            {
                let mut r = raw.clone();
                r["components"][0]["volumes"][0]["target"] = json!("/different-data");
                r
            },
            {
                let mut r = raw.clone();
                r["secrets"] = json!([]);
                r
            },
            {
                let mut r = raw.clone();
                r["futureRuntimeOption"] = json!(true);
                r
            },
        ] {
            assert_ne!(runtime_recipe_hash(changed.clone()), expected);
            assert!(!compatible_recipe_hash(&hash_recipe(&changed), &t));
        }
        // Actual fingerprint of the initially deployed Kuma recipe (null icon).
        let legacy = "6cd956e63579a2084301c71dbed18b1e737b4446ac452b1be537bbeb0818b039";
        assert!(compatible_recipe_hash(legacy, &t));
        assert!(compatible_recipe_hash(&hash_recipe(&raw), &t));
        assert!(compatible_recipe_hash(&expected, &t));
        let job = job_for(&t);
        let mut manifest = ExportManifest {
            version: 1,
            service_id: job.service_id.clone(),
            recipe_hash: legacy.into(),
            volumes: vec!["data".into()],
            spec: job.spec.clone(),
        };
        assert!(validate_import(&job, &job.service_id, &manifest).is_ok());
        manifest.recipe_hash = "0".repeat(64);
        assert!(validate_import(&job, &job.service_id, &manifest).is_err());
    }
    #[test]
    fn catalog_rejects_overrides_and_privileged_arbitrary_recipes() {
        for t in definitions().unwrap().templates {
            let mut j = job_for(&t);
            assert!(super::super::validate(&j).is_ok());
            j.spec.image = "docker.io/library/alpine:latest".into();
            assert!(validate(&j).is_err());
            j = job_for(&t);
            j.action = "rollback".into();
            assert!(validate(&j).is_err());
            j = job_for(&t);
            j.spec
                .environment
                .insert("LD_PRELOAD".into(), "evil".into());
            assert!(validate(&j).is_err());
            j = job_for(&t);
            j.spec.catalog.as_mut().unwrap().version = 999;
            assert!(validate(&j).is_err());
        }
    }
    #[test]
    fn mounts_networks_and_health_commands_come_only_from_reviewed_templates() {
        for t in definitions().unwrap().templates {
            let j = job_for(&t);
            let app = App {
                job: j.clone(),
                recipe_hash: recipe_hash(&t),
                provisioned: false,
                volumes: t
                    .components
                    .iter()
                    .flat_map(|c| {
                        c.volumes
                            .iter()
                            .map(|v| (v.key.clone(), volume_name(&j.service_id, &j.id, &v.key)))
                    })
                    .collect(),
                detached_volumes: BTreeMap::new(),
                uninitialized_volumes: Default::default(),
                backups: vec![],
                port: 32000,
                access_hash: String::new(),
                recovery_required: false,
            };
            for c in &t.components {
                let v = config(&j, c, &app).unwrap();
                assert_eq!(v["HostConfig"]["ReadonlyRootfs"], true);
                assert!(v["HostConfig"].get("Binds").is_none());
                assert!(v["HostConfig"].get("Privileged").is_none());
                for m in v["HostConfig"]["Mounts"].as_array().unwrap() {
                    assert_eq!(m["Type"], "volume");
                    assert!(m["Source"].as_str().unwrap().starts_with("ephor-data-"));
                }
                if c.id != t.components.last().unwrap().id {
                    assert!(v["HostConfig"].get("PortBindings").is_none());
                    assert!(c.internal);
                }
            }
        }
    }
    #[test]
    #[ignore = "isolated Linux Docker engine"]
    fn linked_database_connections() {
        root().unwrap();
        directory(Path::new(STATE)).unwrap();
        let base = super::super::tests::job();
        let settings = Settings {
            panel: "https://unused.example.org".into(),
            credential: "a".repeat(64),
            proxy_image: pull(&Spec {
                image: "docker.io/library/caddy:2.11.9".into(),
                ..base.spec
            })
            .unwrap(),
        };
        let mut state = State::default();
        for t in definitions()
            .unwrap()
            .templates
            .into_iter()
            .filter(|t| ["postgres", "redis"].contains(&t.id.as_str()))
        {
            let mut database = job_for(&t);
            database.service_id = uid();
            database.id = uid();
            super::super::apply(&mut state, &settings, &database).unwrap();
            state.journal = None;
            let component = &t.components[0];
            let dir = PathBuf::from(format!("/tmp/ephor-connection-{}", uid()));
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("Dockerfile"),
                format!(
                    "FROM {}\nENTRYPOINT [\"sleep\"]\nCMD [\"600\"]\n",
                    component.image
                ),
            )
            .unwrap();
            let image = format!("ephor.test/connection-{}:latest", t.id);
            d(&["build", "-t", &image, dir.to_str().unwrap()], 120).unwrap();
            fs::remove_dir_all(&dir).unwrap();
            let mut app = super::super::tests::job();
            app.service_id = uid();
            app.id = uid();
            app.spec.image = image.clone();
            app.spec.connections = vec![Connection {
                service_id: database.service_id.clone(),
                template: t.id.clone(),
            }];
            let host = name(&database.service_id, &component.id);
            let password = &database.spec.environment["DB_PASSWORD"];
            app.spec.environment.insert("DB_HOST".into(), host.clone());
            app.spec
                .environment
                .insert("PGPASSWORD".into(), password.clone());
            app.spec
                .environment
                .insert("REDISCLI_AUTH".into(), password.clone());
            super::super::validate(&app).unwrap();
            let client = launch(&app, &image).unwrap();
            let probe = if t.id == "postgres" {
                "psql -h \"$DB_HOST\" -U ephor -d app -Atc 'SELECT 42'"
            } else {
                "redis-cli -h \"$DB_HOST\" ping"
            };
            let result = d(&["exec", &client.container, "sh", "-ec", probe], 20).unwrap();
            assert_eq!(
                result.trim(),
                if t.id == "postgres" { "42" } else { "PONG" }
            );
            let info = inspect(&client.container).unwrap();
            assert!(
                info["NetworkSettings"]["Networks"]
                    .get(network(&database.service_id, false))
                    .is_some()
            );
            assert!(
                info["NetworkSettings"]["Networks"]
                    .get(network(&database.service_id, true))
                    .is_none()
            );
            // A replacement app without the reference loses database network access.
            let mut unlinked = app.clone();
            unlinked.id = uid();
            unlinked.spec.connections.clear();
            let isolated = launch(&unlinked, &image).unwrap();
            assert!(
                inspect(&isolated.container).unwrap()["NetworkSettings"]["Networks"]
                    .get(network(&database.service_id, false))
                    .is_none()
            );
            assert!(d(&["exec", &isolated.container, "sh", "-ec", probe], 10).is_err());
            // Recreating database containers preserves the stable hostname and link.
            start_components(
                &database,
                &state.services[&database.service_id].app.clone().unwrap(),
                &t,
            )
            .unwrap();
            assert_eq!(
                d(&["exec", &client.container, "sh", "-ec", probe], 20)
                    .unwrap()
                    .trim(),
                if t.id == "postgres" { "42" } else { "PONG" }
            );
            remove(&client.container).unwrap();
            remove(&isolated.container).unwrap();
        }
    }
    #[test]
    #[ignore = "isolated Linux Docker engine"]
    fn catalog_persistence_backup_restore_and_setup_protection() {
        root().unwrap();
        directory(Path::new(STATE)).unwrap();
        let base = super::super::tests::job();
        let settings = Settings {
            panel: "https://unused.example.org".into(),
            credential: "a".repeat(64),
            proxy_image: pull(&Spec {
                image: "docker.io/library/caddy:2.11.9".into(),
                ..base.spec
            })
            .unwrap(),
        };
        let mut state = State::default();
        for t in definitions().unwrap().templates {
            eprintln!("CATALOG testing {}", t.id);
            let mut job = job_for(&t);
            job.service_id = uid();
            job.id = uid();
            if let Err(e) = super::super::apply(&mut state, &settings, &job) {
                for c in &t.components {
                    let n = name(&job.service_id, &c.id);
                    eprintln!(
                        "{} state: {:?}\n{}",
                        c.id,
                        inspect(&n).map(|v| v["State"].clone()),
                        logs(&n).unwrap_or_default()
                    );
                }
                panic!("Catalog {} deploy failed: {e:?}", t.id);
            }
            let app = state.services[&job.service_id].app.clone().unwrap();
            assert!(healthy(&app));
            std::net::TcpStream::connect_timeout(
                &format!("127.0.0.1:{}", app.port).parse().unwrap(),
                Duration::from_secs(3),
            )
            .expect("Main app must be reachable through its private loopback port");
            for c in &t.components {
                let v = inspect(&name(&job.service_id, &c.id)).unwrap();
                assert_eq!(v["HostConfig"]["Privileged"], false);
                if c.id != t.components.last().unwrap().id {
                    assert!(
                        v["HostConfig"]["PortBindings"].is_null()
                            || v["HostConfig"]["PortBindings"]
                                .as_object()
                                .unwrap()
                                .is_empty()
                    );
                }
            }
            if t.web {
                let host = job.domain.as_ref().unwrap();
                let client = Client::builder()
                    .no_proxy()
                    .danger_accept_invalid_certs(true)
                    .resolve(host, "127.0.0.1:443".parse().unwrap())
                    .build()
                    .unwrap();
                assert_eq!(
                    client
                        .get(format!("https://{host}"))
                        .send()
                        .unwrap()
                        .status()
                        .as_u16(),
                    401
                );
                let authenticated = client
                    .get(format!("https://{host}"))
                    .basic_auth("admin", Some(&job.spec.environment["ACCESS_PASSWORD"]))
                    .send()
                    .unwrap()
                    .status();
                assert!(authenticated.is_success() || authenticated.is_redirection());
            }
            if ["postgres", "redis"].contains(&t.id.as_str()) {
                job.spec.catalog.as_mut().unwrap().resources = Some(Resources {
                    memory_mb: 512,
                    cpus: 1.5,
                    redis_maxmemory_mb: (t.id == "redis").then_some(256),
                });
                job.spec.memory_mb = 512;
                job.spec.cpus = 1.5;
                job.id = uid();
                super::super::apply(&mut state, &settings, &job).unwrap();
                let info = inspect(&name(&job.service_id, &t.components[0].id)).unwrap();
                assert_eq!(info["HostConfig"]["Memory"], 512 * 1024 * 1024);
                assert_eq!(info["HostConfig"]["NanoCpus"], 1_500_000_000);
                if t.id == "redis" {
                    assert!(
                        d(
                            &[
                                "exec",
                                &name(&job.service_id, "redis"),
                                "redis-cli",
                                "CONFIG",
                                "GET",
                                "maxmemory"
                            ],
                            20
                        )
                        .unwrap()
                        .contains("268435456")
                    );
                }
            }
            if t.id == "qdrant" {
                let client = Client::new();
                let base = format!("http://127.0.0.1:{}", app.port);
                assert!(
                    !client
                        .get(format!("{base}/collections"))
                        .send()
                        .unwrap()
                        .status()
                        .is_success()
                );
                assert!(
                    client
                        .put(format!("{base}/collections/durable"))
                        .header("api-key", &job.spec.environment["API_KEY"])
                        .json(&json!({"vectors":{"size":2,"distance":"Cosine"}}))
                        .send()
                        .unwrap()
                        .status()
                        .is_success()
                );
                assert!(client.put(format!("{base}/collections/durable/points?wait=true")).header("api-key", &job.spec.environment["API_KEY"]).json(&json!({"points":[{"id":1,"vector":[1.0,0.0],"payload":{"value":"before"}}]})).send().unwrap().status().is_success());
                let ip = inspect(&name(&job.service_id,"qdrant")).unwrap()["NetworkSettings"]["Networks"][network(&job.service_id,false)]["IPAddress"].as_str().unwrap().to_string();
                std::net::TcpStream::connect_timeout(
                    &format!("{ip}:6334").parse().unwrap(),
                    Duration::from_secs(3),
                )
                .expect("Private gRPC listener");
            }
            // Write a marker to every persistent volume, including dependency databases.
            for vol in app.volumes.values() {
                helper(
                    &job.service_id,
                    "test",
                    vec![mount(vol, "/data", false)],
                    vec![
                        "sh".into(),
                        "-ec".into(),
                        "echo original > /data/ephor-test-marker".into(),
                    ],
                    10,
                )
                .unwrap();
            }
            if t.id == "postgres" {
                d(
                    &[
                        "exec",
                        &name(&job.service_id, "database"),
                        "psql",
                        "-U",
                        "ephor",
                        "-d",
                        "app",
                        "-c",
                        "CREATE TABLE durable (value text); INSERT INTO durable VALUES ('before');",
                    ],
                    15,
                )
                .unwrap();
            }
            if t.id == "redis" {
                d(
                    &[
                        "exec",
                        &name(&job.service_id, "redis"),
                        "redis-cli",
                        "SET",
                        "durable",
                        "before",
                    ],
                    15,
                )
                .unwrap();
            }
            job.id = uid();
            job.action = "backup".into();
            super::super::apply(&mut state, &settings, &job).unwrap();
            let backup_id = job.id.clone();
            assert!(healthy(
                state.services[&job.service_id].app.as_ref().unwrap()
            ));
            for vol in app.volumes.values() {
                helper(
                    &job.service_id,
                    "test",
                    vec![mount(vol, "/data", false)],
                    vec![
                        "sh".into(),
                        "-ec".into(),
                        "echo changed > /data/ephor-test-marker".into(),
                    ],
                    10,
                )
                .unwrap();
            }
            job.id = uid();
            job.action = "restore".into();
            job.backup_id = Some(backup_id.clone());
            super::super::apply(&mut state, &settings, &job).unwrap();
            let restored = state.services[&job.service_id].app.clone().unwrap();
            assert_ne!(restored.volumes, app.volumes);
            if t.id == "qdrant" {
                let point: Value = Client::new()
                    .get(format!(
                        "http://127.0.0.1:{}/collections/durable/points/1",
                        restored.port
                    ))
                    .header("api-key", &job.spec.environment["API_KEY"])
                    .send()
                    .unwrap()
                    .json()
                    .unwrap();
                assert_eq!(point["result"]["payload"]["value"], "before");
            }
            for vol in restored.volumes.values() {
                helper(
                    &job.service_id,
                    "test",
                    vec![mount(vol, "/data", true)],
                    vec![
                        "sh".into(),
                        "-ec".into(),
                        "test \"$(cat /data/ephor-test-marker)\" = original".into(),
                    ],
                    10,
                )
                .unwrap();
            }
            if t.id == "postgres" {
                assert!(
                    d(
                        &[
                            "exec",
                            &name(&job.service_id, "database"),
                            "psql",
                            "-U",
                            "ephor",
                            "-d",
                            "app",
                            "-tAc",
                            "SELECT value FROM durable"
                        ],
                        15
                    )
                    .unwrap()
                    .contains("before")
                );
            }
            if t.id == "redis" {
                assert_eq!(
                    d(
                        &[
                            "exec",
                            &name(&job.service_id, "redis"),
                            "redis-cli",
                            "GET",
                            "durable"
                        ],
                        15
                    )
                    .unwrap(),
                    "before"
                );
            }
            job.id = uid();
            job.action = "stop".into();
            job.backup_id = None;
            super::super::apply(&mut state, &settings, &job).unwrap();
            assert!(state.services[&job.service_id].active.is_none());
            job.id = uid();
            job.action = "deploy".into();
            super::super::apply(&mut state, &settings, &job).unwrap();
            assert!(healthy(
                state.services[&job.service_id].app.as_ref().unwrap()
            ));
            // Simulate an interruption after marking the storage operation as begun.
            let app = state
                .services
                .get_mut(&job.service_id)
                .unwrap()
                .app
                .as_mut()
                .unwrap();
            app.recovery_required = true;
            state.journal.as_mut().unwrap().status = "applying".into();
            save(&state).unwrap();
            let mut reloaded: State = read(&state_path()).unwrap();
            super::super::recover(&mut reloaded, &settings, "WORKER_INTERRUPTED").unwrap();
            state = reloaded;
            assert!(state.services[&job.service_id].active.is_none());
            assert!(
                state.services[&job.service_id]
                    .app
                    .as_ref()
                    .unwrap()
                    .recovery_required
            );
            job.id = uid();
            job.action = "deploy".into();
            super::super::apply(&mut state, &settings, &job).unwrap();
            job.id = uid();
            job.action = "delete-backup".into();
            job.backup_id = Some(backup_id);
            super::super::apply(&mut state, &settings, &job).unwrap();
            assert!(healthy(
                state.services[&job.service_id].app.as_ref().unwrap()
            ));
            if t.id == "postgres" {
                // Corrupt a snapshot inside this disposable engine. Restore must fail
                // before switching volumes, and the current data must remain intact.
                let before = state.services[&job.service_id].app.clone().unwrap();
                let damaged = before.backups[0].clone();
                for vol in damaged.volumes.values() {
                    helper(
                        &job.service_id,
                        "test",
                        vec![mount(vol, "/backup", false)],
                        vec![
                            "sh".into(),
                            "-ec".into(),
                            "echo corrupted >> /backup/data.tar".into(),
                        ],
                        10,
                    )
                    .unwrap();
                }
                job.id = uid();
                job.action = "restore".into();
                job.backup_id = Some(damaged.id.clone());
                assert!(super::super::apply(&mut state, &settings, &job).is_err());
                super::super::recover(&mut state, &settings, "BACKUP_FAILED").unwrap();
                assert_eq!(
                    state.services[&job.service_id]
                        .app
                        .as_ref()
                        .unwrap()
                        .volumes,
                    before.volumes
                );
                assert!(state.services[&job.service_id].active.is_none());
                job.id = uid();
                job.action = "deploy".into();
                job.backup_id = None;
                super::super::apply(&mut state, &settings, &job).unwrap();
                assert!(
                    d(
                        &[
                            "exec",
                            &name(&job.service_id, "database"),
                            "psql",
                            "-U",
                            "ephor",
                            "-d",
                            "app",
                            "-tAc",
                            "SELECT value FROM durable"
                        ],
                        15
                    )
                    .unwrap()
                    .contains("before")
                );
            }
            job.id = uid();
            job.action = "stop".into();
            job.backup_id = None;
            super::super::apply(&mut state, &settings, &job).unwrap();
            for c in &t.components {
                remove_owned(&name(&job.service_id, &c.id), &job.service_id).unwrap();
            }
            if t.id == "postgres" {
                let volume = state.services[&job.service_id]
                    .app
                    .as_ref()
                    .unwrap()
                    .volumes
                    .values()
                    .next()
                    .unwrap()
                    .clone();
                api(
                    reqwest::Method::DELETE,
                    &format!("/volumes/{volume}"),
                    Value::Null,
                )
                .unwrap();
                job.id = uid();
                job.action = "deploy".into();
                assert!(super::super::apply(&mut state, &settings, &job).is_err());
                assert_eq!(
                    docker_client()
                        .unwrap()
                        .get(format!("http://localhost/volumes/{volume}"))
                        .send()
                        .unwrap()
                        .status()
                        .as_u16(),
                    404,
                    "A missing live volume must never be silently recreated"
                );
                super::super::recover(&mut state, &settings, "CATALOG_RECOVERY_REQUIRED").unwrap();
            }
            state.services.remove(&job.service_id);
            save(&state).unwrap();
            eprintln!("CATALOG passed {}", t.id);
        }
    }
}

// Portable off-site bundle: recipe identity and credentials travel inside Restic encryption.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ExportManifest {
    pub version: u32,
    pub service_id: String,
    pub spec: Spec,
    pub recipe_hash: String,
    pub volumes: Vec<String>,
}
pub(super) fn export(state: &State, sid: &str, bid: &str) -> Result<(ExportManifest, Vec<Value>)> {
    let app = state
        .services
        .get(sid)
        .and_then(|s| s.app.as_ref())
        .context("No app")?;
    let backup = app
        .backups
        .iter()
        .find(|b| b.id == bid)
        .context("No completed snapshot")?;
    let mut mounts = Vec::new();
    for (key, volume) in &backup.volumes {
        existing_volume(sid, volume, "backup")?;
        mounts.push(mount(volume, &format!("/data/volumes/{key}"), true));
    }
    Ok((
        ExportManifest {
            version: 1,
            service_id: sid.into(),
            spec: app.job.spec.clone(),
            recipe_hash: app.recipe_hash.clone(),
            volumes: backup.volumes.keys().cloned().collect(),
        },
        mounts,
    ))
}
pub(super) fn discard_export(state: &mut State, sid: &str, bid: &str) -> Result<()> {
    let app = state
        .services
        .get_mut(sid)
        .and_then(|s| s.app.as_mut())
        .context("No app")?;
    if let Some(backup) = app.backups.iter().find(|b| b.id == bid).cloned() {
        app.backups.retain(|b| b.id != bid);
        save(state)?;
        for volume in backup.volumes.values() {
            existing_volume(sid, volume, "backup")?;
            api(
                reqwest::Method::DELETE,
                &format!("/volumes/{volume}"),
                Value::Null,
            )?;
        }
    }
    Ok(())
}
pub(super) fn validate_import(job: &Job, source: &str, manifest: &ExportManifest) -> Result<()> {
    validate(job)?;
    let t = recipe(job)?;
    let mut expected: Vec<String> = t
        .components
        .iter()
        .flat_map(|c| c.volumes.iter().map(|v| v.key.clone()))
        .collect();
    expected.sort();
    ensure!(
        manifest.version == 1
            && manifest.service_id == source
            && compatible_recipe_hash(&manifest.recipe_hash, &t)
            && manifest.volumes == expected,
        "Backup recipe mismatch"
    );
    ensure!(
        manifest.spec.volumes == job.spec.volumes
            && serde_json::to_value(
                manifest
                    .spec
                    .catalog
                    .as_ref()
                    .and_then(|c| c.resources.as_ref())
            )? == serde_json::to_value(
                job.spec.catalog.as_ref().and_then(|c| c.resources.as_ref())
            )?
            && manifest.spec.port == job.spec.port
            && manifest.spec.health_path == job.spec.health_path
            && manifest.spec.image == job.spec.image
            && manifest.spec.environment == job.spec.environment
            && manifest
                .spec
                .catalog
                .as_ref()
                .map(|s| (&s.template, s.version))
                == job.spec.catalog.as_ref().map(|s| (&s.template, s.version)),
        "Backup configuration mismatch"
    );
    Ok(())
}
pub(super) fn import(
    state: &mut State,
    settings: &Settings,
    job: &Job,
    source: &str,
    manifest: &ExportManifest,
    staging: &str,
) -> Result<()> {
    validate_import(job, source, manifest)?;
    let sid = &job.service_id;
    ensure!(
        !state.services.contains_key(sid),
        "Restore target already exists"
    );
    let t = recipe(job)?;
    let mut helper_spec = job.spec.clone();
    helper_spec.catalog = None;
    helper_spec.image = definitions()?.helper_image;
    pull(&helper_spec)?;
    state.journal = Some(Journal {
        job: job.clone(),
        old: Service::default(),
        status: "applying".into(),
        digest: None,
        error: None,
    });
    save(state)?;
    let mut volumes = BTreeMap::new();
    for key in &manifest.volumes {
        let dst = volume_name(sid, &job.id, key);
        ensure_volume(sid, &dst, "data", true)?;
        // Source paths come exclusively from the compiled recipe, never archive metadata.
        helper(
            sid,
            "restore",
            vec![
                mount(staging, "/restore", true),
                mount(&dst, "/target", false),
            ],
            vec![
                "sh".into(),
                "-ec".into(),
                format!(
                    "cd /restore/data/volumes/{key}; sha256sum -c SHA256SUMS; needed=$(du -k data.tar | cut -f1); available=$(df -Pk /target | tail -1 | awk '{{print $4}}'); test \"$available\" -gt $((needed + 1048576)); tar -xpf data.tar -C /target; sync"
                ),
            ],
            1800,
        )?;
        volumes.insert(key.clone(), dst);
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let app = App {
        detached_volumes: BTreeMap::new(),
        uninitialized_volumes: Default::default(),
        job: job.clone(),
        recipe_hash: recipe_hash(&t),
        provisioned: true,
        volumes,
        backups: vec![],
        port: listener.local_addr()?.port(),
        access_hash: if t.web && t.id != "custom" {
            bcrypt::hash(&job.spec.environment["ACCESS_PASSWORD"], 12)?
        } else {
            String::new()
        },
        recovery_required: true,
    };
    drop(listener);
    state.services.insert(
        sid.clone(),
        Service {
            app: Some(app),
            ..Service::default()
        },
    );
    save(state)?;
    // Imported volumes are already populated. This internal action skips initialization and a redundant pre-deploy snapshot.
    let mut start = job.clone();
    start.action = "import".into();
    apply(state, settings, &start)
}
