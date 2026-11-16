import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { cn } from "cn";
import type * as React from "react";
import { Button } from "@/components/ui/button";

function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogPrimitive.Backdrop
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-[oklch(0.965_0_0)]/80 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none dark:bg-[oklch(0.15_0_0)]/80"
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-1/2 flex-col rounded-xl bg-neutral-50 p-1.5 shadow-[0_20px_25px_-5px_rgb(0_0_0/0.03),0_8px_10px_-6px_rgb(0_0_0/0.03)] ring ring-(--control-outline) outline-none transition-[transform,opacity] duration-200 data-ending-style:opacity-0 data-ending-style:[transform:translateY(0.5rem)] data-starting-style:opacity-0 data-starting-style:[transform:translateY(0.5rem)] motion-reduce:transition-none dark:bg-[oklch(0.12_0_0)]",
          className,
        )}
        {...props}
      >
        <div
          data-slot="dialog-surface"
          className="relative flex min-h-0 flex-col overflow-hidden rounded-lg bg-white text-neutral-900 ring ring-neutral-200 dark:bg-[oklch(0.17_0_0)] dark:text-neutral-100 dark:ring-neutral-800"
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              aria-label="Close"
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-4 right-4 cursor-pointer sm:top-5 sm:right-5"
                />
              }
            >
              <XIcon aria-hidden="true" />
            </DialogPrimitive.Close>
          )}
        </div>
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex shrink-0 flex-col gap-1 p-5 pr-14 sm:p-6 sm:pr-16",
        className,
      )}
      {...props}
    />
  );
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        "min-h-0 min-w-0 overflow-y-auto overscroll-contain px-5 pt-0.5 pb-5 sm:px-6 sm:pb-6",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-heading text-base font-medium", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-neutral-500 dark:text-neutral-400",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
