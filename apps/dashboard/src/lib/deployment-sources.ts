import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";

export const deploymentSources = [
  { mode: "github", label: "GitHub repository", icon: GithubLogoIcon },
  { mode: "catalog", label: "Template", icon: StackIcon },
  { mode: "image", label: "Container image", icon: CubeIcon },
] as const;

export type DeploymentMode = (typeof deploymentSources)[number]["mode"];

export function deploymentSearch(search: Record<string, unknown>): {
  source?: DeploymentMode;
  machineId?: string;
  projectId?: string;
} {
  return {
    source:
      search.source === "database"
        ? "catalog"
        : deploymentSources.find(({ mode }) => mode === search.source)?.mode,
    machineId:
      typeof search.machineId === "string" && search.machineId
        ? search.machineId
        : undefined,
    projectId:
      typeof search.projectId === "string" && search.projectId
        ? search.projectId
        : undefined,
  };
}
