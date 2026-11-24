#!/bin/sh
set -eu
task_dir=$(mktemp -d)
trap 'rm -rf "$task_dir"' EXIT HUP INT TERM
host=${1:-}
if [ "$host" = docker ] || [ "$host" = vps ]; then
  [ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ] || { echo 'Run this command with sudo on the Linux VPS.' >&2; exit 1; }
  [ -d /run/systemd/system ] || { echo 'A Linux VPS running systemd is required.' >&2; exit 1; }
  # These small distribution packages verify the standalone installer; no Node.js is needed.
  if ! command -v jq >/dev/null || ! command -v xxd >/dev/null || ! command -v curl >/dev/null || ! command -v openssl >/dev/null; then
    [ -f /etc/os-release ] || exit 1
    . /etc/os-release
    case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) ;;
      *) echo 'Automatic setup supports Ubuntu 22.04/24.04/26.04 and Debian 12/13.' >&2; exit 1;; esac
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl jq openssl xxd libstdc++6
  fi
else
  command -v node >/dev/null 2>&1 || { echo 'Install Node.js 22 or newer on this computer for the Cloudflare/Railway wizard.' >&2; exit 1; }
fi
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-filesize 2100000 'https://raw.githubusercontent.com/rasmussensolutions/ephor/panel-channel/panel-release.json' -o "$task_dir/release.json"
if [ "$host" = docker ] || [ "$host" = vps ]; then
  jq -er '.signature | select(test("^[a-f0-9]{128}$"))' "$task_dir/release.json" | xxd -r -p > "$task_dir/signature"
  printf '302a300506032b657003210069fcf97385688a836880535bad05d49fcf2b4a09bd54315546c458efe3d53b2b' | xxd -r -p > "$task_dir/key.der"
  printf 'ephor:panel-release:v1\n' > "$task_dir/signed"
  jq -j '.payload' "$task_dir/release.json" >> "$task_dir/signed"
  openssl pkeyutl -verify -pubin -inkey "$task_dir/key.der" -keyform DER -sigfile "$task_dir/signature" -rawin -in "$task_dir/signed" >/dev/null || { echo 'Untrusted Ephor release.' >&2; exit 1; }
  jq -r '.payload' "$task_dir/release.json" > "$task_dir/payload.json"
  case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo 'An x86-64 or ARM64 VPS is required.' >&2; exit 1;; esac
  version=$(jq -er '.version | select(test("^[0-9]+[.][0-9]+[.][0-9]+$"))' "$task_dir/payload.json")
  name="ephor-installer-linux-$arch"
  digest=$(jq -er --arg arch "$arch" --arg name "$name" '.vps[$arch] | select(.name == $name) | .sha256 | select(test("^[a-f0-9]{64}$"))' "$task_dir/payload.json")
  size=$(jq -er --arg arch "$arch" '.vps[$arch].size | select(type == "number" and . > 0 and . <= 157286400 and . == floor)' "$task_dir/payload.json")
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-filesize "$size" "https://github.com/rasmussensolutions/ephor/releases/download/panel-v$version/$name" -o "$task_dir/ephor-installer"
  [ "$(wc -c < "$task_dir/ephor-installer" | tr -d ' ')" = "$size" ] || { echo 'Installer size mismatch.' >&2; exit 1; }
  printf '%s  %s\n' "$digest" "$task_dir/ephor-installer" | sha256sum --check --status || { echo 'Installer checksum mismatch.' >&2; exit 1; }
  chmod 700 "$task_dir/ephor-installer"
  # Use a root-owned working directory: compiled runtimes must not load local .env/bunfig files.
  cd "$task_dir"
  if ( : </dev/tty ) 2>/dev/null; then
    ./ephor-installer "$@" "--release-file=$task_dir/release.json" </dev/tty
  else
    ./ephor-installer "$@" "--release-file=$task_dir/release.json" </dev/null
  fi
  exit $?
fi
node --input-type=module - "$task_dir" <<'JS'
import {readFile,writeFile} from 'node:fs/promises';
import {createPublicKey,verify,createHash} from 'node:crypto';
const dir=process.argv[2],e=JSON.parse(await readFile(`${dir}/release.json`,'utf8'));
const raw=Buffer.from('69fcf97385688a836880535bad05d49fcf2b4a09bd54315546c458efe3d53b2b','hex');
const key=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:raw.toString('base64url')},format:'jwk'});
if(!verify(null,Buffer.from(`ephor:panel-release:v1\n${e.payload}`),key,Buffer.from(e.signature,'hex')))throw Error('Untrusted release');
const r=JSON.parse(e.payload),a=r.installer;
if(!/^\d+\.\d+\.\d+$/.test(r.version)||a.name!=='install.mjs'||a.size>5_000_000)throw Error('Invalid installer');
const response=await fetch(`https://github.com/rasmussensolutions/ephor/releases/download/panel-v${r.version}/install.mjs`);
if(!response.ok)throw Error('Installer unavailable');
const reader=response.body.getReader();const chunks=[];let length=0;
for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>a.size){await reader.cancel();throw Error('Installer exceeds signed size');}chunks.push(value);}
const bytes=Buffer.concat(chunks);
if(bytes.length!==a.size||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw Error('Installer checksum mismatch');
await writeFile(`${dir}/install.mjs`,bytes,{mode:0o700});
JS
node "$task_dir/install.mjs" "$@" </dev/tty
