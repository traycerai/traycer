import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  isFoundTaskContext,
  type TaskContextResult,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useShallow } from "zustand/react/shallow";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  updateEpicTitleInCloudTaskCaches,
  updateEpicTitleInTaskContextsCaches,
} from "@/lib/cloud-epic-tasks-query/cache";
import { sessionCreatedEpicHostId } from "@/lib/epics/session-created-epics";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import type { HostRpcRegistry } from "@/lib/host";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

/**
 * Fills in the generated title of an epic whose tab was never activated.
 *
 * The renderer learns an epic's title through its open-epic session: the
 * session's store projects it, `use-epic-route-synchronization` persists it
 * onto the tab record, and the session provider writes it through to the
 * History caches. All three exist only while the epic's surface is mounted.
 * A task submitted from the landing composer and left before the create
 * settled gets its tab swapped in WITHOUT activation (the draft no longer
 * owns focus), so no surface mounts, no session is acquired, and the tab
 * keeps the empty name it was created with - "Untitled task" - until the
 * user opens it, long after the host wrote the real title.
 *
 * This bridge covers exactly that gap with a bounded pull. The trigger and
 * the lifetime are the canvas store's `pendingEpicTitles` entry, which the
 * create flow records and the 30s backstop clears: for every pending epic
 * that has NO live session (a mounted session already does this work), ask
 * the host for that one epic's task light on the method's short opt-in poll
 * cadence, and the moment a non-empty title comes back apply it through the
 * same seams the session path uses - the tab rename and the History cache
 * write-throughs - then clear the pending entry, which also stops the
 * spinner and unmounts the probe.
 *
 * The probe is addressed to the host the epic was created on
 * (`sessionCreatedEpicHostId`), since that host answers locally for a
 * local-first epic; outside the create race window it follows the app-wide
 * host, which is where the epic's session would open anyway. A host that
 * does not advertise `epic.getTaskContexts` is never asked, and the cloud
 * verdict gates both render and dispatch like every other reader of the
 * method.
 */
const TITLE_METHOD = "epic.getTaskContexts" as const;

export function PendingEpicTitleFetcher() {
  const epicIds = usePendingSessionlessEpicIds();
  return epicIds.map((epicId) => (
    <PendingEpicTitleProbe key={epicId} epicId={epicId} />
  ));
}

/**
 * The pending-title epics this window holds no session for. Re-evaluated on
 * both sources: a session acquired later (the user opened the tab) removes
 * the epic here and hands the work to the session path.
 */
function usePendingSessionlessEpicIds(): ReadonlyArray<string> {
  const pendingEpicIds = useEpicCanvasStore(
    useShallow((state) => Object.keys(state.pendingEpicTitles)),
  );
  const registry = getOpenEpicRegistry();
  // A joined string so the snapshot compares by value under `Object.is`;
  // a fresh array per read would re-render on every registry emit. Epic ids
  // are UUIDs, so a comma can never split one.
  const sessionless = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () =>
      pendingEpicIds
        .filter((epicId) => registry.peek(epicId) === null)
        .join(","),
    () => "",
  );
  return sessionless.length === 0 ? EMPTY_IDS : sessionless.split(",");
}

const EMPTY_IDS: ReadonlyArray<string> = [];

function PendingEpicTitleProbe(props: { readonly epicId: string }) {
  const { epicId } = props;
  const queryClient = useQueryClient();
  const client = useHostClientForHostId(sessionCreatedEpicHostId(epicId));
  const readiness = useReactiveHostReadiness(client);
  const methodSupport = useHostMethodSupport(readiness.hostId, TITLE_METHOD);
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const query = useHostQuery<HostRpcRegistry, typeof TITLE_METHOD>({
    client,
    method: TITLE_METHOD,
    params: { taskIds: [epicId] },
    // Its own cache slot: the existence reconciler and the title readers hold
    // this method's results for much longer, and this probe must re-ask.
    cacheKeyIdentity: ["pending-title", userId],
    preflight: cloudVerdictPreflight(TITLE_METHOD),
    options: {
      enabled: methodSupport === true && cloudAuthorized && userId !== null,
      poll: true,
      staleTime: 0,
    },
  });

  const title = generatedTitleFromResponse(query.data?.tasks[epicId]);
  useEffect(() => {
    if (title === null || userId === null) return;
    const canvas = useEpicCanvasStore.getState();
    for (const tab of Object.values(canvas.tabsById)) {
      if (tab !== undefined && tab.epicId === epicId) {
        canvas.renameTab(tab.tabId, title);
      }
    }
    const scope = { hostId: null, userId };
    updateEpicTitleInCloudTaskCaches(queryClient, scope, epicId, title);
    updateEpicTitleInTaskContextsCaches(queryClient, scope, epicId, title);
    canvas.clearEpicTitlePending(epicId);
  }, [epicId, queryClient, title, userId]);

  return null;
}

function generatedTitleFromResponse(
  result: TaskContextResult | undefined,
): string | null {
  if (!isFoundTaskContext(result)) return null;
  const title = result.task.epic?.light?.title ?? "";
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}
