import { useEffect, useMemo, type ReactNode } from "react";
import { Dialog } from "@/components/ui/dialog";
import {
  OverlayFrameContext,
  useOverlayFrame,
} from "@/components/ui/overlay-frame-context";
import { PromotableModalFrame } from "@/components/layout/dialogs/promotable-modal-frame";
import "@/components/home/home-touch-targets.css";
import {
  useSystemTabModalController,
  useSystemTabModalRefreshGuard,
  type SystemModalActive,
} from "@/stores/tabs/use-system-tab-modal";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import {
  abandonOverlayPromotion,
  overlayConsumesEscape,
  overlayMeta,
  prepareOverlayForPromotion,
  renderOverlayBody,
} from "@/stores/tabs/system-overlay-registry";
import { LEADER_SCOPE_SETTINGS } from "@/lib/keybindings/leader-scope";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { useTabsStore } from "@/stores/tabs/store";
import { useRulesEditLifetime } from "@/components/settings/panels/permissions/rules-edit-store";

/**
 * Global host for the system-tab modal (Settings / History). Reads
 * its open state from the root overlay search params via the modal
 * hook, drives a single `<Dialog>`, and renders the kind-specific
 * content. Mounted in `__root.tsx` next to `<DesktopDialogHost />`.
 *
 * The modal's content shell is intentionally identical to the
 * tab-mounted variant (same `bg-background`, same sidebar/panel
 * chrome) - the only thing the modal adds is a thin title bar with
 * Pop-out + Close, plus the centered floating frame. Switching
 * between the modal and the tab presentation should feel like the
 * same surface, just framed differently.
 */
export function SystemTabModalHost(): ReactNode {
  const modal = useSystemTabModalController();
  useSystemTabModalRefreshGuard();
  const editingTheme = useThemeLibraryStore((state) => state.draft !== null);
  // The one observer of this window's Settings opening and closing, which is
  // what ends Settings ▸ Rules' unsaved edit: always mounted, so it sees the
  // modal and the Settings tab alike, and outlives the modal's content.
  const settingsTabOpen = useTabsStore(
    (state) => state.systemTabs.settings !== null,
  );
  useRulesEditLifetime(
    modal.active?.kind === "settings" || settingsTabOpen,
    settingsTabOpen,
  );

  // External-store sync - publish the live modal API for framework-free
  // callers (router adapter, keybinding dispatch, palette sources).
  useEffect(() => {
    setSystemTabModalApi(modal);
    return () => {
      setSystemTabModalApi(null);
    };
  }, [modal]);

  return modal.active === null ? null : (
    <SystemTabModalSurface
      active={modal.active}
      editingTheme={editingTheme}
      onClose={modal.close}
      onPromote={modal.promoteToTab}
    />
  );
}

export interface SystemTabModalSurfaceProps {
  readonly active: SystemModalActive;
  readonly editingTheme: boolean;
  readonly onClose: () => void;
  /** `onRejected` runs when the tab navigation refuses the promotion. */
  readonly onPromote: (onRejected: () => void) => void;
}

export function SystemTabModalSurface(
  props: SystemTabModalSurfaceProps,
): ReactNode {
  const { active, editingTheme, onClose, onPromote } = props;
  const meta = useMemo(() => overlayMeta(active), [active]);
  const Icon = meta.Icon;
  const frame = useOverlayFrame();
  return (
    <Dialog
      paneAware={false}
      open
      modal={!editingTheme}
      onOpenChange={(next, details) => {
        if (next) return;
        if (
          (editingTheme && details.reason !== "close-press") ||
          (details.reason === "escape-key" && overlayConsumesEscape(active))
        )
          details.cancel();
        frame.guard(details);
        if (!details.isCanceled) onClose();
      }}
    >
      <OverlayFrameContext.Provider value={frame.registry}>
        <PromotableModalFrame
          backdropRef={frame.backdrop}
          icon={<Icon className="size-4 text-muted-foreground" />}
          title={meta.label}
          // Full-screen sheet below md: the centered 80% box leaves the History
          // list unusably narrow on phones. Pure CSS (not a JS viewport check) so
          // an open modal reflows correctly when the window crosses 768px.
          contentClassName="h-[80vh] w-[80vw] max-w-[min(95vw,80rem)] max-md:h-safe-dvh max-md:w-safe-dvw max-md:max-w-none max-md:rounded-none"
          // The touch-target scope re-applies the coarse-pointer hit-slop rules
          // (home-touch-targets.css) inside this portal - the modal body renders
          // the same list chrome as the home page but portals outside the
          // `[data-home-touch-scope]` subtree HomePage sets.
          dataAttributes={{
            "data-leader-scope": LEADER_SCOPE_SETTINGS,
            "data-home-touch-scope": "",
          }}
          promoteAriaLabel={`Open ${meta.label} as a tab`}
          promoteTestId={`system-tab-modal-promote-${active.kind}`}
          closeTestId={`system-tab-modal-close-${active.kind}`}
          // The body gets its say while it is still mounted: promotion unmounts
          // it, and the tab's body mounts only afterwards. A refused promotion
          // leaves the modal open with no tab to take what was handed over, so the
          // body takes it back.
          onPromote={() => {
            prepareOverlayForPromotion(active);
            onPromote(() => abandonOverlayPromotion(active));
          }}
          onClose={onClose}
          initialFocus={editingTheme ? false : undefined}
        >
          <SystemTabModalBody active={active} onClose={onClose} />
        </PromotableModalFrame>
      </OverlayFrameContext.Provider>
    </Dialog>
  );
}

function SystemTabModalBody(props: {
  readonly active: SystemModalActive;
  readonly onClose: () => void;
}): ReactNode {
  return renderOverlayBody(props.active, props.onClose);
}
