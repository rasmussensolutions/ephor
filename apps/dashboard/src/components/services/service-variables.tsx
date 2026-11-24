import { BracketsCurlyIcon } from "@phosphor-icons/react/dist/csr/BracketsCurly";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, reauthenticate } from "@/lib/auth";
import {
  formatEnvironment,
  parseEnvironment,
  validateEnvironment,
} from "@/lib/environment";

interface VariableList {
  names: string[];
  revision: string;
  editable: boolean;
  suggestions: {
    serviceId: string;
    serviceName: string;
    template: "postgres" | "redis" | "qdrant";
    variable: string;
    reference: string;
  }[];
  references: Record<
    string,
    { serviceId: string; variable: string; value: string }
  >;
}
export interface VariablePending {
  dirty: boolean;
  busy: boolean;
}
const inputClass =
  "w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ServiceVariables({
  id,
  onSaved,
  onPendingChange,
}: {
  id: string;
  onSaved: () => Promise<void>;
  onPendingChange: (pending: VariablePending) => void;
}) {
  const formId = useId();
  const [data, setData] = useState<VariableList | null>(null);
  const [changes, setChanges] = useState<Record<string, string | null>>({});
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<{
    name: string;
    value: string;
    existing: boolean;
  } | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty =
    Object.keys(changes).length > 0 || editor !== null || raw !== null;
  const reload = useCallback(async () => {
    const next = await api<VariableList>(`/services/${id}/variables`);
    setData(next);
    setRevealed({});
    setError("");
  }, [id]);
  useEffect(() => {
    let active = true;
    void api<VariableList>(`/services/${id}/variables`)
      .then((next) => {
        if (active) setData(next);
      })
      .catch(() => {
        if (active) setError("Could not load variables. Try reloading.");
      });
    return () => {
      active = false;
    };
  }, [id]);
  useLayoutEffect(() => {
    onPendingChange({ dirty, busy });
  }, [dirty, busy, onPendingChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty, busy]);
  useEffect(() => {
    const hide = () => {
      if (document.hidden) setRevealed({});
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function valueFor(name: string) {
    const staged = changes[name];
    if (typeof staged === "string") return staged;
    if (Object.hasOwn(revealed, name)) return revealed[name] ?? "";
    await reauthenticate();
    const result = await api<{ values: Record<string, string> }>(
      `/services/${id}/variables/reveal`,
      { name, revision: data?.revision },
    );
    const value = result.values[name];
    if (typeof value !== "string")
      throw new Error("This variable is no longer available. Reload the list.");
    return value;
  }
  function stageEntry() {
    if (!editor || !data) return;
    try {
      validateEnvironment({ [editor.name]: editor.value });
      if (
        !editor.existing &&
        (data.names.includes(editor.name) ||
          Object.hasOwn(changes, editor.name))
      )
        throw new Error("That variable already exists. Edit its row instead.");
      setChanges((current) => ({ ...current, [editor.name]: editor.value }));
      setRevealed((current) => {
        const next = { ...current };
        delete next[editor.name];
        return next;
      });
      setEditor(null);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the variable.");
    }
  }
  function stageRaw() {
    if (raw === null || !data) return;
    try {
      const parsed = parseEnvironment(raw);
      const next: Record<string, string | null> = { ...parsed };
      for (const name of data.names)
        if (!Object.hasOwn(parsed, name)) next[name] = null;
      setChanges(next);
      setRaw(null);
      setRevealed({});
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the raw variables.");
    }
  }
  async function save() {
    if (!data) return;
    await reauthenticate();
    const set = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== null),
    );
    const remove = Object.keys(changes).filter(
      (name) => changes[name] === null,
    );
    const next = await api<VariableList>(`/services/${id}/variables`, {
      revision: data.revision,
      set,
      remove,
    });
    setData(next);
    setChanges({});
    setRevealed({});
    setNotice("Variables saved. Deploy the service to apply them.");
    window.dispatchEvent(new Event("ephor:services-changed"));
    try {
      await onSaved();
    } catch {
      setError(
        "Variables were saved, but service details could not refresh. Reopen the service to refresh them.",
      );
    }
  }
  const names = [
    ...new Set([...(data?.names ?? []), ...Object.keys(changes)]),
  ].sort();
  const filtered = names.filter((name) =>
    name.toLowerCase().includes(search.toLowerCase()),
  );
  const editing = editor !== null || raw !== null;
  const count = names.filter((name) => changes[name] !== null).length;

  return (
    <section className="space-y-5" aria-label="Runtime variables">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">
            Variables{" "}
            <span className="ml-1 text-sm tabular-nums text-muted-foreground">
              {data ? count : ""}
            </span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Runtime configuration, encrypted at rest. Changes apply on the next
            deployment.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || !data?.editable || editing}
            onClick={() =>
              run(async () => {
                await reauthenticate();
                const result = await api<{ values: Record<string, string> }>(
                  `/services/${id}/variables/reveal`,
                  { revision: data?.revision },
                );
                const values = { ...result.values };
                for (const [name, value] of Object.entries(changes)) {
                  if (value === null) delete values[name];
                  else values[name] = value;
                }
                setRaw(formatEnvironment(values));
              })
            }
          >
            <BracketsCurlyIcon />
            Raw editor
          </Button>
          <Button
            disabled={busy || !data?.editable || editing}
            onClick={() => {
              setEditor({ name: "", value: "", existing: false });
              setError("");
              setNotice("");
            }}
          >
            <PlusIcon />
            New variable
          </Button>
        </div>
      </div>
      {data && !data.editable && (
        <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
          These variables are managed by the catalog template. Use Setup &amp;
          data for supported configuration and credentials.
        </p>
      )}
      {data?.editable && (
        <div className="overflow-hidden rounded-xl border">
          <div className="flex items-start gap-3 bg-muted/20 p-4">
            <LinkIcon
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <div>
              <h3 className="text-sm font-medium">Connect a service</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Add a linked variable from a database on this machine. Ephor
                handles credentials and the private connection when you deploy.
              </p>
            </div>
          </div>
          {data.suggestions.length ? (
            data.suggestions.map((suggestion) => {
              const linked = names.some(
                (name) =>
                  (Object.hasOwn(changes, name)
                    ? changes[name]
                    : data.references[name]?.value) === suggestion.reference,
              );
              const occupied =
                names.includes(suggestion.variable) &&
                changes[suggestion.variable] !== null;
              return (
                <div
                  key={`${suggestion.serviceId}:${suggestion.variable}`}
                  className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {suggestion.serviceName}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {suggestion.template === "postgres"
                        ? "PostgreSQL"
                        : suggestion.template === "qdrant"
                          ? "Qdrant"
                          : "Redis"}
                      {" · "}
                      <code>{suggestion.variable}</code>
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || editing || linked}
                    onClick={() => {
                      setError("");
                      setNotice("");
                      if (occupied) {
                        setEditor({
                          name: "",
                          value: suggestion.reference,
                          existing: false,
                        });
                      } else {
                        setChanges((current) => ({
                          ...current,
                          [suggestion.variable]: suggestion.reference,
                        }));
                        setRevealed((current) => {
                          const next = { ...current };
                          delete next[suggestion.variable];
                          return next;
                        });
                      }
                    }}
                  >
                    {linked
                      ? "Added"
                      : occupied
                        ? "Add under another name"
                        : `Add ${suggestion.variable}`}
                  </Button>
                </div>
              );
            })
          ) : (
            <p className="border-t p-4 text-xs text-muted-foreground">
              Add a PostgreSQL or Redis service from the catalog on this machine
              to see connection suggestions here.
            </p>
          )}
          {data.suggestions.length > 0 && (
            <p className="border-t px-4 py-3 text-xs text-muted-foreground">
              Deploy the database first, then save these variables and deploy
              your app. Existing variables are kept unless you edit them.
            </p>
          )}
        </div>
      )}
      <div className="relative">
        <MagnifyingGlassIcon
          aria-hidden
          className="absolute left-3 top-2.5 size-4 text-muted-foreground"
        />
        <Input
          aria-label="Search variables"
          placeholder="Filter by variable name…"
          className="pl-9"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-3 text-sm"
        >
          <p className="text-destructive">{error}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run(reload)}
          >
            Reload latest
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="rounded-lg border bg-muted/30 p-3 text-sm">
          {notice}
        </p>
      )}
      {editor && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            stageEntry();
          }}
          className="space-y-4 rounded-xl border bg-muted/20 p-4"
        >
          <h3 className="font-medium">
            {editor.existing ? "Edit variable" : "New variable"}
          </h3>
          <label className="block space-y-2" htmlFor={`${formId}-name`}>
            <span className="text-xs text-muted-foreground">Name</span>
            <Input
              id={`${formId}-name`}
              required
              maxLength={64}
              readOnly={editor.existing}
              placeholder="DATABASE_URL"
              autoComplete="off"
              className="font-mono"
              value={editor.name}
              onChange={(event) =>
                setEditor({ ...editor, name: event.target.value })
              }
            />
          </label>
          {!data?.suggestions.some((s) => s.reference === editor.value) && (
            <label className="block space-y-2" htmlFor={`${formId}-value`}>
              <span className="text-xs text-muted-foreground">
                {editor.existing ? "Replacement value" : "Value"}
              </span>
              <Textarea
                id={`${formId}-value`}
                rows={3}
                maxLength={4096}
                spellCheck={false}
                autoComplete="off"
                className={inputClass}
                placeholder={
                  editor.existing
                    ? "Enter the new value. An empty value is allowed."
                    : "Enter a value"
                }
                value={editor.value}
                onChange={(event) =>
                  setEditor({ ...editor, value: event.target.value })
                }
              />
            </label>
          )}
          {data?.suggestions.length ? (
            <label className="block space-y-2" htmlFor={`${formId}-connection`}>
              <span className="text-xs text-muted-foreground">
                Use a service connection
              </span>
              <Select
                id={`${formId}-connection`}
                value={
                  data.suggestions.some((s) => s.reference === editor.value)
                    ? editor.value
                    : ""
                }
                onValueChange={(next) => setEditor({ ...editor, value: next })}
                className="w-full"
                options={[
                  { value: "", label: "Custom value" },
                  ...data.suggestions.map((s) => ({
                    value: s.reference,
                    label: `${s.serviceName} · ${s.variable}`,
                  })),
                ]}
              />
              <p className="text-xs text-muted-foreground">
                Linked credentials are resolved at deployment. You can choose
                any variable name your app expects.
              </p>
            </label>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              type="button"
              onClick={() => setEditor(null)}
            >
              Cancel
            </Button>
            <Button type="submit">Stage variable</Button>
          </div>
        </form>
      )}
      {raw !== null && (
        <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
          <label htmlFor={`${formId}-raw`} className="block font-medium">
            Raw variables
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Values are visible in this editor. Paste .env entries or a JSON
            object. Quoted multiline values are supported; substitutions stay
            literal except Ephor service references. Keep linked references
            intact. Omitted variables will be removed when you save.
          </p>
          <Textarea
            id={`${formId}-raw`}
            rows={12}
            spellCheck={false}
            autoComplete="off"
            className={inputClass}
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRaw(null)}>
              Cancel
            </Button>
            <Button onClick={stageRaw}>Stage changes</Button>
          </div>
        </div>
      )}
      {!data ? (
        <p className="py-8 text-center text-muted-foreground">
          {error ? "Variables unavailable." : "Loading variables…"}
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
            <span>Name / value</span>
            <span>Hidden by default</span>
          </div>
          {filtered.map((name) => {
            const removed = changes[name] === null;
            const staged = Object.hasOwn(changes, name);
            const visible = Object.hasOwn(revealed, name);
            const reference =
              typeof changes[name] === "string"
                ? changes[name]
                : data.references[name]?.value;
            const connection =
              !removed &&
              data.suggestions.find((s) => s.reference === reference);
            return (
              <div
                key={name}
                className={`flex flex-wrap items-center gap-3 border-b px-4 py-4 last:border-0 ${removed ? "bg-destructive/5" : staged ? "bg-primary/5" : ""}`}
              >
                <div className="min-w-0 flex-1 basis-48">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`truncate font-mono text-xs ${removed ? "text-muted-foreground line-through" : "font-medium"}`}
                      title={name}
                    >
                      {name}
                    </span>
                    {staged && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {removed
                          ? "Removed"
                          : data.names.includes(name)
                            ? "Edited"
                            : "New"}
                      </span>
                    )}
                  </div>
                  {connection && (
                    <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <LinkIcon aria-hidden className="size-3.5" />
                      Linked to {connection.serviceName} · {connection.variable}
                    </p>
                  )}
                  <p className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
                    {removed
                      ? "Will be removed on save"
                      : visible
                        ? revealed[name] || "(empty value)"
                        : "••••••••••••"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {staged && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || editing}
                      onClick={() => {
                        setChanges((current) => {
                          const next = { ...current };
                          delete next[name];
                          return next;
                        });
                        setRevealed((current) => {
                          const next = { ...current };
                          delete next[name];
                          return next;
                        });
                      }}
                    >
                      Undo
                    </Button>
                  )}
                  {!removed && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        aria-label={`${visible ? "Hide" : "Reveal"} ${name}`}
                        title={visible ? "Hide value" : "Reveal value"}
                        onClick={() =>
                          visible
                            ? setRevealed((current) => {
                                const next = { ...current };
                                delete next[name];
                                return next;
                              })
                            : run(async () => {
                                const value = await valueFor(name);
                                setRevealed((current) => ({
                                  ...current,
                                  [name]: value,
                                }));
                              })
                        }
                      >
                        {visible ? <EyeSlashIcon /> : <EyeIcon />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        aria-label={`Copy ${name}`}
                        title="Copy value"
                        onClick={() =>
                          run(async () => {
                            const value = await valueFor(name);
                            await navigator.clipboard.writeText(value);
                            setNotice(`Copied ${name}.`);
                          })
                        }
                      >
                        <CopyIcon />
                      </Button>
                      {data.editable && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy || editing}
                            aria-label={`Edit ${name}`}
                            title="Edit variable"
                            onClick={() => {
                              setEditor({
                                name,
                                value:
                                  typeof changes[name] === "string"
                                    ? changes[name]
                                    : (data.references[name]?.value ?? ""),
                                existing: true,
                              });
                              setError("");
                              setNotice("");
                            }}
                          >
                            <PencilSimpleIcon />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy || editing}
                            aria-label={`Remove ${name}`}
                            title="Stage removal"
                            onClick={() => {
                              setChanges((current) => ({
                                ...current,
                                [name]: null,
                              }));
                              setRevealed((current) => {
                                const next = { ...current };
                                delete next[name];
                                return next;
                              });
                            }}
                          >
                            <TrashIcon />
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {!filtered.length && (
            <div className="px-6 py-12 text-center">
              <p className="font-medium">
                {search ? "No matching variables" : "No variables yet"}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {search
                  ? "Try a different name."
                  : "Add configuration values your service needs at runtime."}
              </p>
            </div>
          )}
        </div>
      )}
      {!!Object.keys(changes).length && (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 shadow-sm">
          <div>
            <p className="text-sm font-medium">
              {Object.keys(changes).length} pending{" "}
              {Object.keys(changes).length === 1 ? "change" : "changes"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Save first, then deploy when you’re ready.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy || editing}
              onClick={() => {
                setChanges({});
                setRevealed({});
                setError("");
              }}
            >
              Discard
            </Button>
            <Button disabled={busy || editing} onClick={() => run(save)}>
              {busy ? "Saving…" : "Save variables"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
