import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, reauthenticate } from "@/lib/auth";

type Variables = {
  revision: string;
  variables: { name: string; references: string[] }[];
};
export function ComponentVariables({ id, name }: { id: string; name: string }) {
  const [data, setData] = useState<Variables | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const active = useRef(true);
  const endpoint = `/services/${id}/components/${encodeURIComponent(name)}/variables`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads metadata after an error or revision conflict.
  useEffect(() => {
    active.current = true;
    let current = true;
    setError("");
    setRevealed({});
    void api<Variables>(endpoint)
      .then((next) => {
        if (current) setData(next);
      })
      .catch((e) => {
        if (current)
          setError(
            e instanceof Error ? e.message : "Could not load variables.",
          );
      });
    const hide = () => {
      if (document.hidden) setRevealed({});
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      current = false;
      active.current = false;
      document.removeEventListener("visibilitychange", hide);
    };
  }, [endpoint, attempt]);
  async function reveal(variable: string, copy = false) {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let value = revealed[variable];
      if (value === undefined) {
        await reauthenticate();
        if (!active.current) return;
        const result = await api<{ value: string }>(`${endpoint}/reveal`, {
          name: variable,
          revision: data.revision,
        });
        value = result.value;
      }
      if (!active.current || document.hidden) return;
      if (copy) {
        await navigator.clipboard.writeText(value);
        if (active.current) setNotice(`${variable} copied.`);
      } else setRevealed((previous) => ({ ...previous, [variable]: value }));
    } catch (e) {
      if (active.current)
        setError(e instanceof Error ? e.message : "Could not reveal variable.");
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const variables =
    data?.variables.filter((v) =>
      v.name.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">
          {data
            ? `${data.variables.length} component variables`
            : "Component variables"}
        </h2>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setRevealed({});
            setAttempt((v) => v + 1);
          }}
        >
          Reload
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Effective environment from the installed template. Values are read-only;
        shared secrets belong to the app. Reveal or copy with your passkey.
      </p>
      <Input
        aria-label="Search component variables"
        placeholder="Search by variable name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {!data ? (
        <p className="text-sm text-muted-foreground">
          {error
            ? "Variables unavailable. Reload to try again."
            : "Loading variables…"}
        </p>
      ) : (
        <div className="divide-y rounded-xl border">
          {variables.length ? (
            variables.map((variable) => (
              <div
                key={variable.name}
                className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="break-all font-mono text-xs font-medium">
                    {variable.name}
                  </p>
                  <p className="mt-1 break-words text-[11px] text-muted-foreground">
                    {variable.references.length
                      ? `App secret · ${variable.references.join(", ")}`
                      : "Template value"}
                  </p>
                </div>
                <code className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {revealed[variable.name] ?? "••••••••"}
                </code>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    aria-label={`${Object.hasOwn(revealed, variable.name) ? "Hide" : "Reveal"} ${variable.name}`}
                    onClick={() => {
                      if (Object.hasOwn(revealed, variable.name))
                        setRevealed((previous) => {
                          const next = { ...previous };
                          delete next[variable.name];
                          return next;
                        });
                      else void reveal(variable.name);
                    }}
                  >
                    {Object.hasOwn(revealed, variable.name) ? (
                      <EyeSlashIcon />
                    ) : (
                      <EyeIcon />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    aria-label={`Copy ${variable.name}`}
                    onClick={() => void reveal(variable.name, true)}
                  >
                    <CopyIcon />
                  </Button>
                </div>
              </div>
            ))
          ) : (
            <p className="p-5 text-sm text-muted-foreground">
              {query
                ? "No matching variables."
                : "This component has no template environment variables."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
