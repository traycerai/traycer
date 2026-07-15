import { useCallback, useMemo, useState, type ReactNode } from "react";
import { tabRequiresCloseConfirm, tabEpicId } from "@/stores/tabs/registry";
import { UnsyncedCloseDialog } from "@/components/layout/dialogs/unsynced-close-dialog";
import type { HeaderTab } from "@/stores/tabs/types";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

interface PendingClose {
  readonly tab: HeaderTab;
  readonly onConfirm: () => void;
}

export interface UnsyncedCloseDialogController {
  /**
   * When `tabRequiresCloseConfirm(tab)` is true: stash `onConfirm` and open
   * the confirmation dialog. Returns `true` so the orchestrator knows to
   * defer the close. Otherwise returns `false` - the orchestrator finalizes
   * the close itself without prompting.
   */
  readonly promptOrConfirm: (tab: HeaderTab, onConfirm: () => void) => boolean;
  readonly dialog: ReactNode;
}

export function useUnsyncedCloseDialog(): UnsyncedCloseDialogController {
  const [pending, setPending] = useState<PendingClose | null>(null);

  const promptOrConfirm = useCallback(
    (tab: HeaderTab, onConfirm: () => void): boolean => {
      if (!tabRequiresCloseConfirm(tab)) return false;
      setPending({ tab, onConfirm });
      return true;
    },
    [],
  );

  const handleDiscard = useCallback(() => {
    const p = pending;
    setPending(null);
    if (p === null) return;
    Analytics.getInstance().track(AnalyticsEvent.TabCloseBlocked, {
      decision: "discard",
    });
    p.onConfirm();
  }, [pending]);

  const handleWait = useCallback(() => {
    if (pending !== null) {
      Analytics.getInstance().track(AnalyticsEvent.TabCloseBlocked, {
        decision: "cancel",
      });
    }
    setPending(null);
  }, [pending]);

  const dialog = useMemo<ReactNode>(
    () => (
      <UnsyncedCloseDialog
        open={pending !== null}
        epicId={pending === null ? null : tabEpicId(pending.tab)}
        onWait={handleWait}
        onDiscard={handleDiscard}
      />
    ),
    [pending, handleDiscard, handleWait],
  );

  // Memoize the controller so `useCloseTabFlow`'s `requestCloseTab` (which
  // depends on it) keeps a stable identity - a fresh object here churned the
  // header TabItem `onClose` prop on every strip re-render.
  return useMemo(
    () => ({ promptOrConfirm, dialog }),
    [promptOrConfirm, dialog],
  );
}
