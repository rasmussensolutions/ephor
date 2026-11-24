import { type AiStatus, DEFAULT_AI_MODEL } from "@ephor/api/ai";
import { useEffect, useId, useState } from "react";
import { Autocomplete } from "@/components/ui/autocomplete";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, reauthenticate } from "@/lib/auth";

export function AiSettings() {
  const id = useId();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [models, setModels] = useState<string[]>([DEFAULT_AI_MODEL]);
  const [model, setModel] = useState(DEFAULT_AI_MODEL);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modelError, setModelError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads integration status and the model catalog.
  useEffect(() => {
    let active = true;
    setError("");
    setModelError("");
    void api<AiStatus>("/integrations/ai").then(
      (value) => {
        if (active) {
          setStatus(value);
          setModel(value.model);
        }
      },
      () => {
        if (active) setError("Could not load AI settings.");
      },
    );
    void api<{ models: string[] }>("/integrations/ai/models").then(
      (value) => {
        if (active) setModels(value.models);
      },
      () => {
        if (active)
          setModelError(
            "Model list unavailable. You can still enter a model ID.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  async function save(disconnect = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await reauthenticate();
      const next = await api<AiStatus>(
        `/integrations/ai/${disconnect ? "disconnect" : "connect"}`,
        disconnect ? {} : { provider: "openrouter", apiKey: key, model },
      );
      setStatus(next);
      setModel(next.model);
      setKey("");
      setNotice(
        disconnect
          ? "OpenRouter disconnected. AI features are disabled."
          : "Connection verified. Build diagnosis is ready to use.",
      );
      window.dispatchEvent(new Event("ephor:ai-changed"));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not update AI settings.",
      );
    } finally {
      setBusy(false);
    }
  }
  const changed = !!key.trim() || (!!status && model !== status.model);
  return (
    <section
      className="settings-surface space-y-5 rounded-xl p-5"
      aria-labelledby={`${id}-heading`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id={`${id}-heading`} className="font-medium">
            AI provider
          </h2>
          <p className="text-sm text-muted-foreground">
            Connect OpenRouter to diagnose failed builds with your preferred
            model.
          </p>
        </div>
        {status && (
          <span
            className={`rounded-full px-2.5 py-1 text-xs ${status.verified && !changed ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}
          >
            {changed
              ? "Unverified changes"
              : status.verified
                ? "Verified"
                : "Not connected"}
          </span>
        )}
      </div>
      {!status ? (
        <div className="space-y-3">
          {error ? (
            <>
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <Button variant="raised" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Button>
            </>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              Loading AI settings…
            </p>
          )}
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor={`${id}-key`} className="space-y-1.5 text-sm">
              <span>OpenRouter API key</span>
              <Input
                id={`${id}-key`}
                type="password"
                autoComplete="new-password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={
                  status.connected
                    ? "Saved securely · leave blank to keep"
                    : "sk-or-v1-…"
                }
                required={!status.connected}
                disabled={busy}
              />
            </label>
            <label htmlFor={`${id}-model`} className="space-y-1.5 text-sm">
              <span>Default model</span>
              <Autocomplete
                id={`${id}-model`}
                items={models}
                value={model}
                onValueChange={setModel}
                required
                disabled={busy}
                placeholder={DEFAULT_AI_MODEL}
              />
            </label>
          </div>
          {modelError && (
            <p className="text-xs text-muted-foreground">{modelError}</p>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Verification makes a small test request to your selected model. When
            you choose Diagnose, the failed build’s logs and non-secret
            configuration are sent to OpenRouter. Known secret values are
            redacted. Requests are billed to your OpenRouter account.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              variant="gradient"
              size="action"
              disabled={busy || !model.trim()}
            >
              {busy
                ? "Working…"
                : status.connected
                  ? "Save & verify"
                  : "Connect & verify"}
            </Button>
            {status.connected && (
              <Button
                type="button"
                variant="raised"
                size="action"
                disabled={busy}
                onClick={() => void save(true)}
              >
                Disconnect
              </Button>
            )}
            <a
              href="https://openrouter.ai/settings/keys"
              target="_blank"
              rel="noreferrer"
              className="self-center text-sm text-muted-foreground underline underline-offset-4"
            >
              Get an API key ↗
            </a>
          </div>
          {status.verifiedAt && (
            <p className="text-xs text-muted-foreground">
              Last verified {new Date(status.verifiedAt).toLocaleString()} ·{" "}
              {status.model}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
              {status.connected
                ? " Your saved connection has not changed."
                : ""}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
