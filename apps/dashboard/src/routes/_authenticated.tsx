import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useMatch,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { api, type SessionInfo } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    try {
      return { auth: await api<SessionInfo>("/session") };
    } catch {
      throw redirect({ to: "/login" });
    }
  },
  component: DashboardLayout,
});
function DashboardLayout() {
  const { auth } = Route.useRouteContext();
  const securityPage = useMatch({
    from: "/_authenticated/settings/security",
    shouldThrow: false,
  });
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
            {auth.recoveryCodesRemaining === 0 && !securityPage && (
              <p
                className={
                  projectPage
                    ? "absolute bottom-16 left-4 right-4 z-10 max-w-lg rounded-lg border bg-card p-3 text-sm shadow-sm"
                    : "mb-6 rounded-lg border border-border bg-muted/50 p-4 text-sm"
                }
              >
                Protect against losing your passkey.{" "}
                <Link
                  to="/settings/security"
                  className="font-medium underline underline-offset-4"
                >
                  Save your recovery codes
                </Link>
                .
              </p>
            )}
            <Outlet />
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
