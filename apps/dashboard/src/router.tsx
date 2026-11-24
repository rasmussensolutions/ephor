import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    scrollToTopSelectors: ['[data-scroll-restoration-id="dashboard-content"]'],
    defaultPreload: "intent",
    defaultPreloadDelay: 0,
    defaultStaleTime: 15_000,
    defaultPreloadStaleTime: 15_000,
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
    defaultPendingComponent: () => (
      <div
        role="status"
        aria-label="Loading page"
        className="space-y-5 animate-pulse"
      >
        <div className="h-8 w-48 rounded bg-muted" />
        <div className="h-48 rounded-xl bg-muted" />
        <span className="sr-only">Loading…</span>
      </div>
    ),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
