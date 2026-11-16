import { PageHeader } from "@ephor/ui/page-header";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/fixes")({
  head: () => ({ meta: [{ title: "Fixes — Ephor" }] }),
  component: FixesPage,
});

function FixesPage() {
  return <PageHeader title="Fixes" />;
}
