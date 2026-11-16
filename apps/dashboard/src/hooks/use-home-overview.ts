import type { ActivityList } from "@ephor/api/activity";
import type { MachineList } from "@ephor/api/machines";
import { useEffect, useState } from "react";
import { api } from "@/lib/auth";
import type { BackupOverview } from "@/lib/home-overview";
import type { ServiceList } from "@/lib/services";

export interface HomeResource<T> {
  data: T | null;
  updatedAt: number | null;
  error: boolean;
}
async function resource<T>(path: string): Promise<HomeResource<T>> {
  try {
    return { data: await api<T>(path), updatedAt: Date.now(), error: false };
  } catch {
    return { data: null, updatedAt: null, error: true };
  }
}
export async function loadHomeOverview() {
  const [machines, services, backups, activity] = await Promise.all([
    resource<MachineList>("/machines"),
    resource<ServiceList>("/services?summary=1"),
    resource<BackupOverview>("/backups"),
    resource<ActivityList>("/activity"),
  ]);
  return { machines, services, backups, activity };
}
function retain<T>(previous: HomeResource<T>, next: HomeResource<T>) {
  return next.error ? { ...previous, error: true } : next;
}
export function useHomeOverview(
  initial: Awaited<ReturnType<typeof loadHomeOverview>>,
) {
  const [data, setData] = useState(initial);
  const [now, setNow] = useState(Date.now);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const poll = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      setNow(Date.now());
      setRefreshing(true);
      const next = await loadHomeOverview();
      if (active) {
        setData((previous) => ({
          machines: retain(previous.machines, next.machines),
          services: retain(previous.services, next.services),
          backups: retain(previous.backups, next.backups),
          activity: retain(previous.activity, next.activity),
        }));
        setNow(Date.now());
        setRefreshing(false);
      }
      inFlight = false;
    };
    if (attempt > 0) void poll();
    const timer = setInterval(() => void poll(), 15_000);
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [attempt]);
  return {
    data,
    now,
    refreshing,
    refresh: () => setAttempt((value) => value + 1),
  };
}
