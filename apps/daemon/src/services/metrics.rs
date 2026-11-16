//! Bounded Docker stats for managed application containers only.
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
struct Counters {
    cpu: u64,
    system: u64,
    rx: u64,
    tx: u64,
    started: String,
    at: Instant,
}
#[derive(Default)]
pub(super) struct Collector {
    previous: BTreeMap<String, Counters>,
}
impl Collector {
    pub(super) fn retain(&mut self, state: &State) {
        self.previous.retain(|name, _| {
            state.services.values().any(|s| {
                s.active.as_ref().is_some_and(|r| {
                    &r.container == name
                        || s.app
                            .as_ref()
                            .is_some_and(|a| catalog::contains_container(a, name))
                })
            })
        });
    }
    pub(super) fn sample(&mut self, revision: &Revision) -> Result<Value> {
        let name = &revision.container;
        ensure!(
            name.starts_with("ephor-")
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "Invalid metric container"
        );
        let client = Client::builder()
            .unix_socket("/var/run/docker.sock")
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()?;
        let info = get(&client, &format!("/containers/{name}/json"))?;
        ensure!(
            info["Config"]["Labels"]["ephor.managed"] == "1"
                && info["Config"]["Labels"]["ephor.service"] == revision.job.service_id
                && info["State"]["Running"] == true,
            "Container is not running or managed"
        );
        let stats = get(
            &client,
            &format!("/containers/{name}/stats?stream=false&one-shot=true"),
        )?;
        let now = Instant::now();
        let started = info["State"]["StartedAt"]
            .as_str()
            .context("No container start time")?;
        let sample = counters(&stats, started, now);
        let metrics = values(&stats, &info, &sample, self.previous.get(name));
        self.previous.insert(name.clone(), sample);
        Ok(metrics)
    }
}
fn get(client: &Client, path: &str) -> Result<Value> {
    let response = client.get(format!("http://localhost{path}")).send()?;
    ensure!(response.status().is_success(), "Docker metrics unavailable");
    let mut bytes = Vec::new();
    response.take(1_048_577).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 1_048_576, "Docker metrics too large");
    Ok(serde_json::from_slice(&bytes)?)
}
fn counters(stats: &Value, started: &str, at: Instant) -> Counters {
    let mut rx = 0_u64;
    let mut tx = 0_u64;
    if let Some(networks) = stats["networks"].as_object() {
        for network in networks.values() {
            rx = rx.saturating_add(network["rx_bytes"].as_u64().unwrap_or(0));
            tx = tx.saturating_add(network["tx_bytes"].as_u64().unwrap_or(0));
        }
    }
    Counters {
        cpu: stats["cpu_stats"]["cpu_usage"]["total_usage"]
            .as_u64()
            .unwrap_or(0),
        system: stats["cpu_stats"]["system_cpu_usage"].as_u64().unwrap_or(0),
        rx,
        tx,
        started: started.into(),
        at,
    }
}
fn values(stats: &Value, info: &Value, current: &Counters, previous: Option<&Counters>) -> Value {
    let previous = previous.filter(|p| {
        p.started == current.started && current.at.duration_since(p.at).as_secs_f64() <= 120.0
    });
    // Docker system_cpu_usage spans all host cores. Without multiplying by core count,
    // this is the service's percentage of the whole machine, matching the UI label.
    let cpu = previous.and_then(|p| {
        let delta = current.cpu.checked_sub(p.cpu)?;
        let total = current.system.checked_sub(p.system)?;
        (total > 0).then(|| ((delta as f64 / total as f64) * 100.0).clamp(0.0, 100.0))
    });
    let rate = |value: u64, old: fn(&Counters) -> u64| {
        previous.and_then(|p| {
            let elapsed = current.at.duration_since(p.at).as_secs_f64();
            let delta = value.checked_sub(old(p))?;
            (elapsed > 0.0).then(|| delta as f64 / elapsed)
        })
    };
    let memory = &stats["memory_stats"];
    let cache = memory["stats"]["total_inactive_file"]
        .as_u64()
        .or_else(|| memory["stats"]["inactive_file"].as_u64())
        .unwrap_or(0);
    let started = chrono::DateTime::parse_from_rfc3339(&current.started)
        .ok()
        .map(|t| t.timestamp().max(0) as u64);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    json!({"cpuPercent":cpu,"memoryBytes":memory["usage"].as_u64().unwrap_or(0).saturating_sub(cache),"memoryLimitBytes":memory["limit"].as_u64().unwrap_or(0),"networkRxBytesPerSecond":rate(current.rx, |p| p.rx),"networkTxBytesPerSecond":rate(current.tx, |p| p.tx),"uptimeSeconds":started.map(|t| now.saturating_sub(t)).unwrap_or(0),"processes":stats["pids_stats"]["current"].as_u64().unwrap_or(0),"restarts":info["RestartCount"].as_u64().unwrap_or(0)})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calculates_host_cpu_cache_adjusted_memory_and_network_rates() {
        let mut stats = json!({"cpu_stats":{"cpu_usage":{"total_usage":100},"system_cpu_usage":1000},"memory_stats":{"usage":1000,"limit":2000,"stats":{"inactive_file":100}},"networks":{"eth0":{"rx_bytes":100,"tx_bytes":200}},"pids_stats":{"current":3}});
        let now = Instant::now();
        let first = counters(&stats, "2026-01-01T00:00:00Z", now);
        assert!(values(&stats, &json!({}), &first, None)["cpuPercent"].is_null());
        stats["cpu_stats"]["cpu_usage"]["total_usage"] = json!(120);
        stats["cpu_stats"]["system_cpu_usage"] = json!(1200);
        stats["networks"]["eth0"]["rx_bytes"] = json!(300);
        let next = counters(&stats, &first.started, now + Duration::from_secs(10));
        let v = values(&stats, &json!({"RestartCount":2}), &next, Some(&first));
        assert_eq!(v["cpuPercent"], 10.0);
        assert_eq!(v["memoryBytes"], 900);
        assert_eq!(v["networkRxBytesPerSecond"], 20.0);
        assert_eq!(v["processes"], 3);
        let restarted = Counters {
            started: "different".into(),
            ..next.clone()
        };
        assert!(values(&stats, &json!({}), &restarted, Some(&first))["cpuPercent"].is_null());
        let reset = Counters { rx: 0, ..next };
        assert!(
            values(&stats, &json!({}), &reset, Some(&first))["networkRxBytesPerSecond"].is_null()
        );
    }
}
