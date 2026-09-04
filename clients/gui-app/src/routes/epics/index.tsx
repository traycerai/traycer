import { createFileRoute } from "@tanstack/react-router";
import { getNegotiatedHostMethodVersion } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  cloudEpicTasksFirstPageQueryOptions,
  listCloudTasksRequestForHistorySearch,
  negotiatedListTasksServesLocalFirst,
  registerCloudEpicTasksClient,
} from "@/lib/cloud-epic-tasks-query";
import {
  historySearchParamsSchema,
  parseHistorySearch,
} from "@/lib/history-search";
import { requireSignedIn } from "@/lib/router-auth";
import {
  admitsLocalPlane,
  authorizesCloudCapability,
} from "@/stores/auth/auth-store";
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
    const client = context.getHostClient();
    const hostId = client?.getActiveHostId() ?? null;
    const auth = context.getAuthSnapshot();
    if (hostId === null || client === null) return { historyNowMs };
    // SURFACE. `beforeLoad` above already admitted this session through
    // `requireSignedIn`, which is `admitsLocalPlane` - so an `unverified` user
    // IS on this route, and skipping the prefetch here handed them exactly the
    // cold History the local-first path exists to avoid. The prefetched call is
    // the same local-first `initial` leg `useCloudEpicTasksQuery` issues (see
    // `resolveCloudTasksUserId`), so admitting it here spends nothing the
    // component would not spend a moment later.
    if (!admitsLocalPlane(auth.status)) return { historyNowMs };
    // ...but only if the host will actually serve it locally. The hook applies
    // this same version gate before ITS leg, and the prefetch is that leg
    // issued earlier: a pre-`@1.6` host strips `localFirstPhase` and runs the
    // released cloud-backed list on the retained credential, so without the
    // gate a route navigation spent cloud capability the verdict withheld. A
    // manifest that has not arrived yet answers `null` and skips - the
    // component fetches the moment the host says `1.6`. Found in review.
    if (
      !authorizesCloudCapability(auth.status) &&
      !negotiatedListTasksServesLocalFirst(
        getNegotiatedHostMethodVersion(hostId, "epic.listTasks"),
      )
    ) {
      return { historyNowMs };
    }
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
