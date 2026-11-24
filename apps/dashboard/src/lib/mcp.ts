export interface ConnectionPolicy {
  projectIds: string[];
  machineIds: string[];
  allProjects: boolean;
  allMachines: boolean;
  manage: boolean;
  logs: boolean;
  repositories: boolean;
  execution: "approval" | "direct";
}

export function readPolicy(
  projectIds: string[] = [],
  machineIds: string[] = [],
): ConnectionPolicy {
  return {
    projectIds,
    machineIds,
    allProjects: false,
    allMachines: false,
    manage: false,
    logs: false,
    repositories: false,
    execution: "direct",
  };
}

export function authorizationId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : undefined;
}

export function connectionName(clientName: string): string {
  return (
    clientName
      .replace(/\p{Cc}/gu, "")
      .trim()
      .slice(0, 80) || "AI client"
  );
}
