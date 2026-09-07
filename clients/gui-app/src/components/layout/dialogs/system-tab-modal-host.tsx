import { useEffect, useMemo, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { PromotableModalFrame } from "@/components/layout/dialogs/promotable-modal-frame";
import "@/components/home/home-touch-targets.css";
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

/** The modal's content shell is intentionally identical to the tab-mounted variant (same `bg-background`, same
 * sidebar/panel chrome). */
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
      // Pure CSS (not a JS viewport check) so an open modal reflows correctly when the window crosses 768px.
      contentClassName="h-[80vh] w-[80vw] max-w-[min(95vw,80rem)] max-md:h-safe-dvh max-md:w-safe-dvw max-md:max-w-none max-md:rounded-none"
      // The touch-target scope re-applies the coarse-pointer hit-slop rules (home-touch-targets.css) inside this
      // portal.
      dataAttributes={{
        "data-leader-scope": LEADER_SCOPE_SETTINGS,
        "data-home-touch-scope": "",
      }}
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
