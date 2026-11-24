import { createFileRoute, redirect } from "@tanstack/react-router";
import { deploymentSearch } from "@/lib/deployment-sources";

export const Route = createFileRoute("/_authenticated/services_/new")({
  validateSearch: deploymentSearch,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/services",
      search: { ...search, deploy: true },
      replace: true,
    });
  },
});
