import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import type { ComponentProps } from "react";
import { type Chevron, DayPicker } from "react-day-picker";
import { buttonVariants } from "./button";

function CalendarChevron({ orientation }: ComponentProps<typeof Chevron>) {
  return orientation === "left" ? <CaretLeftIcon /> : <CaretRightIcon />;
}

export function Calendar(props: ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays
      classNames={{
        root: "relative w-fit",
        nav: "absolute inset-x-0 top-0 flex items-center justify-between",
        button_previous: buttonVariants({ variant: "ghost", size: "icon-sm" }),
        button_next: buttonVariants({ variant: "ghost", size: "icon-sm" }),
        month_caption:
          "flex h-7 items-center justify-center text-sm font-medium",
        month_grid: "mt-2 border-separate border-spacing-0.5",
        weekday: "pb-1 text-xs font-normal text-muted-foreground",
        day: "p-0 aria-selected:[&>button]:bg-primary aria-selected:[&>button]:text-primary-foreground",
        day_button: buttonVariants({
          variant: "ghost",
          size: "icon",
          className: "font-normal tabular-nums",
        }),
        today:
          "[&>button]:ring [&>button]:ring-inset [&>button]:ring-(--control-outline)",
        outside: "text-muted-foreground",
      }}
      components={{
        Chevron: CalendarChevron,
      }}
      {...props}
    />
  );
}
