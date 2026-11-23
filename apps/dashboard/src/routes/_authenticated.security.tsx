import { createFileRoute } from "@tanstack/react-router";
import { SecurityWorkspace } from "@/components/security/security-workspace";

export const Route = createFileRoute("/_authenticated/security")({
  head: () => ({ meta: [{ title: "Security — Ephor" }] }),
  validateSearch: (
    search: Record<string, unknown>,
  ): { machine?: string; service?: string; finding?: string } => ({
    machine:
      typeof search.machine === "string" &&
      /^[a-f0-9-]{36}$/.test(search.machine)
        ? search.machine
        : undefined,
    service:
      typeof search.service === "string" &&
      /^[a-f0-9-]{36}$/.test(search.service)
        ? search.service
        : undefined,
    finding:
      typeof search.finding === "string" &&
      /^[a-f0-9]{64}$/.test(search.finding)
        ? search.finding
        : undefined,
  }),
  component: SecurityPage,
});
function SecurityPage() {
  const search = Route.useSearch();
  return (
    <SecurityWorkspace
      key={`${search.machine}:${search.service}`}
      initialMachine={search.machine}
      initialService={search.service}
      initialFinding={search.finding}
    />
  );
}
