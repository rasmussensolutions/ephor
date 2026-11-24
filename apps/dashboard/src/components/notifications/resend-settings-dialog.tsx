import type { NotificationSettings } from "@ephor/api/notifications";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, reauthenticate } from "@/lib/auth";

export function ResendSettingsDialog({
  settings,
  disabled,
  onSaved,
}: {
  settings: NotificationSettings;
  disabled: boolean;
  onSaved: (settings: NotificationSettings, disconnected: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(settings);
  const [key, setKey] = useState("");
  const [recipients, setRecipients] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);

  async function save(disconnect = false) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await reauthenticate();
      const result = await api<NotificationSettings>(
        "/notifications/settings",
        disconnect
          ? { ...settings, enabled: false, removeKey: true }
          : {
              ...draft,
              preferences: settings.preferences,
              apiKey: key,
              recipients: recipients
                .split(/[,;\n]/)
                .map((address) => address.trim())
                .filter(Boolean),
            },
      );
      onSaved(result, disconnect);
      setKey("");
      setOpen(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Please try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen, event) => {
        if (submitting.current) {
          event.cancel();
          return;
        }
        if (nextOpen) {
          setDraft(settings);
          setRecipients(settings.recipients.join(", "));
          setError("");
        }
        setKey("");
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger
        render={<Button variant="raised" size="action" disabled={disabled} />}
      >
        {settings.hasKey ? "Configure" : "Set up"}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {settings.hasKey ? "Configure Resend" : "Set up Resend"}
          </DialogTitle>
          <DialogDescription>
            Connect your Resend account to send email notifications.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy} className="space-y-4">
              <label
                className="flex items-center gap-3 text-sm font-medium"
                htmlFor={"notification-resend-enabled"}
              >
                <Checkbox
                  id={"notification-resend-enabled"}
                  checked={draft.enabled}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    setDraft({ ...draft, enabled: checked })
                  }
                  className="size-4 accent-primary"
                />
                Enable email notifications
              </label>
              <label
                htmlFor="notification-key"
                className="block space-y-2 text-sm"
              >
                <span>API key</span>
                <Input
                  id="notification-key"
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder={
                    settings.hasKey
                      ? "Key saved · leave blank to keep it"
                      : "re_…"
                  }
                  aria-describedby="notification-key-help"
                />
              </label>
              <p
                id="notification-key-help"
                className="text-xs leading-5 text-muted-foreground"
              >
                Use a sending-only key restricted to your verified Resend
                domain.
              </p>
              <label
                htmlFor="notification-from"
                className="block space-y-2 text-sm"
              >
                <span>Sender email</span>
                <Input
                  id="notification-from"
                  type="email"
                  autoComplete="off"
                  value={draft.from}
                  onChange={(event) =>
                    setDraft({ ...draft, from: event.target.value })
                  }
                  placeholder="alerts@example.com"
                />
              </label>
              <label
                htmlFor="notification-recipients"
                className="block space-y-2 text-sm"
              >
                <span>Recipients</span>
                <Input
                  id="notification-recipients"
                  aria-describedby="notification-recipients-help"
                  autoComplete="off"
                  value={recipients}
                  onChange={(event) => setRecipients(event.target.value)}
                  placeholder="you@example.com, team@example.com"
                />
              </label>
              <p
                id="notification-recipients-help"
                className="text-xs leading-5 text-muted-foreground"
              >
                Up to five addresses, separated by commas. Recipients appear
                together in the email’s To field.
              </p>
            </fieldset>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {settings.hasKey && (
                <Button
                  type="button"
                  variant="destructive-gradient"
                  size="action"
                  className="mr-auto"
                  disabled={busy}
                  onClick={() => void save(true)}
                >
                  Disconnect
                </Button>
              )}
              <Button
                type="button"
                variant="raised"
                size="action"
                disabled={busy}
                onClick={() => {
                  setKey("");
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="gradient"
                size="action"
                disabled={busy}
              >
                {busy ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
