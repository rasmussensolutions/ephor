import type { ConnectionPolicy } from "@/lib/mcp";

type Resource = { id: string; name: string };
export function ConnectionPermissions({
  policy,
  onChange,
  projects,
  machines,
  disabled = false,
}: {
  policy: ConnectionPolicy;
  onChange: (policy: ConnectionPolicy) => void;
  projects: Resource[];
  machines: Resource[];
  disabled?: boolean;
}) {
  const checkbox = (
    label: string,
    checked: boolean,
    change: (value: boolean) => void,
  ) => (
    <label className="flex items-start gap-3 text-sm leading-6">
      <input
        type="checkbox"
        className="mt-1.5 shrink-0"
        checked={checked}
        onChange={(event) => change(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
  const toggle = (
    key: "allProjects" | "allMachines" | "manage" | "logs" | "repositories",
    label: string,
  ) =>
    checkbox(label, policy[key], (value) =>
      onChange({ ...policy, [key]: value }),
    );
  const resources = (key: "projectIds" | "machineIds", values: Resource[]) => (
    <div className="ml-7 space-y-1 border-l pl-4">
      {values.length ? (
        values.map((value) => (
          <div key={value.id}>
            {checkbox(value.name, policy[key].includes(value.id), (checked) =>
              onChange({
                ...policy,
                [key]: checked
                  ? [...policy[key], value.id]
                  : policy[key].filter((id) => id !== value.id),
              }),
            )}
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">None available yet.</p>
      )}
    </div>
  );
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="mb-3 text-sm font-medium">Permissions</legend>
      {toggle(
        "allProjects",
        "Access all current and future projects (required to create projects)",
      )}
      {!policy.allProjects && resources("projectIds", projects)}
      {toggle("allMachines", "Access all current and future machines")}
      {!policy.allMachines && resources("machineIds", machines)}
      {toggle(
        "manage",
        "Create, configure, deploy, stop and roll back services in authorized projects",
      )}
      {policy.manage && !policy.allProjects && (
        <p className="ml-7 text-xs text-muted-foreground">
          Creating new projects requires access to all projects.
        </p>
      )}
      {toggle(
        "repositories",
        "Discover repositories in connected GitHub installations",
      )}
      {toggle(
        "logs",
        "Read application and build logs (may contain sensitive application output)",
      )}
      {checkbox(
        "Allow permitted actions directly from chat, without per-action approval in Ephor",
        policy.execution === "direct",
        (checked) =>
          onChange({ ...policy, execution: checked ? "direct" : "approval" }),
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        Secret values cannot be read through MCP. Deployments can use their
        configured secrets. Your AI client controls its confirmation prompts;
        Ephor enforces these permissions on every action.
      </p>
    </fieldset>
  );
}
