import { PageHeader } from "@ephor/ui/page-header";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/workflows")({
  head: () => ({ meta: [{ title: "Workflows — Ephor" }] }),
  component: WorkflowsPage,
});

function WorkflowsPage() {
  return <PageHeader title="Workflows" />;
}
