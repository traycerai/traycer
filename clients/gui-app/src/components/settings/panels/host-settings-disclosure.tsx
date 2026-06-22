import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface DisclosureProps {
  readonly label: string;
  readonly defaultOpen: boolean;
  readonly children: ReactNode;
}

export function HostSettingsDisclosure(props: DisclosureProps) {
  const { label, defaultOpen, children } = props;
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="border-b border-border/40 last:border-b-0"
    >
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-5 py-3 text-left text-ui-sm font-medium text-foreground transition-colors hover:bg-muted/20">
        <span>{label}</span>
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="bg-muted/10">
        <div className="px-5 py-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
