import {
  type NotificationSettings,
  notificationEvents,
} from "@ephor/api/notifications";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ResendSettingsDialog } from "@/components/notifications/resend-settings-dialog";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@/components/settings-layout";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { api, signIn } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated/settings/notifications")({
  head: () => ({ meta: [{ title: "Notification settings — Ephor" }] }),
  loader: () => api<NotificationSettings>("/notifications/settings"),
  component: NotificationSettingsPage,
});
function NotificationSettingsPage() {
  const initial = Route.useLoaderData();
  const [saved, setSaved] = useState(initial),
    [settings, setSettings] = useState(initial);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const submitting = useRef(false);
  async function act(fn: () => Promise<void>, message: string) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await signIn();
      await fn();
      setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  function save() {
    return act(async () => {
      const result = await api<NotificationSettings>(
        "/notifications/settings",
        {
          ...saved,
          preferences: settings.preferences,
        },
      );
      setSaved(result);
      setSettings(result);
    }, "Notification settings saved.");
  }
  return (
    <SettingsPage
      title="Notification settings"
      description="Choose where Ephor sends updates and which events matter to you."
    >
      <Link
        to="/notifications"
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Back to inbox and delivery history
      </Link>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          {notice}
        </p>
      )}
      <SettingsSection title="Delivery methods">
        <SettingsGroup>
          <SettingsRow
            title="Resend"
            description={
              saved.hasKey
                ? saved.enabled
                  ? `Email notifications enabled · ${saved.from}`
                  : "Connected · Email notifications disabled"
                : "Send email notifications through your Resend account."
            }
            control={
              <ResendSettingsDialog
                settings={saved}
                disabled={busy}
                onSaved={(result, disconnected) => {
                  setSaved(result);
                  setSettings((current) => ({
                    ...result,
                    preferences: current.preferences,
                  }));
                  setError("");
                  setNotice(
                    disconnected
                      ? "Resend disconnected. Pending emails are cancelled; in-app notifications remain available."
                      : "Resend settings saved.",
                  );
                }}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-8"
      >
        <SettingsSection title="What to receive">
          <SettingsGroup>
            <div className="space-y-1 py-2">
              <div className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem] gap-2 border-b py-3 text-center text-xs text-muted-foreground">
                <span className="text-left">Event</span>
                <span>In-app</span>
                <span>Email</span>
              </div>
              {notificationEvents.map((event) => (
                <div
                  key={event.id}
                  className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem] items-center gap-2 py-3"
                >
                  <div>
                    <p className="text-sm font-medium">{event.label}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {event.description}
                    </p>
                  </div>
                  {(["inApp", "email"] as const).map((channel) => (
                    <div key={channel} className="flex justify-center">
                      <Checkbox
                        disabled={busy}
                        aria-label={`${event.label}: ${channel === "inApp" ? "in-app" : "email"}`}
                        checked={settings.preferences[event.id][channel]}
                        onCheckedChange={(checked) =>
                          setSettings({
                            ...settings,
                            preferences: {
                              ...settings.preferences,
                              [event.id]: {
                                ...settings.preferences[event.id],
                                [channel]: checked,
                              },
                            },
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </SettingsGroup>
          <p className="px-4 text-xs text-muted-foreground">
            Email selections take effect when email is enabled. Changes apply to
            future alerts; already queued messages keep their original
            recipients. Disabling email cancels messages that have not started
            sending.
          </p>
        </SettingsSection>
        <Button type="submit" disabled={busy}>
          {busy ? "Working…" : "Save settings"}
        </Button>
      </form>
      <SettingsSection title="Test notifications">
        <SettingsGroup>
          <div className="space-y-3 py-5">
            <p className="text-sm text-muted-foreground">
              Tests use your saved settings and bypass event preferences. Email
              tests can take up to one minute to start; follow their progress in
              Delivery history.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api("/notifications/test", { channel: "inApp" });
                    window.dispatchEvent(
                      new Event("ephor-notifications-changed"),
                    );
                  }, "Test added to your in-app inbox.")
                }
              >
                Test in-app
              </Button>
              <Button
                variant="outline"
                disabled={busy || !saved.enabled}
                onClick={() =>
                  void act(async () => {
                    await api("/notifications/test", { channel: "email" });
                  }, "Test email queued. Check Delivery history for the result.")
                }
              >
                Send test email
              </Button>
            </div>
          </div>
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
