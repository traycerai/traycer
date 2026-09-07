import type { ReactNode } from "react";
import { HostBootSurface } from "@/components/host/host-boot-surface";
import { APP_HEADER_HEIGHT_CLASS } from "@/components/layout/header/app-header-height";
import { cn } from "@/lib/utils";

/** The first of a launch's three boot surfaces: what `HostRuntimeProvider` draws before the runtime binding
 * exists, i.e. before any app chrome. */
export function HostRuntimeBootFallback(props: {
  readonly onConfigureShell: () => void;
  readonly onOpenSettings: () => void;
}): ReactNode {
  return (
    <div
      className="flex min-h-safe-svh w-full flex-col bg-background text-foreground"
      data-testid="host-runtime-boot-fallback"
    >
      <div aria-hidden className={cn("shrink-0", APP_HEADER_HEIGHT_CLASS)} />
      <div className="flex flex-1 items-center justify-center p-6">
        <HostBootSurface
          testId={null}
          onConfigureShell={props.onConfigureShell}
          onOpenSettings={props.onOpenSettings}
        />
      </div>
    </div>
  );
}
