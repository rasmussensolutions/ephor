import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowCircleUpIcon } from "@phosphor-icons/react/dist/csr/ArrowCircleUp";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { FlowArrowIcon } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { MagicWandIcon } from "@phosphor-icons/react/dist/csr/MagicWand";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { ScrollIcon } from "@phosphor-icons/react/dist/csr/Scroll";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { SignOutIcon } from "@phosphor-icons/react/dist/csr/SignOut";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import { themeStorageKey } from "@/lib/theme";

const navigationGroups = [
  {
    label: null,
    items: [
      { title: "Home", to: "/", icon: HouseIcon },
      { title: "Notifications", to: "/notifications", icon: BellIcon },
      { title: "Activity", to: "/activity", icon: ClockCounterClockwiseIcon },
      { title: "Ask AI", to: "/ask-ai", icon: ChatCircleDotsIcon },
    ],
  },
  {
    label: "Servers",
    items: [
      { title: "Machines", to: "/machines", icon: HardDrivesIcon },
      { title: "Services", to: "/services", icon: StackIcon },
      { title: "Projects", to: "/projects", icon: SquaresFourIcon },
      { title: "Updates", to: "/updates", icon: ArrowCircleUpIcon },
    ],
  },
  {
    label: "Operations",
    items: [
      { title: "Monitors", to: "/monitors", icon: PulseIcon },
      { title: "Logs", to: "/logs", icon: ScrollIcon },
      { title: "Workflows", to: "/workflows", icon: FlowArrowIcon },
      { title: "Fixes", to: "/fixes", icon: MagicWandIcon },
    ],
  },
] as const;

const settingsNavigationGroups = [
  {
    label: "Settings",
    items: [
      { title: "Security", to: "/settings/security", icon: ShieldCheckIcon },
      {
        title: "Notification settings",
        to: "/settings/notifications",
        icon: BellIcon,
      },
      { title: "Integrations", to: "/settings/integrations", icon: PlugsIcon },
      { title: "Backups", to: "/settings/backups", icon: ArchiveIcon },
    ],
  },
] as const;

export function AppSidebar({
  signingOut,
  onSignOut,
}: {
  signingOut: boolean;
  onSignOut: () => Promise<void>;
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const inSettings =
    pathname === "/settings" || pathname.startsWith("/settings/");
  const groups = inSettings ? settingsNavigationGroups : navigationGroups;
  const { isMobile, open, setOpenMobile } = useSidebar();
  const unread = useUnreadNotifications();
  const [darkMode, setDarkMode] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"),
  );

  function toggleDarkMode() {
    const enabled = !darkMode;
    document.documentElement.classList.toggle("dark", enabled);
    setDarkMode(enabled);
    try {
      localStorage.setItem(themeStorageKey, enabled ? "dark" : "light");
    } catch {
      // The current page can still switch themes if storage is unavailable.
    }
  }

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <div className="flex items-center gap-2 group-data-[collapsible=icon]:flex-col">
          <SidebarMenu>
            <SidebarMenuItem className="flex flex-row items-center gap-2 px-2">
              <img
                src="/logo.png"
                alt=""
                width={32}
                height={32}
                className="size-5.5 dark:invert"
              />
              <span className="text-xl font-medium tracking-tight">Ephor</span>
            </SidebarMenuItem>
          </SidebarMenu>
          <SidebarTrigger
            className="shrink-0"
            aria-label={
              isMobile
                ? "Close navigation"
                : open
                  ? "Collapse sidebar"
                  : "Expand sidebar"
            }
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <nav
          aria-label={inSettings ? "Settings navigation" : "Main navigation"}
        >
          {inSettings && (
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip="Back to Ephor"
                      render={
                        <Link to="/" onClick={() => setOpenMobile(false)} />
                      }
                    >
                      <ArrowLeftIcon aria-hidden="true" />
                      <span>Back to Ephor</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          {groups.map((group) => (
            <SidebarGroup key={group.label ?? "main"}>
              {group.label ? (
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              ) : null}
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {group.items.map((item) => {
                    const hasUnread =
                      item.to === "/notifications" && unread > 0;
                    return (
                      <SidebarMenuItem key={item.to}>
                        <SidebarMenuButton
                          isActive={
                            pathname === item.to ||
                            (item.to !== "/" &&
                              pathname.startsWith(`${item.to}/`))
                          }
                          tooltip={item.title}
                          aria-label={
                            hasUnread
                              ? `Notifications, ${unread} unread`
                              : undefined
                          }
                          render={
                            <Link
                              to={item.to}
                              activeOptions={{ exact: item.to === "/" }}
                              onClick={() => setOpenMobile(false)}
                            />
                          }
                        >
                          <item.icon aria-hidden="true" />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                        {hasUnread && (
                          <>
                            <SidebarMenuBadge aria-hidden="true">
                              {unread > 99 ? "99+" : unread}
                            </SidebarMenuBadge>
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute top-1 left-5 hidden size-1.5 rounded-full bg-primary group-data-[collapsible=icon]:block"
                            />
                          </>
                        )}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {!inSettings && (
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Settings"
                render={
                  <Link to="/settings" onClick={() => setOpenMobile(false)} />
                }
              >
                <GearSixIcon aria-hidden="true" />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              aria-pressed={darkMode}
              className="aria-pressed:bg-sidebar-accent aria-pressed:text-sidebar-accent-foreground"
              tooltip="Dark mode"
              onClick={toggleDarkMode}
            >
              <MoonIcon
                aria-hidden="true"
                weight={darkMode ? "fill" : "regular"}
              />
              <span>Dark mode</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              disabled={signingOut}
              tooltip="Sign out"
              onClick={() => {
                setOpenMobile(false);
                void onSignOut();
              }}
            >
              <SignOutIcon aria-hidden="true" />
              <span>{signingOut ? "Signing out…" : "Sign out"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
