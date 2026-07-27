import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  PrDetailCore,
  PrGetLocalDiffRequest,
  PrGetLocalDiffResponse,
} from "@traycer/protocol/host/pr-schemas";
import { DEFAULT_PR_LOCAL_DIFF_BYTE_BUDGET } from "@traycer/protocol/host/pr-schemas";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { prQueryKeys } from "@/lib/query-keys/pr-query-keys";

/**
 * The facts a local diff needs, pulled off a detail frame - or `null` when the
 * frame doesn't have them yet.
 *
 * Every field is nullable on the wire because a cache-only or never-swept PR
 * renders from identity alone, so this narrowing is where "can we even ask?"
 * gets decided ONCE, rather than at four separate call sites.
 */
export interface PrLocalDiffTarget {
  readonly epicId: string;
  readonly linkGroupKey: string;
  readonly repoIdentifier: PrDetailCore["repoIdentifier"];
  readonly repoRole: PrDetailCore["repoRole"];
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string | null;
}

export function prLocalDiffTarget(
  core: PrDetailCore,
  epicId: string,
): PrLocalDiffTarget | null {
  if (
    core.linkGroupKey === null ||
    core.baseRefName === null ||
    core.headRefName === null
  ) {
    return null;
  }
  return {
    epicId,
    linkGroupKey: core.linkGroupKey,
    repoIdentifier: core.repoIdentifier,
    repoRole: core.repoRole,
    baseRefName: core.baseRefName,
    headRefName: core.headRefName,
    headRefOid: core.headRefOid,
  };
}

/**
 * A PR's patch, read from the local checkout the branch was pushed from.
 *
 * GitHub's GraphQL changed-file list carries no patch text, so this is the
 * only source of a real diff in the PR view. It is an OPTIONAL host method: a
 * host predating it answers `E_HOST_UNSUPPORTED`, which surfaces here as an
 * ordinary query error and lets the Files tab fall back to the file list.
 *
 * `staleTime: Infinity` because the answer cannot change without the key
 * changing: both endpoints are commits, and a new push moves `headRefOid`,
 * which IS part of the key. The one thing that moves underneath it is the
 * local checkout itself (a rebase, a fetch), which is what the drift banner
 * and its refetch are for.
 *
 * The host is resolved INTERNALLY from `useTabHostId()` -> `useTabHostClient`,
 * the same way `usePrDetailSubscription` does it and for the same reason: a
 * tile is bound to its tab's host for life, which need not be the app-wide
 * active host. Taking a `hostId` argument alongside an app-wide client would
 * let the query key name one host while the request went to another.
 */
/**
 * The identity half of the local-diff query key, flattened off a target that
 * may not exist yet.
 *
 * A single `null` branch rather than a per-field `?? ""` chain: the fields
 * are only ever all-present or all-absent together (that is what
 * {@link prLocalDiffTarget} decides), so treating them independently would
 * both overstate the states this can be in and push the hook past its
 * complexity budget.
 */
function localDiffKeyParts(target: PrLocalDiffTarget | null): {
  readonly epicId: string;
  readonly linkGroupKey: string;
  readonly owner: string;
  readonly repo: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string | null;
} {
  if (target === null) {
    return {
      epicId: "",
      linkGroupKey: "",
      owner: "",
      repo: "",
      baseRefName: "",
      headRefName: "",
      headRefOid: null,
    };
  }
  return {
    epicId: target.epicId,
    linkGroupKey: target.linkGroupKey,
    owner: target.repoIdentifier.owner,
    repo: target.repoIdentifier.repo,
    baseRefName: target.baseRefName,
    headRefName: target.headRefName,
    headRefOid: target.headRefOid,
  };
}

export function usePrLocalDiffQuery(args: {
  readonly target: PrLocalDiffTarget | null;
  readonly ignoreWhitespace: boolean;
  readonly enabled: boolean;
}): UseQueryResult<PrGetLocalDiffResponse, HostRpcError> {
  const hostId = useTabHostId();
  const client = useTabHostClient();
  const { target } = args;
  const isEnabled = args.enabled && client !== null && target !== null;

  return useQuery({
    // `client` is correlated 1:1 with `hostId`, which the key already carries
    // through `hostQueryKeys.scope`; adding it would refetch on client
    // identity drift alone.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    ...queryOptions<PrGetLocalDiffResponse, HostRpcError>({
      queryKey: [
        ...prQueryKeys.localDiff({
          hostId,
          ...localDiffKeyParts(target),
          ignoreWhitespace: args.ignoreWhitespace,
        }),
      ],
      queryFn: () =>
        withHostQueryErrorBoundary("pr.getLocalDiff", async () => {
          if (client === null) {
            throw hostClientUnavailableError("pr.getLocalDiff");
          }
          if (target === null) {
            // Distinct from the client guard above: the query is disabled in
            // this state, so reaching here is defensive - but labelling it
            // "host client unavailable" would send a reader hunting a
            // transport fault that never happened.
            throw new Error(
              "pr.getLocalDiff: no local diff target on this PR frame",
            );
          }
          const request: PrGetLocalDiffRequest = {
            epicId: target.epicId,
            linkGroupKey: target.linkGroupKey,
            repoIdentifier: target.repoIdentifier,
            repoRole: target.repoRole,
            baseRefName: target.baseRefName,
            headRefName: target.headRefName,
            expectedHeadOid: target.headRefOid,
            ignoreWhitespace: args.ignoreWhitespace,
            byteBudget: DEFAULT_PR_LOCAL_DIFF_BYTE_BUDGET,
          };
          return client.request("pr.getLocalDiff", request);
        }),
      staleTime: Infinity,
      gcTime: 10 * 60 * 1000,
      // An older host has no such method and never will within this session;
      // retrying it just delays the fallback the tab is about to render.
      retry: false,
    }),
    enabled: isEnabled,
  });
}
