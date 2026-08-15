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
  PrGetLocalDiffSummaryResponse,
  PrGetLocalFileDiffRequest,
  PrGetLocalFileDiffResponse,
} from "@traycer/protocol/host/pr-schemas";
import { DEFAULT_PR_LOCAL_DIFF_BYTE_BUDGET } from "@traycer/protocol/host/pr-schemas";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
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
export function usePrLocalDiffQuery(args: {
  readonly target: PrLocalDiffTarget | null;
  readonly ignoreWhitespace: boolean;
  readonly enabled: boolean;
}): UseQueryResult<PrGetLocalDiffResponse, HostRpcError> {
  const hostId = useTabHostId();
  const client = useTabHostClient();
  // A non-null tab client is NOT yet a usable one: during startup, sign-in
  // changes and reconnects it exists before its active host and request
  // context resolve. Issuing then caches a transport error under
  // `staleTime: Infinity`, wedging the tile until a manual refresh - so gate
  // on the same reactive readiness the bundle tile's file-diff hook uses.
  const readiness = useReactiveHostReadiness(client);
  const { target } = args;
  const isEnabled =
    args.enabled && client !== null && readiness.isReady && target !== null;

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

/**
 * Whether a query failed because the bound host predates the method - the
 * one error the split diff view treats as an INSTRUCTION (fall back to the
 * monolith) rather than a failure to surface.
 */
export function isHostUnsupportedError(error: HostRpcError | null): boolean {
  return error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED";
}

/**
 * The metadata frame of the split PR diff view: the resolved range (both
 * endpoint OIDs) and every file's name/status/counts, no patch text.
 *
 * This call doubles as the FEATURE DETECTION for the whole split surface -
 * call-and-degrade, not registry-gated. The negotiated-manifest registry
 * can't answer "does this host have the method?" from a fresh PR tile: it is
 * fail-closed (`null` until some unary handshake records), and the tile's
 * only guaranteed prior traffic is the `pr.subscribeDetail` STREAM, which
 * never records on the local transport - so a registry gate could sit at
 * "unknown" forever. Calling optimistically resolves it either way: success
 * renders the split view, `E_HOST_UNSUPPORTED` (see
 * {@link isHostUnsupportedError}) flips the tile to the monolith - and the
 * failed call's own handshake populates the registry as a side effect.
 *
 * Caching mirrors {@link usePrLocalDiffQuery}, including `retry: false`: on
 * an old host the first answer is definitive, and retrying only delays the
 * fallback.
 */
export function usePrLocalDiffSummaryQuery(args: {
  readonly target: PrLocalDiffTarget | null;
  readonly ignoreWhitespace: boolean;
  readonly enabled: boolean;
}): UseQueryResult<PrGetLocalDiffSummaryResponse, HostRpcError> {
  const hostId = useTabHostId();
  const client = useTabHostClient();
  // A non-null tab client is NOT yet a usable one: during startup, sign-in
  // changes and reconnects it exists before its active host and request
  // context resolve. Issuing then caches a transport error under
  // `staleTime: Infinity`, wedging the tile until a manual refresh - so gate
  // on the same reactive readiness the bundle tile's file-diff hook uses.
  const readiness = useReactiveHostReadiness(client);
  const { target } = args;
  const isEnabled =
    args.enabled && client !== null && readiness.isReady && target !== null;

  return useQuery({
    // `client` is correlated 1:1 with `hostId`, which the key already carries
    // through `hostQueryKeys.scope`; adding it would refetch on client
    // identity drift alone.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    ...queryOptions<PrGetLocalDiffSummaryResponse, HostRpcError>({
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
      // `staleTime: Infinity` is a FRESHNESS CONTRACT, not an immutability
      // claim - deliberately the monolith's exact posture. The key moves when
      // GitHub's tip moves (`headRefOid` from the detail stream); everything
      // that can drift underneath it - the local checkout rebasing, a base
      // fetch landing - is surfaced by the drift banner and re-read by the
      // toolbar refresh and the tile's bounded drift recovery, both of which
      // call `refetch` and so ignore staleness anyway. A background cadence
      // would re-run git sweeps for answers nothing on screen asked to move.
      staleTime: Infinity,
      gcTime: 10 * 60 * 1000,
      retry: false,
    }),
    enabled: isEnabled,
  });
}

/**
 * One file's patch out of a summary-resolved range.
 *
 * Addressed by the summary's OID pair, never by ref names: a `kind: "diff"`
 * answer is immutable for its key, so `staleTime: Infinity` is a fact rather
 * than a heuristic, and a checkout that moves mid-scroll keeps serving the
 * old range while the drift banner does its job. An `unavailable` answer is
 * the one non-immutable case - it describes repo STATE, not the OID pair's
 * content - and the tile clears those explicitly by invalidating
 * `prQueryKeys.localFileDiffScope` on refresh and on drift recovery.
 * Mounted per VISIBLE, expanded, non-placeholder section - row-mount gating
 * is what keeps a 200-file PR at a handful of in-flight requests.
 *
 * `byteBudget: null` is the "Load Full" ask; it re-keys the query, exactly
 * like the git bundle row's load-full.
 */
export function usePrLocalFileDiffQuery(args: {
  readonly target: PrLocalDiffTarget;
  readonly mergeBaseOid: string;
  readonly headOid: string;
  readonly path: string;
  readonly previousPath: string | null;
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
          ignoreWhitespace: args.ignoreWhitespace,
          byteBudget: args.byteBudget,
        }),
      ],
      queryFn: () =>
        withHostQueryErrorBoundary("pr.getLocalFileDiff", async () => {
          if (client === null) {
            throw hostClientUnavailableError("pr.getLocalFileDiff");
          }
          const request: PrGetLocalFileDiffRequest = {
            epicId: target.epicId,
            linkGroupKey: target.linkGroupKey,
            repoIdentifier: target.repoIdentifier,
            repoRole: target.repoRole,
            mergeBaseOid: args.mergeBaseOid,
            headOid: args.headOid,
            path: args.path,
            previousPath: args.previousPath,
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
      // No `retry` override: the app default (one retry, with the transport-
      // error carve-out) is fine for both transient failures and the rare
      // `E_HOST_UNSUPPORTED` here - the latter answers in loopback time, so
      // one extra attempt barely delays the section's fallback report.
    }),
    enabled: isEnabled,
  });
}
