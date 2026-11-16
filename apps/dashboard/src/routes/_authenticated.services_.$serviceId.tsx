import type { MachineList } from "@ephor/api/machines";
import { createFileRoute } from "@tanstack/react-router";
import { ServiceDetails } from "@/components/services/service-details";
import { api } from "@/lib/auth";
import type { ServiceList } from "@/lib/services";

export const Route = createFileRoute("/_authenticated/services_/$serviceId")({
  head: () => ({ meta: [{ title: "Service — Ephor" }] }),
  validateSearch: (
    search: Record<string, unknown>,
  ): { deploymentNotice?: string } => ({
    deploymentNotice:
      typeof search.deploymentNotice === "string"
        ? search.deploymentNotice
        : undefined,
  }),
  loader: async ({ params }) => {
    const [data, machines] = await Promise.all([
      api<ServiceList>(`/services/${params.serviceId}`),
      api<MachineList>("/machines"),
    ]);
    return { data, machines };
  },
  component: ServiceRoute,
});
function ServiceRoute() {
  const { serviceId } = Route.useParams();
  const { deploymentNotice } = Route.useSearch();
  return (
    <ServiceDetails
      key={serviceId}
      id={serviceId}
      initial={Route.useLoaderData()}
      initialNotice={deploymentNotice}
    />
  );
}
