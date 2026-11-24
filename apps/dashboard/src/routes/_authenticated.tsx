import { QueryClientProvider } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useMatch,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { PanelUpdateProvider } from "@/components/panel-update-provider";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ApiError, api, type SessionInfo } from "@/lib/auth";
import { queryClient } from "@/lib/query";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    try {
      return { auth: await api<SessionInfo>("/session") };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        throw redirect({ to: "/login" });
      throw error;
    }
  },
  component: DashboardLayout,
});
function DashboardLayout() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      void router.invalidate();
    };
    window.addEventListener("ephor:data-changed", refresh);
    return () => window.removeEventListener("ephor:data-changed", refresh);
  }, [router]);
  const projectPage = useMatch({
    from: "/_authenticated/projects_/$projectId",
    shouldThrow: false,
  });
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const check = () => {
      if (!document.hidden) void api("/session").catch(() => {});
    };
    const timer = window.setInterval(check, 60_000);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, []);

  async function signOut() {
    setSigningOut(true);
    setError("");
    try {
      await api("/auth/sign-out", {});
      location.assign("/login");
    } catch {
      setError("Sign-out failed. Please try again.");
      setSigningOut(false);
    }
  }

  return (
    <QueryClientProvider client={queryClient()}>
      <PanelUpdateProvider>
        <SidebarProvider className="h-dvh min-h-0 overflow-hidden">
          <AppSidebar signingOut={signingOut} onSignOut={signOut} />
          <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
            <div
              id="main"
              tabIndex={-1}
              data-scroll-restoration-id="dashboard-content"
              className={
                projectPage
                  ? "min-h-0 flex-1 overflow-hidden"
                  : "min-h-0 flex-1 overflow-y-auto overscroll-y-none"
              }
            >
              <div
                className={
                  projectPage
                    ? "relative h-full w-full"
                    : "mx-auto w-full max-w-6xl px-6 py-10 md:px-10 md:py-24"
                }
              >
                <SidebarTrigger
                  className={
                    projectPage
                      ? "absolute top-4 left-3 z-20 size-10 rounded-lg border bg-card shadow-sm md:hidden"
                      : "mb-3 -ml-1.5 size-10 md:hidden"
                  }
                  aria-label="Open navigation"
                  aria-haspopup="dialog"
                />
                {error && (
                  <p
                    role="alert"
                    className={
                      projectPage
                        ? "absolute bottom-16 left-4 z-20 rounded-lg border bg-card p-3 text-sm text-destructive"
                        : "mb-4 text-sm text-destructive"
                    }
                  >
                    {error}
                  </p>
                )}
                <Outlet />
              </div>
            </div>
          </SidebarInset>
        </SidebarProvider>
      </PanelUpdateProvider>
    </QueryClientProvider>
  );
}
