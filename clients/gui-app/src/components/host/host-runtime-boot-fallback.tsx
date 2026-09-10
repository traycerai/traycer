import type { ReactNode } from "react";
import { HostBootSurface } from "@/components/host/host-boot-surface";
import { APP_HEADER_HEIGHT_CLASS } from "@/components/layout/header/app-header-height";
import { cn } from "@/lib/utils";
import { BRAND_DARK_GROUND_CLASS } from "@/components/auth/brand-surface";
import { isMobileApp } from "@/lib/mobile-app";

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
  // On the installed mobile app this window is a KEYCHAIN READ, not a host
  // start: there is no bundled local host to install or boot (`onLocalHostChange`
  // emits `null` and never transitions), and the bootstrap-log disclosure
  // self-hides for want of a CLI. So the card's "Starting Traycer…" describes
  // work that is not happening. A plain dark surface says nothing instead, on
  // the same ground as the native launch image so the handoff is invisible.
  //
  // Desktop is untouched: there the same window really is a host starting, and
  // the card's heading, progress bar and `Open settings` escape hatch all mean
  // what they say.
  if (isMobileApp()) {
    return (
      <div
        // `#root` reserves the top and both horizontal insets app-wide as its
        // own PADDING, so a surface inside it can never paint those strips -
        // they keep showing the app background while this fills the content
        // box, and a launch would open on a dark card inside a lighter frame.
        // The marker lets `index.css` paint `#root` itself for exactly this
        // phase; a second `fixed inset-0` full-bleed surface is not available,
        // because the contract test asserts that marker appears exactly once.
        data-boot-ground=""
        className={cn(
          "flex min-h-safe-svh w-full flex-col",
          BRAND_DARK_GROUND_CLASS,
        )}
        data-testid="host-runtime-boot-fallback"
      />
    );
  }

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
