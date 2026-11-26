import type { MaintenanceStatus } from "@ephor/api/maintenance";

export async function requestMachineUpdate(actions: {
  waitForIdle?: boolean;
  preflight: () => Promise<MaintenanceStatus>;
  confirm: () => boolean;
  authenticate: () => Promise<unknown>;
  queue: (waitForIdle: boolean) => Promise<unknown>;
}) {
  const status = await actions.preflight();
  if (status.busy && !actions.waitForIdle) {
    const descriptions = status.blockers.map((blocker) => {
      const since = blocker.since
        ? ` (started ${new Date(blocker.since).toLocaleString()})`
        : "";
      return `${blocker.kind}${since}`;
    });
    throw new Error(
      `Update is waiting for ${descriptions.join(", ") || "machine work"}. No passkey is needed yet. Wait for completion, then retry.`,
    );
  }
  if (!actions.confirm()) return false;
  await actions.authenticate();
  await actions.queue(actions.waitForIdle === true);
  return true;
}
