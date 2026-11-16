import type { NotificationList } from "@ephor/api/notifications";
import { useEffect, useState } from "react";
import { api } from "@/lib/auth";

export function useUnreadNotifications() {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (!document.hidden)
        void api<NotificationList>("/notifications")
          .then((data) => {
            if (alive) setUnread(data.unread);
          })
          .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    window.addEventListener("ephor-notifications-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("ephor-notifications-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return unread;
}
