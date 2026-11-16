import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import type { ComponentProps } from "react";
import { Input } from "./input";

export function Autocomplete({
  items,
  value,
  onValueChange,
  disabled,
  required,
  ...inputProps
}: Omit<ComponentProps<typeof Input>, "onChange" | "value"> & {
  items: readonly string[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <AutocompletePrimitive.Root
      items={items}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      required={required}
      openOnInputClick
    >
      <AutocompletePrimitive.Input render={<Input {...inputProps} />} />
      <AutocompletePrimitive.Portal>
        <AutocompletePrimitive.Positioner
          className="isolate z-50"
          sideOffset={6}
        >
          <AutocompletePrimitive.Popup className="floating-surface min-w-(--anchor-width) overflow-y-auto p-1.5 shadow-lg data-empty:hidden">
            <AutocompletePrimitive.List className="empty:hidden">
              {(item: string) => (
                <AutocompletePrimitive.Item
                  key={item}
                  value={item}
                  className="floating-item"
                >
                  {item}
                </AutocompletePrimitive.Item>
              )}
            </AutocompletePrimitive.List>
          </AutocompletePrimitive.Popup>
        </AutocompletePrimitive.Positioner>
      </AutocompletePrimitive.Portal>
    </AutocompletePrimitive.Root>
  );
}
