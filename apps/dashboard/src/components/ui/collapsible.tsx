import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { cn } from "cn";

const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleContent = CollapsiblePrimitive.Panel;

function CollapsibleTrigger({
  children,
  className,
  ...props
}: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(
        "group flex w-full cursor-pointer items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-(--button-gradient-base)",
        className,
      )}
      {...props}
    >
      <CaretRightIcon
        aria-hidden="true"
        className="size-3 shrink-0 text-muted-foreground group-data-panel-open:rotate-90"
      />
      <span>{children}</span>
    </CollapsiblePrimitive.Trigger>
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
