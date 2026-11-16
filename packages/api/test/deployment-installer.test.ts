import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentDependencies } from "../src/services/dependencies";

// Execute the generated dependency setup against a temporary host with mocked
// package/system commands. No packages, services, or system files are changed.
async function host(existing: boolean, conflict = false) {
  const root = await mkdtemp(join(tmpdir(), "ephor-dependencies-"));
  const bin = join(root, "bin"),
    etc = join(root, "etc");
  await mkdir(bin);
  await mkdir(join(etc, "apt/sources.list.d"), { recursive: true });
  await writeFile(
    join(etc, "os-release"),
    "ID=ubuntu\nVERSION_CODENAME=noble\n",
  );
  const executable = async (name: string, script: string) =>
    writeFile(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  await executable(
    "apt-get",
    `echo "$*" >> "$HOST_ROOT/packages"\ncase " $* " in *" docker-ce "*) cp "$HOST_ROOT/docker-stub" "$HOST_ROOT/bin/docker" ;; esac\ncase " $* " in *" git "*) cp "$HOST_ROOT/docker-stub" "$HOST_ROOT/bin/git" ;; esac`,
  );
  await executable(
    "dpkg-query",
    conflict ? "echo 'install ok installed'" : "exit 1",
  );
  await executable("dpkg", "echo amd64");
  await executable(
    "curl",
    'while [ "$#" -gt 0 ]; do\n if [ "$1" = -o ]; then shift; echo key > "$1"; fi\n shift\ndone',
  );
  await executable("systemctl", 'echo "$*" >> "$HOST_ROOT/services"');
  await writeFile(
    join(root, "docker-stub"),
    '#!/bin/sh\n[ "$1" != version ] || echo 28.1.0\nexit 0\n',
    { mode: 0o755 },
  );
  if (existing) {
    await executable("docker", '[ "$1" != version ] || echo 28.1.0');
    await executable("git", "exit 0");
  }
  const script = `set -eu\n${deploymentDependencies().replaceAll("/usr/bin/", `${bin}/`).replaceAll("/etc/", `${etc}/`)}\nIFS= read -r token\nprintf '%s' "$token"`;
  const proc = Bun.spawn(["sh", "-c", script], {
    env: {
      ...process.env,
      HOST_ROOT: root,
      PATH: `${bin}:${process.env.PATH}`,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write("enrollment-secret\n");
  proc.stdin.end();
  const [status, output, error] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { root, status, output, error };
}

test("fresh Ubuntu installs deployment dependencies without consuming credentials", async () => {
  const f = await host(false);
  try {
    expect(f.status).toBe(0);
    expect(f.output).toBe("enrollment-secret");
    expect(await readFile(join(f.root, "packages"), "utf8")).toContain(
      "install -y --no-remove docker-ce docker-ce-cli containerd.io docker-buildx-plugin",
    );
    expect(
      await readFile(
        join(f.root, "etc/apt/sources.list.d/docker.sources"),
        "utf8",
      ),
    ).toContain("https://download.docker.com/linux/ubuntu");
    expect(await readFile(join(f.root, "services"), "utf8")).toContain(
      "enable --now docker.service",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("existing deployment tools are preserved without package or service changes", async () => {
  const f = await host(true);
  try {
    expect(f.status).toBe(0);
    expect(f.output).toBe("enrollment-secret");
    expect(await Bun.file(join(f.root, "packages")).exists()).toBe(false);
    expect(await Bun.file(join(f.root, "services")).exists()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("conflicting runtime packages stop automatic Docker installation", async () => {
  const f = await host(false, true);
  try {
    expect(f.status).toBe(1);
    expect(f.error).toContain("requires manual Docker setup");
    expect(await readFile(join(f.root, "packages"), "utf8")).not.toContain(
      "docker-ce",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
