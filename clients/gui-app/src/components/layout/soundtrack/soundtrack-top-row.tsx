import type { ReactNode } from "react";
import { APP_HEADER_HEIGHT_CLASS } from "@/components/layout/header/app-header-height";
import type { AppTitleBandKind } from "@/components/layout/header/app-title-band-kind";
import { isFramelessDesktop } from "@/components/layout/header/title-bar-drag";
import { SoundtrackControl } from "@/components/layout/soundtrack/soundtrack-control";
import { useSoundtrackTopRowDrawn } from "@/components/layout/soundtrack/use-soundtrack-top-row-drawn";
import { cn } from "@/lib/utils";
import { useTitleBarDraggingSuppressed } from "@/stores/layout/title-bar-drag-store";

/**
 * What the top row carries: the soundtrack's toggle. Each chrome kind draws
 * exactly one of these.
 *
 * Three columns, the toggle in the last, so it sits right of the row's middle.
 * The empty first column is as wide as the toggle's until room runs out, and
 * then it is the first thing to give way.
 */
export function SoundtrackTopRowControl(): ReactNode {
  return (
    <div className="grid min-w-0 grid-cols-[1fr_auto_1fr] items-center self-stretch">
      <div className="col-start-3 flex items-center self-stretch">
        <SoundtrackControl />
      </div>
    </div>
  );
}

/**
 * The top row where no header carries it, centred on the content column. Under
 * a title band the band is already there but spans the window, so the slot
 * rises into it from the column instead of adding height. With no band the row
 * is drawn, as tall as the band, and stays a drag region outside the control.
 */
export function SoundtrackColumnTopRow(props: {
  readonly titleBand: AppTitleBandKind;
}): ReactNode {
  const drawn = useSoundtrackTopRowDrawn();
  const dragSuppressed = useTitleBarDraggingSuppressed();
  // The header carries its own (`DesktopAppHeader`).
  if (!drawn || props.titleBand === "header") return null;
  if (props.titleBand === "band") {
    return (
      <div
        data-testid="soundtrack-top-row"
        data-title-band="band"
        className="pointer-events-none absolute inset-x-0 bottom-full z-20 flex h-[var(--app-title-band-height)] items-center justify-center"
      >
        <div className="pointer-events-auto flex min-w-0 items-center self-stretch [-webkit-app-region:no-drag]">
          <SoundtrackTopRowControl />
        </div>
      </div>
    );
  }
  const frameless = isFramelessDesktop();
  return (
    <div
      data-testid="soundtrack-top-row"
      data-title-band="none"
      className={cn(
        "relative z-20 flex shrink-0 items-center justify-center px-3",
        APP_HEADER_HEIGHT_CLASS,
        frameless && !dragSuppressed && "[-webkit-app-region:drag]",
      )}
    >
      <div className="flex min-w-0 items-center self-stretch [-webkit-app-region:no-drag]">
        <SoundtrackTopRowControl />
      </div>
    </div>
  );
}
