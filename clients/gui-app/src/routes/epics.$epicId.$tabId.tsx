import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksFirstPageQueryOptions,
  registerCloudEpicTasksClient,
} from "@/lib/cloud-epic-tasks-query";
import { requireSignedIn } from "@/lib/router-auth";
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
    if (tab?.epicId === params.epicId) return;
    const fallback = state.resolveTabIdForEpic(params.epicId);
    if (fallback === null) return;
    redirect({
      to: "/epics/$epicId/$tabId",
      params: { epicId: params.epicId, tabId: fallback },
      search,
      throw: true,
    });
  },
  loader: ({ context }) => {
    const hostId = context.getActiveHostId();
    const client = context.getHostClient();
    const auth = context.getAuthSnapshot();
    if (hostId === null || client === null) return;
    if (auth.status !== "signed-in") return;
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
