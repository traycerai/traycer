import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { goBack, goForward } from "@/lib/commands/actions";
import {
  useHistoryNavAvailable,
  useHistoryNavState,
} from "@/lib/history-navigation";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";

/**
 * In-app back/forward arrows for the desktop title bar. Walk the global
 * TanStack Router history via the shared `goBack`/`goForward` actions on the
 * CURRENT router. Enabled state comes from the load-free controller signal
 * (`useHistoryNavState`), so the arrows reflect liveness without forcing a
 * route load. Self-gates on `useHistoryNavAvailable()` (false under
 * browser/memory history), so it renders nothing outside Electron. Mounted by
 * `app-header.tsx` only in the `app` variant — that header lives inside the
 * router tree, where `useRouter()` is non-null; the `host-loading` header
 * renders above the router and never mounts these arrows.
 */
export function HistoryNavButtons() {
  const available = useHistoryNavAvailable();
  if (!available) {
    return null;
  }
  return <HistoryNavArrows />;
}

/**
 * Split from the gate above so the state subscription mounts ONLY where the
 * arrows do. Read inside one component, `useHistoryNavState` would run before
 * the availability check could return - subscribing, and re-rendering on every
 * navigation, in a shell that renders nothing at all. Availability never flips
 * for the life of a router (it is a property of the history that router was
 * built with), so this boundary is stable and costs no remount.
 */
function HistoryNavArrows() {
  const placement = useColumnOverlayPlacement("top");
  const router = useRouter();
  const { canGoBack, canGoForward } = useHistoryNavState();
  const backChord = useBindingForAction("nav.back");
  const forwardChord = useBindingForAction("nav.forward");
  const backTooltip =
    backChord === null
      ? "Go back"
      : `Go back (${formatChordForDisplay(backChord)})`;
  const forwardTooltip =
    forwardChord === null
      ? "Go forward"
      : `Go forward (${formatChordForDisplay(forwardChord)})`;
  return (
    // Non-editable chrome: the layout editor dims this cluster while a session
    // is live (4.2). The marker sits on the arrows' own box, which contains no
    // customizable region - a `filter` on an ancestor of one would dim the
    // region it contains. The cluster opts out of the title-bar drag region so
    // the arrows stay clickable on frameless desktop.
    <div
      data-layout-passive
      className="flex shrink-0 items-center [-webkit-app-region:no-drag]"
    >
      {/* Tooltip trigger is the wrapping <span>, not the Button: a disabled
          Button receives no pointer events, so a tooltip attached directly to it
          would vanish exactly when the arrow is disabled - the moment a user most
          needs the label to know what the greyed control does. */}
      <TooltipWrapper
        label={backTooltip}
        side={placement?.side ?? "top"}
        sideOffset={6}
        align={placement?.align}
      >
        <span className="inline-flex">
          <Button
            type="button"
            variant="muted"
            size="icon-sm"
            aria-label="Go back"
            data-testid="history-nav-back"
            disabled={!canGoBack}
            onClick={() => goBack(router)}
          >
            <ArrowLeft className="size-4" />
          </Button>
        </span>
      </TooltipWrapper>
      <TooltipWrapper
        label={forwardTooltip}
        side={placement?.side ?? "top"}
        sideOffset={6}
        align={placement?.align}
      >
        <span className="inline-flex">
          <Button
            type="button"
            variant="muted"
            size="icon-sm"
            aria-label="Go forward"
            data-testid="history-nav-forward"
            disabled={!canGoForward}
            onClick={() => goForward(router)}
          >
            <ArrowRight className="size-4" />
          </Button>
        </span>
      </TooltipWrapper>
    </div>
  );
}
