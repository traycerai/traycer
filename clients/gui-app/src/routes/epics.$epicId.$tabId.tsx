import { createFileRoute, redirect } from "@tanstack/react-router";
import { getNegotiatedHostMethodVersion } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksFirstPageQueryOptions,
  negotiatedListTasksServesLocalFirst,
  registerCloudEpicTasksClient,
} from "@/lib/cloud-epic-tasks-query";
import { requireSignedIn } from "@/lib/router-auth";
import {
  admitsLocalPlane,
  authorizesCloudCapability,
} from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { EpicRoute } from "./epic-tab-route-components";
import { normalizeEpicFocusSearch } from "./epic-route-search";

export const Route = createFileRoute("/epics/$epicId/$tabId")({
  validateSearch: (search: Record<string, unknown>) =>
    normalizeEpicFocusSearch(search),
  component: EpicRoute,
  beforeLoad: ({ context, params, search }) => {
    requireSignedIn(context);
    const state = useEpicCanvasStore.getState();
    const tab = state.tabsById[params.tabId];
    if (tab?.epicId === params.epicId) {
      return;
    }
    const fallback = state.resolveTabIdForEpic(params.epicId);
    if (fallback === null) {
      return;
    }
    redirect({
      to: "/epics/$epicId/$tabId",
      params: { epicId: params.epicId, tabId: fallback },
      search: {
        ...search,
        focusPaneId: undefined,
        focusTileInstanceId: undefined,
      },
      throw: true,
    });
  },
  loader: ({ context }) => {
    const client = context.getHostClient();
    const hostId = client?.getActiveHostId() ?? null;
    const auth = context.getAuthSnapshot();
    if (hostId === null || client === null) return;
    // SURFACE, on the same reading as `/epics`: this warms the History first
    // page so the overlay opens populated from inside an epic tab, and that
    // page is the local-first `initial` leg. `beforeLoad`'s `requireSignedIn`
    // already admits `unverified` onto this route, so leaving the prefetch on
    // the verdict only made the overlay cold for the one cohort whose rows are
    // guaranteed to be sitting on local disk.
    if (!admitsLocalPlane(auth.status)) return;
    // Same version gate as `/epics` and the hook: an unverified prefetch is
    // only admitted on a host that serves the local-first leg. See the
    // `/epics` loader for the mechanism.
    if (
      !authorizesCloudCapability(auth.status) &&
      !negotiatedListTasksServesLocalFirst(
        getNegotiatedHostMethodVersion(hostId, "epic.listTasks"),
      )
    ) {
      return;
    }
    const userId = auth.contextMetadata?.userId ?? null;
    if (userId === null) return;
    if (client.getRequestContextUserId() !== userId) return;
    registerCloudEpicTasksClient(hostId, client);
    void context.queryClient.prefetchQuery(
      cloudEpicTasksFirstPageQueryOptions(
        hostId,
        userId,
        LIST_CLOUD_TASKS_REQUEST,
      ),
    );
  },
});
