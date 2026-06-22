import { useEffect, useMemo, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { PromotableModalFrame } from "@/components/layout/dialogs/promotable-modal-frame";
import {
  useSystemTabModalController,
  useSystemTabModalRefreshGuard,
  type SystemModalActive,
} from "@/stores/tabs/use-system-tab-modal";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import {
  overlayMeta,
  renderOverlayBody,
} from "@/stores/tabs/system-overlay-registry";
import { LEADER_SCOPE_SETTINGS } from "@/lib/keybindings/leader-scope";

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
  const open = modal.active !== null;

  // External-store sync - publish the live modal API for framework-free
  // callers (router adapter, keybinding dispatch, palette sources).
  useEffect(() => {
    setSystemTabModalApi(modal);
    return () => {
      setSystemTabModalApi(null);
    };
  }, [modal]);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) modal.close();
      }}
    >
      {modal.active === null ? null : (
        <SystemTabModalSurface
          active={modal.active}
          onClose={modal.close}
          onPromote={modal.promoteToTab}
        />
      )}
    </DialogPrimitive.Root>
  );
}

interface SystemTabModalSurfaceProps {
  readonly active: SystemModalActive;
  readonly onClose: () => void;
  readonly onPromote: () => void;
}

function SystemTabModalSurface(props: SystemTabModalSurfaceProps): ReactNode {
  const { active, onClose, onPromote } = props;
  const meta = useMemo(() => overlayMeta(active), [active]);
  const Icon = meta.Icon;
  return (
    <PromotableModalFrame
      icon={<Icon className="size-4 text-muted-foreground" />}
      title={meta.label}
      contentClassName="h-[80vh] w-[80vw] max-w-[min(95vw,80rem)]"
      dataAttributes={{ "data-leader-scope": LEADER_SCOPE_SETTINGS }}
      promoteAriaLabel={`Open ${meta.label} as a tab`}
      promoteTestId={`system-tab-modal-promote-${active.kind}`}
      closeTestId={`system-tab-modal-close-${active.kind}`}
      onPromote={onPromote}
      onClose={onClose}
    >
      <SystemTabModalBody active={active} onClose={onClose} />
    </PromotableModalFrame>
  );
}

function SystemTabModalBody(props: {
  readonly active: SystemModalActive;
  readonly onClose: () => void;
}): ReactNode {
  return renderOverlayBody(props.active, props.onClose);
}
