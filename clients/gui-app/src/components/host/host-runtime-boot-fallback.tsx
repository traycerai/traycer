import type { ReactNode } from "react";
import { HostBootSurface } from "@/components/host/host-boot-surface";
import { APP_HEADER_HEIGHT_CLASS } from "@/components/layout/header/app-header-height";
import { cn } from "@/lib/utils";

/**
 * THE FIRST of a launch's three boot surfaces: what `HostRuntimeProvider`
 * draws before the runtime binding exists, i.e. before any app chrome.
 *
 * Deliberately the same component as the two after it - same card, same
 * sentence, same bar, same controls (`HostBootSurface`). Giving each phase its
 * own shape and its own phrasing is what made one continuous wait look like a
 * sequence of unrelated modals.
 *
 * It owns the whole window, so it RESERVES the header's slot instead of
 * centring against the full viewport. The two surfaces after it sit under the
 * gate frame's header, and a card that centres once against the viewport and
 * then against the area under a 40px header moves 20px at the hand-off. Same
 * column, same empty band on top, same `p-6` box: the header later paints INTO
 * the band, and the card does not move.
 */
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
