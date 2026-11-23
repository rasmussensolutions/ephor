import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApi } from "../src";
import { randomToken } from "../src/auth/store";
import { Releases } from "../src/machines/releases";
import { MachineStore } from "../src/machines/store";
import { Updates } from "../src/machines/updates";
import { Browser, enrolled } from "./helpers";

// Runs the production Linux executable against the real API and database over verified
// HTTPS. Only systemctl is replaced: its restart launches the real daemon as ephord.
// No root operations touch the host; the container has no host mounts except fixtures.
test.skipIf(!process.env.EPHOR_TEST_LINUX_UPDATER)(
  "Linux updater: install, receipt retry, tamper rejection, rollback and crash recovery",
  async () => {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const platform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
    const directory = await mkdtemp(join(tmpdir(), "ephor-update-e2e-"));
    const container = `ephor-updater-test-${randomToken().slice(0, 12)}`;
    async function command(args: string[]) {
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code)
        throw new Error(
          `Test command ${args[0]} failed: ${stderr.slice(0, 2000)}`,
        );
      return stdout;
    }
    const exec = (...args: string[]) =>
      command(["docker", "exec", container, ...args]);
    const f = await enrolled();
    const machines = new MachineStore(f.sql);
    const ticket = await machines.create("Linux updater fixture");
    const credential = randomToken();
    await machines.enroll(ticket.token, credential);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = Buffer.from(
      keys.publicKey.export({ format: "jwk" }).x ?? "",
      "base64url",
    ).toString("hex");
    const binary = await readFile(
      resolve(`apps/dashboard/public/daemon/ephord-linux-${arch}`),
    );
    const bundled = JSON.parse(
      await readFile(
        resolve("apps/dashboard/public/daemon/manifest.json"),
        "utf8",
      ),
    );
    const [major, minor, patch] = String(bundled.version)
      .split(".")
      .map(Number);
    const nextVersion = `${major}.${minor}.${(patch ?? 0) + 1}`;
    const old = Buffer.from(
      '#!/bin/sh\nif [ "$1" = --version ]; then echo "ephord 0.0.0"; exit 0; fi\nif [ "$1" = --build-info ]; then exit 1; fi\nexec sleep infinity\n',
    );
    let artifact: Uint8Array = binary;
    let denyReceipt = false;
    let artifactHadCredential = false;
    let app: ReturnType<typeof createApi>;
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      await writeFile(
        join(directory, "ca.cnf"),
        "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Ephor integration CA\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n",
      );
      await writeFile(
        join(directory, "leaf.cnf"),
        "[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=host.docker.internal\n[ext]\nsubjectAltName=DNS:host.docker.internal\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
      );
      await command([
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        join(directory, "ca-key.pem"),
        "-out",
        join(directory, "ca.pem"),
        "-config",
        join(directory, "ca.cnf"),
      ]);
      await command([
        "openssl",
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "leaf.csr"),
        "-config",
        join(directory, "leaf.cnf"),
      ]);
      await command([
        "openssl",
        "x509",
        "-req",
        "-in",
        join(directory, "leaf.csr"),
        "-CA",
        join(directory, "ca.pem"),
        "-CAkey",
        join(directory, "ca-key.pem"),
        "-CAcreateserial",
        "-days",
        "1",
        "-extfile",
        join(directory, "leaf.cnf"),
        "-extensions",
        "ext",
        "-out",
        join(directory, "cert.pem"),
      ]);
      server = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        tls: {
          key: Bun.file(join(directory, "key.pem")),
          cert: Bun.file(join(directory, "cert.pem")),
        },
        fetch: async (req) => {
          if (
            ["/artifact", `/daemon/ephord-linux-${arch}`].includes(
              new URL(req.url).pathname,
            )
          ) {
            artifactHadCredential ||= req.headers.has("authorization");
            return new Response(new Uint8Array(artifact));
          }
          if (denyReceipt && new URL(req.url).pathname.endsWith("/report")) {
            const body = await req.clone().json();
            if (body.status === "succeeded")
              return new Response("lost", { status: 503 });
          }
          return app.fetch(req);
        },
      });
      const panel = `https://host.docker.internal:${server.port}`;
      const env = {
        ...f.env,
        origin: panel,
        releaseUrl: `${panel}/release.json`,
        releasePublicKey: publicKey,
        loadDaemonRelease: async () => ({ ...bundled, updaterProtocol: 2 }),
      };
      app = createApi(env);
      const browser = new Browser(app);
      for (const [key, value] of f.browser.cookies)
        browser.cookies.set(key.replace(/^ephor\./, "__Host-ephor."), value);
      const updates = new Updates(
        f.sql,
        new Releases(f.sql, env.releaseUrl, publicKey),
      );
      async function release(version: string, bytes: Uint8Array, protocol = 1) {
        artifact = bytes;
        const manifest = JSON.stringify({
          schema: 1,
          version,
          buildId: bundled.buildId,
          protocol: 1,
          updaterProtocol: protocol,
          channel: "stable",
          expiresAt: Date.now() + 3600000,
          artifacts: {
            [arch]: {
              url: `${panel}/artifact`,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              size: bytes.length,
            },
          },
        });
        const envelope = {
          manifest,
          signature: sign(
            null,
            Buffer.from(manifest),
            keys.privateKey,
          ).toString("hex"),
        };
        await f.sql.query(
          "UPDATE ephor_release SET envelope=$1, checked_at=$2, next_check=$3 WHERE id=1",
          [JSON.stringify(envelope), Date.now(), Date.now() + 900000],
        );
      }
      await writeFile(
        join(directory, "identity.json"),
        JSON.stringify({ panel, credential, machineId: ticket.id }),
        { mode: 0o600 },
      );
      await writeFile(join(directory, "ephord"), binary, { mode: 0o755 });
      await writeFile(join(directory, "old"), old, { mode: 0o755 });
      await writeFile(
        join(directory, "systemctl"),
        `#!/bin/sh
set -eu
case "$1" in show-environment|daemon-reload|enable) exit 0 ;; esac
[ "$1" != start ] || [ "$2" != --no-block ] || exit 0
action="$1"
for arg do unit="$arg"; done
case "$unit" in
 ephord.service) binary=/usr/local/bin/ephord; user=ephord ;;
 ephor-services.service) binary=/usr/local/libexec/ephor-services; user=ephord ;;
 ephor-security.service) binary=/usr/local/libexec/ephor-security; user=root ;;
 ephor-protections.service) binary=/usr/local/libexec/ephor-protections; user=root ;;
 *) exit 1 ;;
esac
pidfile="/run/$unit.pid"
case "$action" in
 is-active) [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; exit $? ;;
 show)
   if [ "$2" = --property=ExecStart ]; then
     case "$unit" in
       ephor-services.service) mode=service-worker ;;
       ephor-security.service) mode=security-worker ;;
       ephor-protections.service) mode=protection-worker ;;
       *) exit 1 ;;
     esac
     printf '{ path=%s ; argv[]=%s %s ; ignore_errors=no ; pid=%s ; code=(null) ; status=0/0 }\\n' "$binary" "$binary" "$mode" "$(cat "$pidfile")"
   else cat "$pidfile"; fi
   exit 0 ;;
 restart|start|stop) ;;
 *) exit 1 ;;
esac
if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; fi
rm -f "$pidfile"
[ "$action" != stop ] || exit 0
if [ -f /run/fail-once ] && [ "$unit" = ephor-services.service ]; then rm /run/fail-once; exit 1; fi
start-stop-daemon --start --background --make-pidfile --pidfile "$pidfile" --chuid "$user" --startas "$binary" -- run --config /var/lib/ephord/identity.json
`,
        { mode: 0o755 },
      );
      await command([
        "docker",
        "run",
        "-d",
        "--name",
        container,
        "--platform",
        platform,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--mount",
        `type=bind,source=${directory},target=/fixtures,readonly`,
        "ephor-updater-test",
      ]);
      await exec(
        "sh",
        "-ec",
        `useradd --system ephord
install -d -m 0700 -o ephord /var/lib/ephord
install -m 0600 -o ephord /fixtures/identity.json /var/lib/ephord/identity.json
install -m 0755 /fixtures/old /usr/local/bin/ephord
mkdir -p /etc/systemd/system
touch /etc/systemd/system/ephord.service
install -m 0755 /fixtures/systemctl /usr/bin/systemctl
cp /fixtures/ca.pem /usr/local/share/ca-certificates/ephor-test.crt
update-ca-certificates >/dev/null`,
      );
      await exec(
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        `${panel}/api/agent/updater.sh`,
        "-o",
        "/tmp/updater.sh",
      );
      await exec("sh", "/tmp/updater.sh");
      expect(
        (await exec("stat", "-c", "%a", "/etc/ephor/updater.json")).trim(),
      ).toBe("600");
      // Honor the restrictive production service umask during every update.
      const tick = () =>
        exec(
          "sh",
          "-ec",
          "umask 077; /usr/local/libexec/ephor-updater update-worker",
        );
      await tick();
      await machines.ingest(ticket.id, {
        version: 1,
        hostname: "fixture",
        os: "Linux",
        arch,
        agentVersion: "0.0.0",
        cpuCount: 1,
        cpuPercent: 0,
        memoryTotal: 1024,
        memoryUsed: 1,
        uptime: 0,
        disks: [],
      });
      await release(bundled.version, binary);
      const request = await browser.request(
        "/machines/updates",
        { id: ticket.id },
        { origin: panel },
      );
      expect(request.status).toBe(200);
      denyReceipt = true;
      await expect(tick()).rejects.toThrow();
      expect(await exec("cat", "/var/lib/ephor-updater/version")).toBe(
        bundled.version,
      );
      expect(
        (await exec("stat", "-c", "%a", "/usr/local/bin/ephord")).trim(),
      ).toBe("755");
      expect((await machines.list())[0]?.telemetry?.agentBuildId).toBe(
        bundled.buildId,
      );
      denyReceipt = false;
      await tick();
      expect((await updates.list())[0]?.status).toBe("succeeded");
      expect(artifactHadCredential).toBe(false);
      // A valid signature over a different digest must not install modified downloads.
      await release(nextVersion, binary);
      artifact = Buffer.from("tampered");
      await updates.queue(ticket.id);
      await tick();
      expect((await updates.list())[0]?.status).toBe("failed");
      expect(
        (await exec("sha256sum", "/usr/local/bin/ephord")).split(" ")[0],
      ).toBe(createHash("sha256").update(binary).digest("hex"));
      // A correctly signed executable that crashes must automatically restore the old daemon.
      const broken = Buffer.from("#!/bin/sh\nexit 1\n");
      await release(nextVersion, broken);
      await updates.queue(ticket.id);
      await tick();
      expect((await updates.list())[0]?.status).toBe("rolled_back");
      expect(await exec("cat", "/var/lib/ephor-updater/version")).toBe(
        bundled.version,
      );
      expect(
        (await exec("sha256sum", "/usr/local/bin/ephord")).split(" ")[0],
      ).toBe(createHash("sha256").update(binary).digest("hex"));
      // Simulate a crash after replacing the binary but before acknowledging health.
      const journal = JSON.parse(
        await exec("cat", "/var/lib/ephor-updater/journal.json"),
      );
      journal.status = "installing";
      await writeFile(
        join(directory, "crash-journal.json"),
        JSON.stringify(journal),
      );
      await exec(
        "sh",
        "-ec",
        "install -m 0600 /fixtures/crash-journal.json /var/lib/ephor-updater/journal.json; printf '#!/bin/sh\\nexit 1\\n' > /usr/local/bin/crashed; chmod 0755 /usr/local/bin/crashed; mv /usr/local/bin/crashed /usr/local/bin/ephord",
      );
      await tick();
      expect(
        (await exec("sha256sum", "/usr/local/bin/ephord")).split(" ")[0],
      ).toBe(createHash("sha256").update(binary).digest("hex"));
      expect(
        JSON.parse(await exec("cat", "/var/lib/ephor-updater/journal.json"))
          .status,
      ).toBe("rolled_back");

      // A unified release converges all five copies, including the updater itself.
      // Security is installed but stopped; it must remain stopped. Missing roles are
      // separately covered by inventory/queue tests and never synthesized by updates.
      await exec(
        "sh",
        "-ec",
        `
for role in services security protections; do install -m 0755 /fixtures/old "/usr/local/libexec/ephor-$role"; done
systemctl restart ephord.service
systemctl start ephor-services.service
systemctl start ephor-protections.service
`,
      );
      await tick();
      const beforeUpdater = (
        await exec("stat", "-c", "%i", "/usr/local/libexec/ephor-updater")
      ).trim();
      const oldHash = createHash("sha256").update(old).digest("hex");
      const newHash = createHash("sha256").update(binary).digest("hex");
      const paths = [
        "/usr/local/bin/ephord",
        ...["services", "security", "protections", "updater"].map(
          (r) => `/usr/local/libexec/ephor-${r}`,
        ),
      ];
      await release(bundled.version, binary, 2);
      const whole = await browser.request(
        "/machines/updates",
        { id: ticket.id, wholeMachine: true },
        { origin: panel },
      );
      expect(whole.status).toBe(200);
      await tick();
      expect((await updates.list())[0]?.status).toBe("succeeded");
      for (const path of paths)
        expect((await exec("sha256sum", path)).split(" ")[0]).toBe(newHash);
      expect(
        (
          await exec("stat", "-c", "%i", "/usr/local/libexec/ephor-updater")
        ).trim(),
      ).not.toBe(beforeUpdater);
      expect(
        await exec(
          "sh",
          "-c",
          "systemctl is-active ephor-security.service || echo stopped",
        ),
      ).toContain("stopped");
      // The new updater understands the journal written by the previous running inode.
      const unifiedJournal = JSON.parse(
        await exec("cat", "/var/lib/ephor-updater/journal.json"),
      );
      expect(unifiedJournal.components).toHaveLength(5);
      unifiedJournal.status = "installing";
      // Crash before the terminal receipt reaches the panel.
      await f.sql.query(
        "UPDATE ephor_update SET status='installing' WHERE id=$1",
        [unifiedJournal.job.id],
      );
      await writeFile(
        join(directory, "crash-suite.json"),
        JSON.stringify(unifiedJournal),
      );
      await exec(
        "sh",
        "-ec",
        "install -m 0600 /fixtures/crash-suite.json /var/lib/ephor-updater/journal.json",
      );
      await tick();
      for (const role of ["services", "security", "protections"])
        expect(
          (await exec("sha256sum", `/usr/local/libexec/ephor-${role}`)).split(
            " ",
          )[0],
        ).toBe(oldHash);
      expect(
        JSON.parse(await exec("cat", "/var/lib/ephor-updater/journal.json"))
          .status,
      ).toBe("rolled_back");
      // Fail a later helper restart after all binaries have been replaced. Restore
      // the entire previous set, retaining the originally stopped security helper.
      await exec("touch", "/run/fail-once");
      await updates.queue(ticket.id, true);
      await tick();
      expect((await updates.list())[0]?.status).toBe("rolled_back");
      for (const role of ["services", "security", "protections"])
        expect(
          (await exec("sha256sum", `/usr/local/libexec/ephor-${role}`)).split(
            " ",
          )[0],
        ).toBe(oldHash);
      expect(
        (await exec("sha256sum", "/usr/local/libexec/ephor-updater")).split(
          " ",
        )[0],
      ).toBe(newHash);
      expect(
        await exec(
          "sh",
          "-c",
          "systemctl is-active ephor-security.service || echo stopped",
        ),
      ).toContain("stopped");
      // A crash while only prepared must not restart any running helper.
      const prepared = JSON.parse(
        await exec("cat", "/var/lib/ephor-updater/journal.json"),
      );
      prepared.status = "prepared";
      await f.sql.query(
        "UPDATE ephor_update SET status='downloading',install_started=0 WHERE id=$1",
        [prepared.job.id],
      );
      await writeFile(
        join(directory, "prepared.json"),
        JSON.stringify(prepared),
      );
      await exec(
        "install",
        "-m",
        "0600",
        "/fixtures/prepared.json",
        "/var/lib/ephor-updater/journal.json",
      );
      const previousPid = await exec("cat", "/run/ephor-services.service.pid");
      await tick();
      expect(await exec("cat", "/run/ephor-services.service.pid")).toBe(
        previousPid,
      );
      expect((await updates.list())[0]?.status).toBe("failed");
      // Missing optional components stay absent after a normal update.
      await exec("systemctl", "stop", "ephor-protections.service");
      await exec("rm", "/usr/local/libexec/ephor-protections");
      await tick();
      await updates.queue(ticket.id, true);
      await tick();
      expect((await updates.list())[0]?.status).toBe("succeeded");
      expect(
        await exec(
          "sh",
          "-c",
          "test ! -e /usr/local/libexec/ephor-protections && echo absent",
        ),
      ).toContain("absent");
      // Migrate real legacy files to one canonical inode, preserving inactive roles.
      await exec(
        "sh",
        "-ec",
        "touch /etc/systemd/system/ephor-services.service /etc/systemd/system/ephor-security.service; install -m 0755 /fixtures/ephord /tmp/migrate-ephord",
      );
      const { hash } = await import("../src/auth/store");
      const lease = randomToken();
      await f.sql.query(
        "UPDATE ephor_machine SET maintenance_token_hash=$2,maintenance_expires=$3 WHERE id=$1",
        [ticket.id, await hash(lease), Date.now() + 600000],
      );
      await exec(
        "sh",
        "-ec",
        `printf '%s\\n' '${lease}' | /tmp/migrate-ephord maintenance-start`,
      );
      // Unknown symlinks must not be followed or overwritten.
      await exec(
        "ln",
        "-s",
        "/etc/passwd",
        "/usr/local/libexec/ephor-protections",
      );
      await expect(
        exec("/tmp/migrate-ephord", "migrate-layout"),
      ).rejects.toThrow();
      await exec("rm", "/usr/local/libexec/ephor-protections");
      // A failed restart rolls back the migration, including legacy regular files.
      await exec("touch", "/run/fail-once");
      await expect(
        exec("/tmp/migrate-ephord", "migrate-layout"),
      ).rejects.toThrow();
      expect(
        await exec(
          "sh",
          "-ec",
          "test ! -L /usr/local/libexec/ephor-services && test ! -f /var/lib/ephor-updater/shared-layout && echo restored",
        ),
      ).toContain("restored");
      await exec("/tmp/migrate-ephord", "migrate-layout");
      // Recover a power loss after conversion but before the migration commits.
      const interruptedLayout = JSON.parse(
        await exec("cat", "/var/lib/ephor-updater/layout.json"),
      );
      interruptedLayout.status = "installing";
      await writeFile(
        join(directory, "layout-crash.json"),
        JSON.stringify(interruptedLayout),
      );
      await exec(
        "install",
        "-m",
        "0600",
        "/fixtures/layout-crash.json",
        "/var/lib/ephor-updater/layout.json",
      );
      await exec("/tmp/migrate-ephord", "recover-layout");
      expect(
        await exec(
          "sh",
          "-ec",
          "test ! -L /usr/local/libexec/ephor-services && test ! -e /var/lib/ephor-updater/shared-layout && echo recovered",
        ),
      ).toContain("recovered");
      await exec("/tmp/migrate-ephord", "migrate-layout");
      await exec("/usr/local/bin/ephord", "layout-check");
      for (const role of ["services", "security", "updater"])
        expect(
          (await exec("readlink", `/usr/local/libexec/ephor-${role}`)).trim(),
        ).toBe("/usr/local/bin/ephord");
      expect(
        await exec(
          "sh",
          "-ec",
          "test ! -e /usr/local/libexec/ephor-protections && echo absent",
        ),
      ).toContain("absent");
      expect(
        await exec(
          "sh",
          "-c",
          "systemctl is-active ephor-security.service || echo stopped",
        ),
      ).toContain("stopped");
      await exec(
        "sh",
        "-ec",
        `printf '%s\\n' '${lease}' | /usr/local/bin/ephord maintenance-end`,
      );
      await tick();
      expect((await machines.list())[0]?.maintenance?.protocol).toBe(3);
      // Simulate an older shared installation; execute the production updater from
      // the saved candidate so the fixture needn't build a second historical release.
      await exec(
        "sh",
        "-ec",
        "install -m 0755 /fixtures/old /usr/local/bin/old-shared; mv /usr/local/bin/old-shared /usr/local/bin/ephord",
      );
      const sharedTick = () => exec("/tmp/migrate-ephord", "update-worker");
      await sharedTick();
      await release(bundled.version, binary, 3);
      await updates.queue(ticket.id, true);
      await sharedTick();
      expect((await updates.list())[0]?.status).toBe("succeeded");
      const inode = (
        await exec("stat", "-c", "%i", "/usr/local/bin/ephord")
      ).trim();
      for (const role of ["services", "security", "updater"])
        expect(
          (
            await exec(
              "stat",
              "-L",
              "-c",
              "%i",
              `/usr/local/libexec/ephor-${role}`,
            )
          ).trim(),
        ).toBe(inode);
      // A failed shared update restores one file and every alias still resolves to it.
      await tick();
      await release(
        nextVersion,
        Buffer.concat([binary, Buffer.from("\nrollback fixture\n")]),
        3,
      );
      await updates.queue(ticket.id, true);
      await exec("touch", "/run/fail-once");
      await tick();
      expect((await updates.list())[0]?.status).toBe("rolled_back");
      for (const role of ["services", "security", "updater"])
        expect(
          (await exec("readlink", `/usr/local/libexec/ephor-${role}`)).trim(),
        ).toBe("/usr/local/bin/ephord");
      const sharedJournal = JSON.parse(
        await exec("cat", "/var/lib/ephor-updater/journal.json"),
      );
      expect(sharedJournal.shared).toBe(true);
      sharedJournal.status = "installing";
      await f.sql.query(
        "UPDATE ephor_update SET status='installing' WHERE id=$1",
        [sharedJournal.job.id],
      );
      await writeFile(
        join(directory, "shared-crash.json"),
        JSON.stringify(sharedJournal),
      );
      await exec(
        "install",
        "-m",
        "0600",
        "/fixtures/shared-crash.json",
        "/var/lib/ephor-updater/journal.json",
      );
      await tick();
      expect((await updates.list())[0]?.status).toBe("rolled_back");
      await expect(exec("sh", "/tmp/updater.sh")).rejects.toThrow();
      // Setup is idempotent for the existing trust pin and rejects a silent key change.
      await expect(
        exec(
          "/usr/local/libexec/ephor-updater",
          "configure-updater",
          "f".repeat(64),
          panel,
          bundled.version,
        ),
      ).rejects.toThrow();
    } finally {
      await command(["docker", "rm", "-f", container]).catch(() => {});
      server?.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  600000,
);
