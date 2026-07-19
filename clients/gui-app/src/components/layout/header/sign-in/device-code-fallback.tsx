import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { type DeviceFlowProgress } from "@/lib/auth/auth-service";
import { cn } from "@/lib/utils";
import { CopyableApprovalField } from "./copyable-approval-field";

export function DeviceCodeFallback(props: {
  readonly progress: DeviceFlowProgress;
  readonly isHero: boolean;
}) {
  return (
    <Collapsible
      defaultOpen
      className={cn(
        "overflow-hidden rounded-md border",
        props.isHero
          ? "border-white/10 bg-black/[0.12]"
          : "border-border/70 bg-muted/20",
      )}
    >
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-ui-xs font-medium transition-colors",
          props.isHero
            ? "text-white/[0.72] hover:bg-white/[0.07] hover:text-white"
            : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
        )}
        data-testid="signin-device-fallback-trigger"
      >
        <span>Use code instead</span>
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          className={cn(
            "grid gap-3 border-t px-3 py-3 text-left",
            props.isHero
              ? "border-white/10 text-white/[0.65]"
              : "border-border/70 text-muted-foreground",
          )}
        >
          <CopyableApprovalField
            label="Device code"
            value={props.progress.userCode}
            copyLabel="Copy device code"
            testId="signin-device-code"
            isHero={props.isHero}
            valueKind="code"
          />
          <CopyableApprovalField
            label="Approval address"
            value={props.progress.verificationUri}
            copyLabel="Copy approval address"
            testId="signin-device-url"
            isHero={props.isHero}
            valueKind="url"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
