use super::{STATE, io};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{net::IpAddr, path::Path};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ban {
    pub ip: IpAddr,
    pub reason: String,
    pub remaining_seconds: u64,
}
pub fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_multicast()
                && !v.is_broadcast()
                && !v.is_documentation()
                && o[0] != 0
                && o[0] < 224
                && !(o[0] == 100 && (64..=127).contains(&o[1]))
                && !(o[0] == 198 && (18..=19).contains(&o[1]))
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && s[1] == 0x0db8)
                && v.to_ipv4_mapped().is_none()
        }
    }
}
pub fn validate_ports(ports: &[u16]) -> Result<()> {
    ensure!(
        !ports.is_empty()
            && ports.len() <= 8
            && ports.iter().all(|p| *p > 0 && *p != 80 && *p != 443),
        "SSH ports unavailable or overlap public web ports"
    );
    Ok(())
}
pub fn rules(ports: &[u16], trusted: &[IpAddr], bans: &[Ban], exists: bool) -> Result<String> {
    validate_ports(ports)?;
    ensure!(
        !trusted.is_empty() && trusted.len() <= 32,
        "Trusted administrator addresses required"
    );
    let mut script = if exists {
        "delete table inet ephor_crowdsec\n".to_string()
    } else {
        String::new()
    };
    script.push_str("table inet ephor_crowdsec {\n set blocked4 { type ipv4_addr; flags timeout; timeout 60s; }\n set blocked6 { type ipv6_addr; flags timeout; timeout 60s; }\n chain ssh { type filter hook input priority -5; policy accept;\n");
    let ports = ports
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    // Never touch forwarding/output, default policies, established sessions, or non-SSH ports.
    script.push_str(&format!("ct state new tcp dport {{ {ports} }} ip saddr @blocked4 drop\nct state new tcp dport {{ {ports} }} ip6 saddr @blocked6 drop\n }}\n}}\n"));
    for b in bans.iter().take(100) {
        if !public(b.ip) || trusted.contains(&b.ip) || b.remaining_seconds == 0 {
            continue;
        }
        let set = if b.ip.is_ipv4() {
            "blocked4"
        } else {
            "blocked6"
        };
        script.push_str(&format!(
            "add element inet ephor_crowdsec {set} {{ {} timeout {}s }}\n",
            b.ip,
            b.remaining_seconds.min(60)
        ));
    }
    Ok(script)
}
pub fn exists() -> bool {
    io::command(
        "/usr/sbin/nft",
        &["list", "table", "inet", "ephor_crowdsec"],
        5,
    )
    .is_ok()
}
pub fn clear() -> Result<()> {
    if exists() {
        io::command(
            "/usr/sbin/nft",
            &["delete", "table", "inet", "ephor_crowdsec"],
            5,
        )?;
    }
    Ok(())
}
pub fn apply(ports: &[u16], trusted: &[IpAddr], bans: &[Ban]) -> Result<()> {
    let script = rules(ports, trusted, bans, exists())?;
    let path = Path::new(STATE).join("firewall.nft");
    io::write(&path, script.as_bytes())?;
    io::command(
        "/usr/sbin/nft",
        &["--check", "--file", path.to_str().unwrap()],
        5,
    )?;
    io::command("/usr/sbin/nft", &["--file", path.to_str().unwrap()], 5)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_and_no_public_service_rules() {
        let trusted = ["8.8.8.8".parse().unwrap()];
        let bans = [
            "8.8.8.8",
            "1.1.1.1",
            "100.64.0.1",
            "10.0.0.1",
            "::ffff:1.1.1.1",
            "2606:4700:4700::1111",
        ]
        .map(|ip| Ban {
            ip: ip.parse().unwrap(),
            reason: "ssh".into(),
            remaining_seconds: 3600,
        });
        let s = rules(&[22, 2222], &trusted, &bans, false).unwrap();
        assert!(s.contains("1.1.1.1 timeout 60s"));
        assert!(s.contains("blocked6 { 2606:"));
        for excluded in [
            "8.8.8.8",
            "100.64.0.1",
            "10.0.0.1",
            "::ffff:",
            "forward",
            "output",
            "policy drop",
            "flush ruleset",
        ] {
            assert!(!s.contains(excluded));
        }
        assert!(s.contains("ct state new tcp dport { 22, 2222 }"));
        assert!(rules(&[443], &trusted, &bans, false).is_err());
        assert!(rules(&[22], &[], &bans, false).is_err());
    }
}
