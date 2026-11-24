import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { themeScript } from "@/lib/theme";
import stylesheet from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Ephor — Dashboard" },
      { name: "robots", content: "noindex, nofollow" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: import.meta.env.DEV
          ? `${stylesheet}?direct&ephor-dev=1`
          : stylesheet,
      },
      {
        rel: "icon",
        type: "image/png",
        href: "/icon_256.png",
      },
    ],
  }),
  component: RootLayout,
  notFoundComponent: () => (
    <p>
      Page not found. <Link to="/">Return home</Link>.
    </p>
  ),
});

function RootLayout() {
  useEffect(() => {
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const onScroll = (event: Event) => {
      const target =
        event.target === document ? document.documentElement : event.target;
      if (!(target instanceof Element)) return;
      clearTimeout(timers.get(target));
      target.setAttribute("data-scrolling", "");
      timers.set(
        target,
        setTimeout(() => {
          target.removeAttribute("data-scrolling");
          timers.delete(target);
        }, 800),
      );
    };
    // Capture scroll events from nested containers and portalled dialogs too.
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      for (const [target, timer] of timers) {
        clearTimeout(timer);
        target.removeAttribute("data-scrolling");
      }
    };
  }, []);
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script>{themeScript}</script>
      </head>
      <body>
        <a
          className="sr-only z-50 rounded-md bg-background p-3 text-sm focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:ring-2 focus:ring-ring"
          href="#main"
        >
          Skip to content
        </a>
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  );
}
