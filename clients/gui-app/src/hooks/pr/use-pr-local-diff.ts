import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  PrDetailCore,
  PrGetLocalDiffRequest,
  PrGetLocalDiffResponse,
  PrGetLocalDiffSummaryRequest,
  PrGetLocalDiffSummaryResponseV11,
  PrGetLocalFileDiffRequestV11,
  PrGetLocalFileDiffResponse,
} from "@traycer/protocol/host/pr-schemas";
import { DEFAULT_PR_LOCAL_DIFF_BYTE_BUDGET } from "@traycer/protocol/host/pr-schemas";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { prQueryKeys } from "@/lib/query-keys/pr-query-keys";

/** Every field is nullable on the wire because a cache-only or never-swept PR renders from identity alone, so this narrowing is where "can we even ask?" gets decided ONCE, rather than at four separate call sites. */
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

/** Fields are all-present or all-absent together. Do not flatten with per-field empty strings. */
function localDiffKeyParts(target: PrLocalDiffTarget | null): {
  readonly epicId: string;
  readonly linkGroupKey: string;
  readonly owner: string;
  readonly repo: string;
  readonly repoRole: string;
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
      repoRole: "",
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
    repoRole: target.repoRole,
    baseRefName: target.baseRefName,
    headRefName: target.headRefName,
    headRefOid: target.headRefOid,
  };
}

/** Tab-host client, never an app-wide client plus hostId. staleTime Infinity; E_HOST_UNSUPPORTED is an ordinary query error. */
export function usePrLocalDiffQuery(args: {
  readonly target: PrLocalDiffTarget | null;
  readonly ignoreWhitespace: boolean;
  readonly enabled: boolean;
}): UseQueryResult<PrGetLocalDiffResponse, HostRpcError> {
  const hostId = useTabHostId();
  const client = useTabHostClient();
  // Issuing then caches a transport error under `staleTime: Infinity`, wedging the tile until a manual refresh - so gate on the same reactive readiness the bundle tile's file-diff hook uses.
  const readiness = useReactiveHostReadiness(client);
  const { target } = args;
  const isEnabled =
    args.enabled && client !== null && readiness.isReady && target !== null;

  return useQuery({
    // `client` is 1:1 with `hostId` already in the key; adding it would refetch on identity drift.
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
            // Distinct from the client guard above: the query is disabled in this state, so reaching here is defensive - but labelling it "host client unavailable" would send a reader hunting a transport fault that never happened.
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

/** Whether a query failed because the bound host predates the method - the one error the split diff view treats as an INSTRUCTION (fall back to the monolith) rather than a failure to surface. */
export function isHostUnsupportedError(error: HostRpcError | null): boolean {
  return error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED";
}

/** Call-and-degrade, not registry-gated. retry false; E_HOST_UNSUPPORTED falls back to the monolith. */
export function usePrLocalDiffSummaryQuery(args: {
  readonly target: PrLocalDiffTarget | null;
  readonly ignoreWhitespace: boolean;
  readonly enabled: boolean;
}): UseQueryResult<PrGetLocalDiffSummaryResponseV11, HostRpcError> {
  const hostId = useTabHostId();
  const client = useTabHostClient();
  // Issuing then caches a transport error under `staleTime: Infinity`, wedging the tile until a manual refresh - so gate on the same reactive readiness the bundle tile's file-diff hook uses.
  const readiness = useReactiveHostReadiness(client);
  const { target } = args;
  const isEnabled =
    args.enabled && client !== null && readiness.isReady && target !== null;

  return useQuery({
    // `client` is 1:1 with `hostId` already in the key; adding it would refetch on identity drift.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    ...queryOptions<PrGetLocalDiffSummaryResponseV11, HostRpcError>({
      queryKey: [
        ...prQueryKeys.localDiffSummary({
          hostId,
          ...localDiffKeyParts(target),
          ignoreWhitespace: args.ignoreWhitespace,
        }),
      ],
      queryFn: () =>
        withHostQueryErrorBoundary("pr.getLocalDiffSummary", async () => {
          if (client === null) {
            throw hostClientUnavailableError("pr.getLocalDiffSummary");
          }
          if (target === null) {
            throw new Error(
              "pr.getLocalDiffSummary: no local diff target on this PR frame",
            );
          }
          const request: PrGetLocalDiffSummaryRequest = {
            epicId: target.epicId,
            linkGroupKey: target.linkGroupKey,
            repoIdentifier: target.repoIdentifier,
            repoRole: target.repoRole,
            baseRefName: target.baseRefName,
            headRefName: target.headRefName,
            expectedHeadOid: target.headRefOid,
            ignoreWhitespace: args.ignoreWhitespace,
          };
          return client.request("pr.getLocalDiffSummary", request);
        }),
      // `staleTime: Infinity` is a FRESHNESS CONTRACT, not an immutability claim - deliberately the monolith's exact posture.
      staleTime: Infinity,
      gcTime: 10 * 60 * 1000,
      retry: false,
    }),
    enabled: isEnabled,
  });
}

/** Keyed by OID pair, never ref names. Invalidate unavailable on refresh/drift. Mount per visible expanded section. */
export function usePrLocalFileDiffQuery(args: {
  readonly target: PrLocalDiffTarget;
  readonly mergeBaseOid: string;
  readonly headOid: string;
  readonly path: string;
  readonly previousPath: string | null;
  /** The summary row's byte-path sidecars, forwarded VERBATIM per side (never derived client-side).
   * They are request identity: part of the query key and the wire request both, so two lossy-name-colliding files can never share a cache slot or an answer. */
  readonly pathBytes: string | null;
  readonly previousPathBytes: string | null;
  readonly ignoreWhitespace: boolean;
  readonly byteBudget: number | null;
  readonly enabled: boolean;
}): UseQueryResult<PrGetLocalFileDiffResponse, HostRpcError> {
  const hostId = useTabHostId();
  const client = useTabHostClient();
  // Same not-ready gate as the two range-level hooks above.
  const readiness = useReactiveHostReadiness(client);
  const { target } = args;
  const isEnabled = args.enabled && client !== null && readiness.isReady;

  return useQuery({
    // Same 1:1 `client`/`hostId` correlation note as the two hooks above.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    ...queryOptions<PrGetLocalFileDiffResponse, HostRpcError>({
      queryKey: [
        ...prQueryKeys.localFileDiff({
          hostId,
          epicId: target.epicId,
          linkGroupKey: target.linkGroupKey,
          owner: target.repoIdentifier.owner,
          repo: target.repoIdentifier.repo,
          repoRole: target.repoRole,
          mergeBaseOid: args.mergeBaseOid,
          headOid: args.headOid,
          path: args.path,
          previousPath: args.previousPath,
          pathBytes: args.pathBytes,
          previousPathBytes: args.previousPathBytes,
          ignoreWhitespace: args.ignoreWhitespace,
          byteBudget: args.byteBudget,
        }),
      ],
      queryFn: () =>
        withHostQueryErrorBoundary("pr.getLocalFileDiff", async () => {
          if (client === null) {
            throw hostClientUnavailableError("pr.getLocalFileDiff");
          }
          const request: PrGetLocalFileDiffRequestV11 = {
            epicId: target.epicId,
            linkGroupKey: target.linkGroupKey,
            repoIdentifier: target.repoIdentifier,
            repoRole: target.repoRole,
            mergeBaseOid: args.mergeBaseOid,
            headOid: args.headOid,
            path: args.path,
            previousPath: args.previousPath,
            pathBytes: args.pathBytes,
            previousPathBytes: args.previousPathBytes,
            ignoreWhitespace: args.ignoreWhitespace,
            byteBudget: args.byteBudget,
          };
          return client.request("pr.getLocalFileDiff", request);
        }),
      staleTime: Infinity,
      // Longer than the summary's: entries are OID-addressed and small, and a
      // reader scrolling back up should not re-pay for patches already seen.
      // Mirrors `useGitGetFileDiffQuery`.
      gcTime: 30 * 60 * 1000,
      // No `retry` override: the app default (one retry, with the transport- error carve-out) is fine for both transient failures and the rare `E_HOST_UNSUPPORTED` here - the latter answers in loopback time, so one extra attempt barely delays the section's fallback report.
    }),
    enabled: isEnabled,
  });
}
