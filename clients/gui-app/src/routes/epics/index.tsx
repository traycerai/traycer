import { createFileRoute } from "@tanstack/react-router";
import {
  cloudEpicTasksFirstPageQueryOptions,
  listCloudTasksRequestForHistorySearch,
  registerCloudEpicTasksClient,
} from "@/lib/cloud-epic-tasks-query";
import {
  historySearchParamsSchema,
  parseHistorySearch,
} from "@/lib/history-search";
import { requireSignedIn } from "@/lib/router-auth";
import { EpicsIndexRoute } from "../epics-index-route-components";

export const Route = createFileRoute("/epics/")({
  validateSearch: (search: Record<string, unknown>) =>
    historySearchParamsSchema.parse(search),
  loaderDeps: ({ search }) => ({
    historySearch: parseHistorySearch(search),
  }),
  beforeLoad: ({ context }) => {
    requireSignedIn(context);
  },
  loader: ({ context, deps }) => {
    const historyNowMs = Date.now();
    const hostId = context.getActiveHostId();
    const client = context.getHostClient();
    const auth = context.getAuthSnapshot();
    if (hostId === null || client === null) return { historyNowMs };
    if (auth.status !== "signed-in") return { historyNowMs };
    const userId = auth.contextMetadata?.userId ?? null;
    if (userId === null) return { historyNowMs };
    if (client.getRequestContextUserId() !== userId) return { historyNowMs };
    registerCloudEpicTasksClient(hostId, client);
    void context.queryClient.prefetchQuery(
      cloudEpicTasksFirstPageQueryOptions(
        hostId,
        userId,
        listCloudTasksRequestForHistorySearch(deps.historySearch),
      ),
    );
    return { historyNowMs };
  },
  component: EpicsIndexRoute,
});
