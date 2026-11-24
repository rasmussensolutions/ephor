import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/updates")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/updates", replace: true });
  },
});
