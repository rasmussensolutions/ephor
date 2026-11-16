import { PageHeader } from "@ephor/ui/page-header";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/monitors")({
  head: () => ({ meta: [{ title: "Monitors — Ephor" }] }),
  component: MonitorsPage,
});

function MonitorsPage() {
  return <PageHeader title="Monitors" />;
}
