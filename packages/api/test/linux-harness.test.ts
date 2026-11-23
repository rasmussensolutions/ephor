import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Linux harness stops on the first failure, cleans up, and rejects empty selections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ephor-harness-"));
  const calls = join(dir, "calls.jsonl");
  try {
    await writeFile(
      join(dir, "docker"),
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + "\\n");
if (args.includes("--list") && !process.env.EMPTY_SELECTION) {
  console.log("services::catalog_persistence_backup_restore: test\\nservices::a_failure: test\\nservices::z_later: test");
}
if (args.includes("--exact") && args.includes("services::a_failure")) process.exit(1);
`,
    );
    await chmod(join(dir, "docker"), 0o700);
    const run = async (empty: boolean) => {
      await writeFile(calls, "");
      const child = Bun.spawn(
        [process.execPath, resolve("scripts/test-services-linux.ts")],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            FIXTURE_CALLS: calls,
            EMPTY_SELECTION: empty ? "1" : "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const commands = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line): string[] => JSON.parse(line));
      return { code, output: stdout + stderr, commands };
    };
    const failed = await run(false);
    expect(failed.code).not.toBe(0);
    expect(
      failed.commands.filter((args) => args.includes("--exact")),
    ).toHaveLength(1);
    expect(failed.output).toContain("Starting services::a_failure");
    expect(failed.commands.at(-1)?.slice(0, 2)).toEqual(["rm", "-fv"]);
    const empty = await run(true);
    expect(empty.code).not.toBe(0);
    expect(empty.output).toContain("No Linux integration tests matched");
    expect(empty.commands.some((args) => args.includes("--exact"))).toBe(false);
    expect(empty.commands.at(-1)?.slice(0, 2)).toEqual(["rm", "-fv"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
