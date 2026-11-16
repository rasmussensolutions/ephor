import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/backups")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/backups", replace: true });
  },
});
