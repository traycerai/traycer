import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { create } from "zustand";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import { usePortalConcealed } from "@/components/ui/portal-concealment-context";

/**
 * How many modal surfaces are PRESENTED right now - content on screen, not
 * roots mounted. The spotlight tour suspends itself while this is non-zero
 * (contract 3 of the onboarding plan): a tour card under a modal is unusable,
 * and the tour's own keyboard handling must not see the modal's Esc.
 *
 * Only the three shadcn wrappers that own a modal layer register here
 * (`dialog.tsx`, `sheet.tsx`, `drawer.tsx`). ContextMenu, DropdownMenu and
 * modal Popover are deliberately NOT counted; their `hideOthers` can hide the
 * tour card for a moment, which the coordinator accepted as residual. Do not
 * widen the set without that decision.
 *
 * Registration is a token per PRESENTED content node, not per root, because a
 * root retains its logical open state through things that un-present it: a
 * background split pane (`usePaneAwareContentGuard`), a concealed region
 * (`usePortalConcealed`), and a force-mounted-but-closed content. Each of
 * those must read as "no modal", so the token lives in a child rendered by the
 * primitive Content and is gated on the same facts.
 */
interface ModalPresenceState {
  readonly presentedModalCount: number;
}

export const useModalPresenceStore = create<ModalPresenceState>()(() => ({
  presentedModalCount: 0,
}));

export function selectPresentedModalCount(state: ModalPresenceState): number {
  return state.presentedModalCount;
}

export function usePresentedModalCount(): number {
  return useModalPresenceStore(selectPresentedModalCount);
}

/**
 * Count one presented modal until the returned release runs. Release is
 * idempotent, so a StrictMode double-invoke or a defensive second call cannot
 * drive the count negative.
 */
export function registerPresentedModal(): () => void {
  let released = false;
  useModalPresenceStore.setState((state) => ({
    presentedModalCount: state.presentedModalCount + 1,
  }));
  return () => {
    if (released) return;
    released = true;
    useModalPresenceStore.setState((state) => ({
      presentedModalCount: state.presentedModalCount - 1,
    }));
  };
}

export function resetModalPresenceForTests(): void {
  useModalPresenceStore.setState({ presentedModalCount: 0 });
}

/**
 * What a wrapper root knows that its content cannot read from Radix: whether
 * the root is modal at all, and whether it is logically open (which only
 * matters for force-mounted content - un-forced content is mounted exactly
 * while presented or animating out, and both of those count).
 */
export interface ModalRootPresence {
  readonly modal: boolean;
  readonly open: boolean;
}

export const ModalRootPresenceContext = createContext<ModalRootPresence | null>(
  null,
);

export interface ModalRootProps {
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly modal?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

/**
 * Mirrors the primitive's controlled/uncontrolled open resolution so the
 * wrapper can publish it. The primitive still owns the state; this only
 * observes `onOpenChange` for the uncontrolled case, so callers keep exactly
 * the behaviour they had. Spread the returned `onOpenChange` onto the root
 * AFTER the caller's props so it wraps theirs.
 */
export function useModalRootPresence(props: ModalRootProps): {
  readonly presence: ModalRootPresence;
  readonly onOpenChange: (open: boolean) => void;
} {
  const { open, defaultOpen, modal, onOpenChange } = props;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(
    defaultOpen === true,
  );
  const resolvedOpen = open === undefined ? uncontrolledOpen : open;
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const presence = useMemo<ModalRootPresence>(
    () => ({ modal: modal !== false, open: resolvedOpen }),
    [modal, resolvedOpen],
  );
  return { presence, onOpenChange: handleOpenChange };
}

/**
 * Rendered INSIDE the primitive Content by each wrapper. Counts while the
 * content is presented: root is modal, not in a concealed region or an
 * unfocused split pane, and either open or not force-mounted (a force-mounted
 * closed content is in the DOM but not presented). Mounting/unmounting of the
 * content itself - Radix presence, including the exit animation - is what
 * starts and ends the token for ordinary content.
 */
export function PresentedModalRegistration({
  forceMount,
}: {
  readonly forceMount: boolean;
}): null {
  const root = useContext(ModalRootPresenceContext);
  const concealed = usePortalConcealed();
  const paneFocused = usePaneFocused();
  const presented =
    root !== null &&
    root.modal &&
    !concealed &&
    paneFocused &&
    (root.open || !forceMount);
  useEffect(() => {
    if (!presented) return undefined;
    return registerPresentedModal();
  }, [presented]);
  return null;
}
