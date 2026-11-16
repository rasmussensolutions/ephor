import { PageHeader } from "@ephor/ui/page-header";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/logs")({
  head: () => ({ meta: [{ title: "Logs — Ephor" }] }),
  component: LogsPage,
});

function LogsPage() {
  return <PageHeader title="Logs" />;
}
