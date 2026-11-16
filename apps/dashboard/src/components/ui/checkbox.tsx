import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { cn } from "cn";

export function Checkbox({
  className,
  ...props
}: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm bg-card text-primary-foreground ring ring-(--control-outline) outline-none focus-visible:ring-2 focus-visible:ring-(--button-gradient-base) data-disabled:cursor-not-allowed data-disabled:opacity-50 data-checked:bg-primary data-checked:ring-primary",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <CheckIcon aria-hidden="true" className="size-3" weight="bold" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
