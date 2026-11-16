import { CalendarBlankIcon } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { useState } from "react";
import { Button } from "./button";
import { Calendar } from "./calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

function dateValue(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function DatePicker({
  label,
  value,
  min,
  max,
  onValueChange,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? new Date(`${value}T00:00:00`) : undefined;
  const minDate = min ? new Date(`${min}T00:00:00`) : undefined;
  const maxDate = max ? new Date(`${max}T00:00:00`) : undefined;
  const display = selected?.toLocaleDateString(undefined, {
    dateStyle: "medium",
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="raised"
            size="action"
            aria-label={`${label}: ${display ?? "Pick a date"}`}
          />
        }
      >
        <CalendarBlankIcon aria-hidden="true" data-icon="inline-start" />
        {display ?? "Pick a date"}
      </PopoverTrigger>
      <PopoverContent align="start" aria-label={label}>
        <Calendar
          mode="single"
          autoFocus
          selected={selected}
          defaultMonth={selected ?? maxDate ?? minDate}
          startMonth={minDate}
          endMonth={maxDate}
          disabled={[
            ...(minDate ? [{ before: minDate }] : []),
            ...(maxDate ? [{ after: maxDate }] : []),
          ]}
          onSelect={(date) => {
            onValueChange(date ? dateValue(date) : "");
            setOpen(false);
          }}
        />
        {selected && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 self-end"
            onClick={() => {
              onValueChange("");
              setOpen(false);
            }}
          >
            Clear date
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
