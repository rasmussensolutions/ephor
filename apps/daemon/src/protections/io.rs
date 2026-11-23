use super::STATE;
use anyhow::{Context, Result, ensure};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
pub fn root() -> Result<()> {
    ensure!(
        Command::new("/usr/bin/id").arg("-u").output()?.stdout == b"0\n",
        "Root is required"
    );
    if !Path::new(STATE).exists() {
        fs::create_dir(STATE)?;
        fs::set_permissions(STATE, fs::Permissions::from_mode(0o700))?;
    }
    let m = fs::symlink_metadata(STATE)?;
    ensure!(
        m.is_dir()
            && !m.file_type().is_symlink()
            && m.uid() == 0
            && m.permissions().mode() & 0o077 == 0,
        "Unsafe protection state directory"
    );
    Ok(())
}
pub fn write(path: &Path, value: &[u8]) -> Result<()> {
    let tmp = path.with_extension("new");
    if let Ok(m) = fs::symlink_metadata(&tmp) {
        ensure!(
            m.is_file() && !m.file_type().is_symlink() && m.uid() == 0,
            "Unsafe temporary file"
        );
        fs::remove_file(&tmp)?;
    }
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(value)?;
    f.sync_all()?;
    fs::rename(tmp, path)?;
    File::open(path.parent().context("Missing parent")?)?.sync_all()?;
    Ok(())
}
pub fn save(path: &Path, value: &impl Serialize) -> Result<()> {
    write(path, &serde_json::to_vec(value)?)
}
pub fn load<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let m = fs::symlink_metadata(path)?;
    ensure!(
        m.is_file()
            && !m.file_type().is_symlink()
            && m.uid() == 0
            && m.permissions().mode() & 0o077 == 0
            && m.len() < 1_000_000,
        "Unsafe protection state file"
    );
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
pub fn command(path: &str, args: &[&str], seconds: u64) -> Result<String> {
    let output = Path::new(STATE).join(format!(
        "command-output-{}-{:016x}",
        std::process::id(),
        rand::random::<u64>()
    ));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&output)?;
    // Unlink the output before spawning: interruptions never leave a file that blocks recovery.
    fs::remove_file(&output)?;
    let mut reader = file.try_clone()?;
    let mut child = Command::new(path)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("HOME", STATE)
        .env("LC_ALL", "C")
        .current_dir(STATE)
        .process_group(0)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(file)
        .spawn()
        .context("Protection tool unavailable")?;
    let start = Instant::now();
    let ok = loop {
        if let Some(status) = child.try_wait()? {
            break status.success();
        }
        if start.elapsed() > Duration::from_secs(seconds) || reader.metadata()?.len() > 2_000_000 {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{}", child.id())])
                .status();
            let _ = child.kill();
            let _ = child.wait();
            break false;
        }
        thread::sleep(Duration::from_millis(50));
    };
    ensure!(
        ok && reader.metadata()?.len() <= 2_000_000,
        "Protection command failed or timed out"
    );
    use std::io::{Seek, SeekFrom};
    reader.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    reader.take(2_000_001).read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).trim().to_string())
}
