//! These tests run only inside the disposable Docker-in-Docker fixture.
use super::*;
fn uid() -> String {
    format!("{:032x}0000", rand::random::<u128>())
}
pub(super) fn custom_job() -> Job {
    let mut job = tests::job();
    job.service_id = uid();
    job.id = uid();
    job.domain = None;
    job.domains = None;
    job.spec.volumes = vec![PersistentVolume {
        name: "data".into(),
        mount_path: "/data".into(),
    }];
    job.spec.port = 8080;
    job.spec.health_path = "/".into();
    let tag = format!("ephor.local/{}:fixture", job.service_id);
    let dir = std::env::temp_dir().join(uid());
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("Dockerfile"), "FROM busybox:1.37\nCMD [\"sh\",\"-ec\",\"test -f /data/index.html || echo original > /data/index.html; exec httpd -f -p 8080 -h /data\"]\n").unwrap();
    d(&["build", "-t", &tag, dir.to_str().unwrap()], 180).unwrap();
    fs::remove_dir_all(dir).unwrap();
    job.spec.image = format!(
        "ephor.local/{}@{}",
        job.service_id,
        inspect(&tag).unwrap()["Id"].as_str().unwrap()
    );
    job
}
#[test]
fn persistent_worker_rejects_unsafe_mounts_and_rollback() {
    for path in [
        "/",
        "/etc",
        "/proc/self",
        "/var/lib/docker",
        "/data/../etc",
        "/data//x",
        "/tmp",
    ] {
        let mut job = tests::job();
        job.spec.volumes = vec![PersistentVolume {
            name: "data".into(),
            mount_path: path.into(),
        }];
        assert!(validate(&job).is_err(), "{path}");
    }
    let mut job = tests::job();
    job.spec.volumes = vec![PersistentVolume {
        name: "data".into(),
        mount_path: "/data".into(),
    }];
    assert!(validate(&job).is_ok());
    job.action = "rollback".into();
    assert!(validate(&job).is_err());
}
#[test]
#[ignore = "isolated Linux Docker engine"]
fn custom_volumes_redeploy_crash_recovery_and_missing_data() {
    root().unwrap();
    directory(Path::new(STATE)).unwrap();
    let mut job = custom_job();
    let settings = Settings {
        panel: "https://unused.example.org".into(),
        credential: "a".repeat(64),
        proxy_image: "unused".into(),
    };
    let mut state = State::default();
    apply(&mut state, &settings, &job).unwrap();
    let name = format!("ephor-app-{}-web", job.service_id);
    let mount = inspect(&name).unwrap()["Mounts"][0]["Name"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(inspect(&name).unwrap()["Config"]["User"], "65532:65532");
    d(
        &[
            "exec",
            &name,
            "sh",
            "-ec",
            "echo durable > /data/index.html",
        ],
        10,
    )
    .unwrap();
    job.id = uid();
    apply(&mut state, &settings, &job).unwrap();
    assert_eq!(
        d(&["exec", &name, "cat", "/data/index.html"], 10).unwrap(),
        "durable"
    );
    assert_eq!(inspect(&name).unwrap()["Mounts"][0]["Name"], mount);
    job.id = uid();
    job.action = "backup".into();
    apply(&mut state, &settings, &job).unwrap();
    let snapshot = job.id.clone();
    d(
        &[
            "exec",
            &name,
            "sh",
            "-ec",
            "echo changed > /data/index.html",
        ],
        10,
    )
    .unwrap();
    job.id = uid();
    job.action = "restore".into();
    job.backup_id = Some(snapshot);
    apply(&mut state, &settings, &job).unwrap();
    assert_eq!(
        d(&["exec", &name, "cat", "/data/index.html"], 10).unwrap(),
        "durable"
    );
    let restored = inspect(&name).unwrap()["Mounts"][0]["Name"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(mount, restored);
    // Simulate restart during a stateful mutation. It must stop writers and retain data.
    state
        .services
        .get_mut(&job.service_id)
        .unwrap()
        .app
        .as_mut()
        .unwrap()
        .recovery_required = true;
    state.journal.as_mut().unwrap().status = "applying".into();
    save(&state).unwrap();
    let mut state: State = read(&Path::new(STATE).join("state.json")).unwrap();
    recover(&mut state, &settings, "WORKER_INTERRUPTED").unwrap();
    assert!(state.services[&job.service_id].active.is_none());
    assert_eq!(inspect(&name).unwrap()["State"]["Running"], false);
    job.id = uid();
    job.action = "deploy".into();
    job.backup_id = None;
    apply(&mut state, &settings, &job).unwrap();
    assert_eq!(
        d(&["exec", &name, "cat", "/data/index.html"], 10).unwrap(),
        "durable"
    );
    // Simulate losing a data volume. Never create an empty replacement silently.
    job.id = uid();
    job.action = "stop".into();
    apply(&mut state, &settings, &job).unwrap();
    d(&["rm", "-f", &name], 30).unwrap();
    d(&["volume", "rm", &restored], 30).unwrap();
    job.id = uid();
    job.action = "deploy".into();
    assert!(apply(&mut state, &settings, &job).is_err());
    assert!(d(&["volume", "inspect", &restored], 10).is_err());
}
