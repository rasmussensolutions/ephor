import { Dialog } from "@base-ui/react/dialog";
import type { ReleaseStatus } from "@ephor/api/panel";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { ApiError, api, reauthenticate, request } from "@/lib/auth";
import { apiKey, queryClient } from "@/lib/query";
import { Button } from "./ui/button";

export const updateActive = (status?: ReleaseStatus | null) =>
  !!status?.job && !["complete", "failed"].includes(status.job.stage);
interface Updates {
  status: ReleaseStatus | undefined;
  error: string;
  busy: boolean;
  action: (
    name: "check" | "install" | "configure",
    body?: unknown,
  ) => Promise<boolean>;
}
const Context = createContext<Updates | null>(null);
export function usePanelUpdates() {
  const value = useContext(Context);
  if (!value) throw new Error("PanelUpdateProvider is missing");
  return value;
}
export function PanelUpdateProvider({ children }: { children: ReactNode }) {
  const [installing, setInstalling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uncertain = useRef(false);
  const observedJob = useRef<string | null>(null);
  const query = useQuery({
    queryKey: apiKey("/panel/status"),
    queryFn: async ({ signal }) => {
      const next = await request<ReleaseStatus>(
        "/panel/status",
        undefined,
        signal,
      );
      if (uncertain.current) {
        uncertain.current = false;
        setInstalling(false);
      }
      return next;
    },
    refetchInterval: (q) =>
      installing || updateActive(q.state.data) ? 2000 : 60_000,
    refetchIntervalInBackground: true,
  });
  const status = query.data;
  const active = installing || updateActive(status);
  useEffect(() => {
    if (updateActive(status) && status?.job)
      observedJob.current = status.job.id;
    if (
      status?.job?.stage === "complete" &&
      observedJob.current === status.job.id &&
      status.running === status.job.version
    ) {
      observedJob.current = null;
      // The server and static assets are ready; load the matching frontend once.
      location.reload();
    }
  }, [status]);
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (
        document.hidden ||
        updateActive(queryClient().getQueryData(apiKey("/panel/status")))
      )
        return;
      try {
        const next = await api<ReleaseStatus>("/panel/check", {
          automatic: true,
        });
        if (!stopped) queryClient().setQueryData(apiKey("/panel/status"), next);
      } catch {
        /* Background discovery never interrupts panel work. */
      }
    };
    void check();
    const timer = setInterval(() => void check(), 15 * 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  async function action(
    name: "check" | "install" | "configure",
    body: unknown = {},
  ) {
    if (busy) return false;
    setBusy(true);
    setError("");
    let submitted = false;
    try {
      if (name !== "check") await reauthenticate();
      if (name === "install") {
        setInstalling(true);
        submitted = true;
      }
      const next = await api<ReleaseStatus>(`/panel/${name}`, body);
      queryClient().setQueryData(apiKey("/panel/status"), next);
      return true;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The update could not be completed.",
      );
      // An accepted install can outlive its HTTP response during a restart.
      // The retained job plus status polling reconciles it after reconnection.
      if (submitted && (!(e instanceof ApiError) || e.status >= 500))
        uncertain.current = true;
      void query.refetch();
      return false;
    } finally {
      setBusy(false);
      if (!uncertain.current) setInstalling(false);
    }
  }
  return (
    <Context.Provider
      value={{
        status,
        error:
          error || (status?.job?.stage === "failed" ? status.job.message : ""),
        busy,
        action,
      }}
    >
      <div className="contents" inert={active || undefined}>
        {children}
      </div>
      {active && (
        <Dialog.Root
          open
          modal
          onOpenChange={(_open, details) => details.cancel()}
        >
          <Dialog.Portal>
            <Dialog.Popup className="fixed inset-0 top-0 left-0 z-[200] flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col items-center justify-center gap-5 rounded-none border-0 bg-background p-8 shadow-none sm:max-w-none">
              <img
                src="/logo.png"
                alt="Ephor"
                width={64}
                height={64}
                className="size-16 object-contain dark:invert"
              />
              <div
                aria-hidden="true"
                className="size-6 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-foreground motion-reduce:animate-none"
              />
              <Dialog.Title className="text-xl font-medium">
                Updating…
              </Dialog.Title>
              <Dialog.Description
                className="max-w-md text-center"
                aria-live="polite"
              >
                {query.isError
                  ? "The panel is restarting. Reconnecting automatically…"
                  : (status?.job?.message ?? "Preparing the panel update…")}
              </Dialog.Description>
              <p className="text-sm text-muted-foreground">
                This page will reload when the update is ready.
              </p>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </Context.Provider>
  );
}
export function SidebarUpdateCard({ collapsed }: { collapsed: boolean }) {
  const { status, error, busy, action } = usePanelUpdates();
  if (!status?.latest?.compatible) return null;
  return (
    <div className="rounded-lg border bg-sidebar-accent p-3 text-sm">
      {!collapsed && (
        <>
          <p className="font-medium">
            Ephor {status.latest.version} is available
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            A new panel update is ready.
          </p>
        </>
      )}
      {error && !collapsed && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {status.hosting ? (
        <Button
          size="sm"
          className="mt-2 w-full"
          disabled={busy || updateActive(status)}
          onClick={() =>
            void action("install", { version: status.latest?.version })
          }
          aria-label={`Update to Ephor ${status.latest.version}`}
        >
          {collapsed ? "↑" : "Update"}
        </Button>
      ) : (
        <Link
          to="/settings/updates"
          className="mt-2 block underline"
          aria-label="Set up panel updates"
        >
          {collapsed ? "↑" : "Set up updates"}
        </Link>
      )}
    </div>
  );
}
