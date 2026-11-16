import type { Machine } from "@ephor/api/machines";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, signIn } from "@/lib/auth";

export function MachineActionDialog({
  machine,
  action,
  onClose,
  onComplete,
}: {
  machine: Machine;
  action: "rename" | "disconnect";
  onClose: () => void;
  onComplete: (machine: Machine | null) => void;
}) {
  const [name, setName] = useState(machine.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pending = machine.status === "pending" || machine.status === "expired";
  const cancelled = machine.status === "revoked" && machine.enrolledAt === null;
  const removeEnrollment = pending || cancelled;
  const rename = action === "rename";
  const actionLabel = cancelled
    ? "Remove from Ephor"
    : pending
      ? "Cancel enrollment"
      : "Disconnect";
  const title = rename
    ? "Rename machine"
    : removeEnrollment
      ? actionLabel
      : "Disconnect machine";

  return (
    <Dialog
      open
      onOpenChange={(open, event) => {
        if (busy) event.cancel();
        else if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        initialFocus={rename ? true : cancelRef}
        finalFocus={() => document.getElementById(`machine-row-${machine.id}`)}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {rename
              ? `Choose a name for “${machine.name}” in Ephor.`
              : cancelled
                ? `Remove the cancelled enrollment for “${machine.name}” from Ephor. This machine never connected.`
                : pending
                  ? `Remove the unfinished enrollment for “${machine.name}” and invalidate its install command.`
                  : `Stop monitoring “${machine.name}” in Ephor and revoke its agent credential. Your server and its running services will keep running.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError("");
              try {
                if (rename) {
                  const result = await api<{ id: string; name: string }>(
                    "/machines/rename",
                    { id: machine.id, name: name.trim() },
                  );
                  onComplete({ ...machine, name: result.name });
                } else {
                  await signIn();
                  await api(
                    removeEnrollment
                      ? "/machines/enrollments/cancel"
                      : "/machines/revoke",
                    { id: machine.id },
                  );
                  onComplete(
                    removeEnrollment ? null : { ...machine, status: "revoked" },
                  );
                }
              } catch (error) {
                setError(
                  error instanceof Error ? error.message : "Please try again.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {rename && (
              <div className="space-y-2">
                <label
                  htmlFor="rename-machine-name"
                  className="block text-sm font-medium"
                >
                  Machine name
                </label>
                <Input
                  id="rename-machine-name"
                  className="h-9"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={80}
                  autoComplete="off"
                  disabled={busy}
                />
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                ref={cancelRef}
                type="button"
                variant="raised"
                size="action"
                disabled={busy}
                onClick={onClose}
              >
                {rename ? "Cancel" : "Keep machine"}
              </Button>
              <Button
                type="submit"
                variant={rename ? "gradient" : "destructive-gradient"}
                size="action"
                disabled={
                  busy ||
                  (rename && (!name.trim() || name.trim() === machine.name))
                }
              >
                {busy
                  ? rename
                    ? "Saving…"
                    : removeEnrollment
                      ? "Removing…"
                      : "Disconnecting…"
                  : rename
                    ? "Save name"
                    : actionLabel}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
