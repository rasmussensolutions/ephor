import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { api, reauthenticate } from "@/lib/auth";

export function RegistrySettings() {
  const formId = useId();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  return (
    <Collapsible className="settings-surface rounded-xl p-4">
      <CollapsibleTrigger className="text-sm font-medium">
        Build registry
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <p className="mt-3 text-xs text-muted-foreground">
          Only needed when building on a different machine. Use a private
          registry namespace dedicated to Ephor. Build workers receive the push
          token; deployment workers receive the separate pull-only token.
        </p>
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const data = new FormData(form);
            setBusy(true);
            setMessage("");
            try {
              await reauthenticate();
              await api("/integrations/build-registry", {
                prefix: data.get("prefix"),
                push: {
                  username: data.get("pushUser"),
                  password: data.get("pushPassword"),
                },
                pull: {
                  username: data.get("pullUser"),
                  password: data.get("pullPassword"),
                },
              });
              form.reset();
              setMessage(
                "Registry saved. Separate build machines are ready to use.",
              );
            } catch (error) {
              setMessage(
                error instanceof Error
                  ? error.message
                  : "Could not save registry.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label
            htmlFor={`${formId}-1`}
            className="space-y-1 text-xs sm:col-span-2"
          >
            <span>Image namespace</span>
            <Input
              id={`${formId}-1`}
              name="prefix"
              required
              placeholder="ghcr.io/your-organization/ephor"
            />
          </label>
          <label htmlFor={`${formId}-2`} className="space-y-1 text-xs">
            <span>Push username</span>
            <Input id={`${formId}-2`} name="pushUser" required />
          </label>
          <label htmlFor={`${formId}-3`} className="space-y-1 text-xs">
            <span>Push token</span>
            <Input
              id={`${formId}-3`}
              name="pushPassword"
              type="password"
              autoComplete="new-password"
              required
            />
          </label>
          <label htmlFor={`${formId}-4`} className="space-y-1 text-xs">
            <span>Pull username</span>
            <Input id={`${formId}-4`} name="pullUser" required />
          </label>
          <label htmlFor={`${formId}-5`} className="space-y-1 text-xs">
            <span>Pull-only token</span>
            <Input
              id={`${formId}-5`}
              name="pullPassword"
              type="password"
              autoComplete="new-password"
              required
            />
          </label>
          <div className="sm:col-span-2">
            <Button type="submit" variant="outline" disabled={busy}>
              {busy ? "Saving…" : "Save registry"}
            </Button>
            {message && (
              <p role="status" className="mt-2 text-sm">
                {message}
              </p>
            )}
          </div>
        </form>
      </CollapsibleContent>
    </Collapsible>
  );
}
