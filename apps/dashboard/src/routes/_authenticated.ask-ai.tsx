import { PageHeader } from "@ephor/ui/page-header";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/ask-ai")({
  head: () => ({ meta: [{ title: "Ask AI — Ephor" }] }),
  component: AskAiPage,
});

function AskAiPage() {
  return <PageHeader title="Ask AI" />;
}
