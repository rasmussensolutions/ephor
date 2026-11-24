import { createFileRoute } from "@tanstack/react-router";
import { AuthScreen } from "@/components/auth-screen";
import { authorizationId } from "@/lib/mcp";
export const Route = createFileRoute("/login")({
  validateSearch: (search): { authorization?: string } => ({
    authorization: authorizationId(search.authorization),
  }),
  component: () => (
    <AuthScreen mode="login" authorization={Route.useSearch().authorization} />
  ),
});
