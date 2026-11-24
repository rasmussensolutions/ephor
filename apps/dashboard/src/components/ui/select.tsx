import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { cn } from "cn";
import type { ReactNode } from "react";

type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  icon?: ReactNode;
};

type SelectProps = Pick<
  SelectPrimitive.Root.Props<string>,
  "id" | "name" | "value" | "defaultValue" | "required" | "disabled"
> & {
  options: readonly SelectOption[];
  placeholder?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  "aria-label"?: string;
};

export function Select({
  options,
  placeholder,
  onValueChange,
  className,
  "aria-label": ariaLabel,
  value,
  defaultValue,
  ...props
}: SelectProps) {
  return (
    <SelectPrimitive.Root
      {...props}
      items={options}
      value={placeholder && value === "" ? null : value}
      defaultValue={placeholder && defaultValue === "" ? null : defaultValue}
      onValueChange={(next) => onValueChange?.(next ?? "")}
      modal={false}
    >
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        aria-label={ariaLabel}
        className={cn("control-surface select-control", className)}
      >
        <SelectPrimitive.Value
          data-slot="select-value"
          className="min-w-0 flex-1 truncate text-left"
          placeholder={placeholder}
        >
          {options.some((option) => option.icon)
            ? (selected: string | null) => {
                const option = options.find((item) => item.value === selected);
                return (
                  <span className="flex min-w-0 items-center gap-2">
                    {option?.icon && (
                      <span
                        aria-hidden="true"
                        className="flex shrink-0 items-center text-muted-foreground"
                      >
                        {option.icon}
                      </span>
                    )}
                    <span className="truncate">
                      {option?.label ?? placeholder}
                    </span>
                  </span>
                );
              }
            : undefined}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon aria-hidden="true" className="shrink-0">
          <CaretDownIcon className="size-3.5 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          className="isolate z-50"
          align="start"
          alignItemWithTrigger={false}
          sideOffset={6}
        >
          <SelectPrimitive.Popup
            data-slot="select-content"
            className="floating-surface flex max-w-(--available-width) min-w-(--anchor-width) flex-col p-1.5 shadow-lg"
          >
            <SelectPrimitive.List className="min-h-0 overflow-y-auto overscroll-contain">
              {options.map(({ value, label, disabled, icon }) => (
                <SelectPrimitive.Item
                  key={value}
                  value={value}
                  disabled={disabled}
                  data-slot="select-item"
                  className="floating-item justify-between"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {icon && (
                      <span
                        aria-hidden="true"
                        className="flex shrink-0 items-center text-muted-foreground"
                      >
                        {icon}
                      </span>
                    )}
                    <SelectPrimitive.ItemText className="min-w-0 break-words">
                      {label}
                    </SelectPrimitive.ItemText>
                  </span>
                  <SelectPrimitive.ItemIndicator className="shrink-0">
                    <CheckIcon aria-hidden="true" className="size-4" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
