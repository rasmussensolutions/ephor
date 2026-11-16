import { PageHeader } from "@ephor/ui/page-header";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/updates")({
  head: () => ({ meta: [{ title: "Updates — Ephor" }] }),
  component: UpdatesPage,
});

function UpdatesPage() {
  return <PageHeader title="Updates" />;
}
