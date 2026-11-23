#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo 'Install Node.js 22 or newer, then run this installer again.' >&2; exit 1; }
task_dir=$(mktemp -d)
trap 'rm -rf "$task_dir"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 'https://raw.githubusercontent.com/rasmussensolutions/ephor/panel-channel/panel-release.json' -o "$task_dir/release.json"
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
