import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { savePresentation } from "@/lib/service-presentation";

export function DisplayNameEditor({
  id,
  name,
  component,
}: {
  id: string;
  name: string;
  component?: string;
}) {
  const inputId = useId();
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return editing ? (
    <form
      className="w-full space-y-2 rounded-lg border bg-card p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          await savePresentation(
            id,
            component
              ? { component: { id: component, name: draft } }
              : { name: draft },
          );
          setEditing(false);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Could not save name.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={inputId} className="block text-xs font-medium">
        Display name
        <Input
          id={inputId}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={80}
          disabled={busy}
          className="mt-2"
        />
      </label>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
          {busy ? "Saving…" : "Save name"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          disabled={busy}
          onClick={() => setEditing(false)}
        >
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Display only. Connections and deployments keep their existing
        identifiers.
      </p>
    </form>
  ) : (
    <Button
      variant="ghost"
      className="text-muted-foreground hover:text-foreground"
      size="icon-sm"
      aria-label={`Rename ${name}`}
      title="Change display name"
      onClick={() => {
        setDraft(name);
        setError("");
        setEditing(true);
      }}
    >
      <PencilSimpleIcon />
    </Button>
  );
}
