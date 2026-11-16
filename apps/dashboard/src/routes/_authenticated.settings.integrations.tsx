import { createFileRoute } from "@tanstack/react-router";
import { AiSettings } from "@/components/services/ai-settings";
import { GitHubConnection } from "@/components/services/github-source";
import { RegistrySettings } from "@/components/services/registry-settings";
import { SettingsPage } from "@/components/settings-layout";

export const Route = createFileRoute("/_authenticated/settings/integrations")({
  head: () => ({ meta: [{ title: "Integrations — Ephor" }] }),
  component: IntegrationsPage,
});

function IntegrationsPage() {
  return (
    <SettingsPage
      title="Integrations"
      description="Connect GitHub, your build registry, and an AI provider."
    >
      <div className="space-y-5">
        <AiSettings />
        <GitHubConnection />
        <RegistrySettings />
      </div>
    </SettingsPage>
  );
}
