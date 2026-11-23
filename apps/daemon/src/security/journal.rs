use super::*;
use sha2::{Digest, Sha256};

fn parse(row: &Value) -> Option<Value> {
    let message = row["MESSAGE"].as_str()?;
    let kind = if message.starts_with("Accepted ") {
        "ssh.accepted"
    } else if message.starts_with("Failed ") || message.starts_with("Invalid user ") {
        "ssh.rejected"
    } else if message.contains("session closed for user ") {
        "ssh.closed"
    } else {
        return None;
    };
    let words: Vec<_> = message.split_whitespace().collect();
    let address = words
        .iter()
        .position(|w| *w == "from")
        .and_then(|i| words.get(i + 1))
        .and_then(|v| v.parse::<std::net::IpAddr>().ok())
        .map(|a| a.to_string())
        .unwrap_or_default();
    let user = if let Some(i) = words.iter().position(|w| *w == "for") {
        let rest = &words[i + 1..];
        if rest.starts_with(&["invalid", "user"]) {
            rest.get(2)
        } else if rest.first() == Some(&"user") {
            rest.get(1)
        } else {
            rest.first()
        }
    } else if words.starts_with(&["Invalid", "user"]) {
        words.get(2)
    } else {
        None
    };
    let user = user
        .filter(|u| {
            u.len() <= 80
                && u.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-.@".contains(&b))
        })
        .copied()
        .unwrap_or("");
    let occurred = row["__REALTIME_TIMESTAMP"].as_str()?.parse::<u64>().ok()? / 1000;
    let cursor = row["__CURSOR"].as_str()?;
    Some(
        json!({"id":format!("{:x}",Sha256::digest(cursor.as_bytes())),"kind":kind,"user":user,"address":address,"occurredAt":occurred}),
    )
}
fn gap(key: &str) -> Value {
    json!({"id":key,"kind":"collection.gap","user":"","address":"","occurredAt":now()})
}
fn send_events(
    client: &reqwest::blocking::Client,
    identity: &Config,
    events: &Value,
) -> Result<()> {
    for batch in events
        .as_array()
        .context("Invalid buffered events")?
        .chunks(16)
    {
        post(client, identity, "events", &json!({"events":batch}))?;
    }
    Ok(())
}
pub(super) fn collect_and_send(
    client: &reqwest::blocking::Client,
    identity: &Config,
) -> Result<()> {
    let pending = Path::new(STATE).join("ssh-events.json");
    let cursor_path = Path::new(STATE).join("journal-cursor.json");
    if pending.exists() {
        let batch: Value = read_state(&pending)?;
        send_events(client, identity, &batch["events"])?;
        write_state(&cursor_path, &batch["cursor"])?;
        fs::remove_file(&pending)?;
    }
    let cursor = read_state::<String>(&cursor_path).unwrap_or_default();
    let mut args = vec![
        "--unit=ssh.service",
        "--unit=sshd.service",
        "--output=json",
        "--no-pager",
        "--lines=201",
    ];
    if cursor.is_empty() {
        args.extend(["--since", "5 minutes ago"]);
    } else {
        args.extend(["--after-cursor", &cursor]);
    }
    let output = match command("/usr/bin/journalctl", &args, 15, 1_000_000) {
        Ok(output) => output,
        Err(_) => {
            // A rotated cursor cannot wedge collection forever. Make the missing interval visible.
            let output = command(
                "/usr/bin/journalctl",
                &[
                    "--unit=ssh.service",
                    "--unit=sshd.service",
                    "--output=json",
                    "--no-pager",
                    "--lines=199",
                    "--since",
                    "5 minutes ago",
                ],
                15,
                1_000_000,
            );
            post(
                client,
                identity,
                "events",
                &json!({"events":[gap(&format!("journal-gap-{}",now()/3600000))]}),
            )?;
            match output {
                Ok(v) => v,
                Err(_) => return Ok(()),
            }
        }
    };
    let rows: Vec<Value> = output
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let next = rows
        .last()
        .and_then(|r| r["__CURSOR"].as_str())
        .unwrap_or(&cursor)
        .to_string();
    let mut events: Vec<_> = rows
        .iter()
        .skip(rows.len().saturating_sub(199))
        .filter_map(parse)
        .collect();
    if rows.len() >= 201 || cursor.is_empty() {
        events.push(gap(&format!(
            "journal-window-{:x}",
            Sha256::digest(next.as_bytes())
        )));
    }
    if next.is_empty() && events.is_empty() {
        return Ok(());
    }
    let batch = json!({"cursor":next,"events":events});
    write_state(&pending, &batch)?;
    send_events(client, identity, &batch["events"])?;
    write_state(&cursor_path, &batch["cursor"])?;
    fs::remove_file(&pending)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_login_and_never_retains_raw_message() {
        let e=parse(&json!({"MESSAGE":"Accepted publickey for root from 2001:db8::1 port 1234 ssh2: RSA private-comment","__REALTIME_TIMESTAMP":"1700000000000000","__CURSOR":"cursor"})).unwrap();
        assert_eq!(e["kind"], "ssh.accepted");
        assert_eq!(e["user"], "root");
        assert_eq!(e["address"], "2001:db8::1");
        assert!(!e.to_string().contains("private-comment"));
        let e=parse(&json!({"MESSAGE":"Failed password for invalid user admin from 1.2.3.4 port 22 ssh2","__REALTIME_TIMESTAMP":"1700000000000000","__CURSOR":"cursor2"})).unwrap();
        assert_eq!(e["user"], "admin");
        assert_eq!(e["kind"], "ssh.rejected");
        assert!(parse(&json!({"MESSAGE":"arbitrary secret"})).is_none());
    }
}
