import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
  EpicSessionPresentationContext,
} from "@/lib/registries/epic-session-registry";
import {
  getEpicSessionController,
  type EpicSessionTabSnapshot,
} from "@/lib/registries/epic-session-controller";
// For its side effect: the open-tab projection that gives the controller its
// membership. Imported here as well as by the tab host so that wherever a
// provider can mount, the tab it mounts for is already a member.
import "@/lib/epics/epic-parking-open-tabs";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";

interface EpicSessionProviderProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly children: ReactNode;
}

/**
 * The React OBSERVER of one tab's epic session.
 *
 * The session is owned by the tab, not by this component: the controller
 * (`lib/registries/epic-session-controller.ts`) acquires it because the tab is
 * open, claims this tab's desktop ownership, selects the host, re-points,
 * backs off, parks and releases. This provider does three things only:
 *
 *  - reads the controller's per-tab snapshot into the three session contexts;
 *  - tells the controller a SURFACE is showing this tab, which is what holds
 *    the session's residency while a pane can see it;
 *  - forwards the two user commands, Retry and "open on original host".
 *
 * It never acquires, re-points or releases. Mounting it for a tab that is not
 * open yields no session: membership is the tab store's fact, not this
 * component's.
 */
export function EpicSessionProvider(
  props: EpicSessionProviderProps,
): ReactNode {
  const { epicId, tabId, children } = props;
  const controller = getEpicSessionController();

  // Opening the task is what retires its imported-unseen dot, and every open
  // path - list click, palette, deep link - mounts this provider.
  useEffect(() => {
    useImportedUnseenStore.getState().markSeen(epicId);
  }, [epicId]);

  const navigate = useNavigate();

  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const readSnapshot = useCallback(
    (): EpicSessionTabSnapshot => controller.readTabSnapshot(epicId, tabId),
    [controller, epicId, tabId],
  );
  const snapshot = useSyncExternalStore(subscribe, readSnapshot);

  // A pane is showing this tab. Residency, not intent: detaching leaves the
  // session warm for the cap and parking to decide, as unmounting always did.
  useEffect(
    () => controller.attachSurface(epicId, tabId),
    [controller, epicId, tabId],
  );

  // Another window owns this TAB, so the controller has discarded it here.
  // Leaving the route is the one part of that only a mounted surface can do.
  useEffect(
    () =>
      controller.subscribeOwnershipDenied((deniedEpicId, deniedTabId) => {
        if (deniedEpicId !== epicId || deniedTabId !== tabId) return;
        void navigate({ to: "/epics", replace: true });
      }),
    [controller, epicId, navigate, tabId],
  );

  const retry = useCallback(() => {
    controller.retry(epicId);
  }, [controller, epicId]);
  const openOnOriginalHost = useCallback(() => {
    controller.openOnOriginalHost(epicId);
  }, [controller, epicId]);
  const { handle, presentation, sessionHostClient } = snapshot;
  const sessionPresentation = useMemo(
    () => ({
      ...presentation,
      retry,
      openOnOriginalHost,
    }),
    [openOnOriginalHost, presentation, retry],
  );

  return (
    <EpicSessionContext.Provider value={handle}>
      <EpicSessionPresentationContext.Provider value={sessionPresentation}>
        <EpicSessionHostClientContext.Provider value={sessionHostClient}>
          {children}
        </EpicSessionHostClientContext.Provider>
      </EpicSessionPresentationContext.Provider>
    </EpicSessionContext.Provider>
  );
}
