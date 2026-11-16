import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/notifications_/settings")(
  {
    beforeLoad: () => {
      throw redirect({ to: "/settings/notifications", replace: true });
    },
  },
);
