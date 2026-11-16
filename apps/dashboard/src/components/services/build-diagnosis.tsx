import type { AiStatus, BuildDiagnosis } from "@ephor/api/ai";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { api } from "@/lib/auth";

export function BuildDiagnose({
  serviceId,
  buildId,
}: {
  serviceId: string;
  buildId: string;
}) {
  const [provider, setProvider] = useState<AiStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BuildDiagnosis | null>(null);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    async function load() {
      try {
        const status = await api<AiStatus>("/integrations/ai");
        if (mounted.current) setProvider(status);
      } catch {
        if (mounted.current) setProvider(null);
      }
    }
    void load();
    window.addEventListener("focus", load);
    window.addEventListener("ephor:ai-changed", load);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", load);
      window.removeEventListener("ephor:ai-changed", load);
    };
  }, []);
  async function diagnose() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await api<BuildDiagnosis>(
        `/services/${serviceId}/diagnose-build`,
        { buildId },
      );
      if (mounted.current) setResult(value);
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : "Could not diagnose this build.",
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!provider?.connected || !provider.verified) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="gradient"
            size="sm"
            title="Send this failed build’s logs and context to OpenRouter for diagnosis"
            onClick={() => {
              if (!result && !error) void diagnose();
            }}
          />
        }
      >
        <SparkleIcon /> Diagnose
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Build diagnosis</DialogTitle>
          <DialogDescription>
            OpenRouter · {result?.model ?? provider.model}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {busy && (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <SparkleIcon className="motion-safe:animate-pulse" /> Reviewing
              build logs and configuration…
            </p>
          )}
          {error && (
            <div className="space-y-3">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <Button
                variant="gradient"
                size="action"
                disabled={busy}
                onClick={() => void diagnose()}
              >
                Try again
              </Button>
            </div>
          )}
          {result && (
            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {result.text}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            AI-generated guidance based on this build’s saved logs and
            configuration. Review suggested changes before applying them.
          </p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
