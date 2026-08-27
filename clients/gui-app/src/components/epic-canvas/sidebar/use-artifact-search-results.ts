/**
 * The artifact-search request, and everything that decides what a surface may
 * render from it.
 *
 * Kept apart from any one search UI because the subtleties here are not about
 * presentation and must not be re-derived per surface: which host is asked,
 * which filters compose into the request versus which are applied to the
 * response, when a previous result may still be shown, and how an unsupported
 * host is told apart from a failure. A second surface reimplementing this would
 * agree with the first only until one of them was edited.
 */
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  SearchArtifactHit,
  SearchArtifactsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useEpicStore } from "@/hooks/use-epic-store";
import {
  isArtifactUnread,
  useArtifactReadStateStore,
} from "@/stores/epics/artifact-read-state-store";
import {
  ARTIFACT_READ,
  useArtifactFilter,
} from "@/stores/epics/left-panel-store";
import { useEpicSearchArtifacts } from "@/hooks/epic/use-epic-search-artifacts-query";

const EMPTY_HITS: ReadonlyArray<SearchArtifactHit> = Object.freeze([]);

export interface ArtifactSearchResults {
  /** Whether a non-blank query is in flight or answered. */
  readonly searchActive: boolean;
  /** Hits after the renderer-only read filter. */
  readonly results: ReadonlyArray<SearchArtifactHit>;
  /** The response the results came from, for `truncated` / `outcome`. */
  readonly response: SearchArtifactsResponse | null;
  /** The host cannot answer `epic.searchArtifacts` at all. */
  readonly isUnsupported: boolean;
  /** A failure that is NOT the host lacking the capability. */
  readonly isError: boolean;
  readonly isFetching: boolean;
  readonly refetch: () => void;
}

export function useArtifactSearchResults(args: {
  readonly epicId: string;
  readonly debouncedQuery: string;
}): ArtifactSearchResults {
  const { epicId, debouncedQuery } = args;
  // BOTH from the Epic session, and that is the point - these two were once read
  // from two different sources (the ambient client, and the app-wide addressable
  // id beside it) and then used together: the id keys the scope signature AND
  // binds every opened hit's tile for life. So during a re-point - when the
  // panel stays interactive while only the canvas goes inert - this searched one
  // machine and opened the results as tiles bound to another. One source makes
  // them incapable of disagreeing.
  const client = useEpicSessionHostClient();
  const activeHostId = useEpicSessionHostId();
  const filter = useArtifactFilter(epicId);

  const searchActive = debouncedQuery.trim().length > 0;

  // Compose the kind/status filters into the host request; `read` is
  // renderer-only state applied to the response below. Empty axes stay `null`.
  const kinds = filter.kinds.length > 0 ? filter.kinds : null;
  const statuses = filter.statuses.length > 0 ? filter.statuses : null;

  const query = useEpicSearchArtifacts({
    client,
    epicId,
    query: debouncedQuery,
    kinds,
    statuses,
    subtreePath: null,
    enabled: searchActive,
  });

  // A response must never render for a scope it wasn't fetched in. The query key
  // already isolates late async responses per scope; this signature additionally
  // gates the same-scope retention below so a prior Epic / host / filter result
  // can't linger on-screen after the scope changes (only the query string
  // changing keeps the retained results).
  // `JSON.stringify`, not a delimiter join: the parts are ids and free-form
  // filter values, and any separator they could themselves contain lets two
  // different scopes produce one signature - which is exactly the collision
  // this guard exists to prevent.
  const scopeSignature = JSON.stringify([
    epicId,
    activeHostId ?? "",
    kinds === null ? [] : kinds,
    statuses === null ? [] : statuses,
  ]);

  // `useEpicSearchArtifacts` intentionally omits `keepPreviousData`, so
  // `query.data` is only ever the current key's result. Retain the last
  // *same-scope* success so the list doesn't blank between keystrokes, but drop
  // it the instant the scope changes. The setState-during-render idiom keeps
  // the retained value in sync without an effect and never leaks a prior scope.
  const [retained, setRetained] = useState<{
    readonly signature: string;
    readonly response: SearchArtifactsResponse;
  } | null>(null);
  if (
    query.isSuccess &&
    (retained === null ||
      retained.response !== query.data ||
      retained.signature !== scopeSignature)
  ) {
    setRetained({ signature: scopeSignature, response: query.data });
  }
  const sameScopeRetained =
    retained !== null && retained.signature === scopeSignature
      ? retained.response
      : null;
  const response: SearchArtifactsResponse | null = query.isSuccess
    ? query.data
    : sameScopeRetained;

  const isUnsupported = query.error?.code === "E_HOST_UNSUPPORTED";
  const isError = query.isError && !isUnsupported;

  // Read filter (renderer-only). Resolve each hit's authoritative `updatedAt`
  // from the open-Epic projection; a hit missing from the projection is stale
  // and cannot be classified, so it drops out whenever a read filter is active.
  const readFilter = filter.read;
  const artifactsById = useEpicStore((s) => s.artifacts.byId);
  const readState = useArtifactReadStateStore(
    useShallow((s) => ({
      seedAtByEpic: s.seedAtByEpic,
      lastSeenByArtifact: s.lastSeenByArtifact,
    })),
  );
  const results = useMemo<ReadonlyArray<SearchArtifactHit>>(() => {
    if (response === null) return EMPTY_HITS;
    if (readFilter === ARTIFACT_READ.All) return response.results;
    return response.results.filter((hit) => {
      if (!Object.hasOwn(artifactsById, hit.artifactId)) return false;
      const unread = isArtifactUnread({
        epicId,
        artifactId: hit.artifactId,
        updatedAt: artifactsById[hit.artifactId].updatedAt,
        seedAtByEpic: readState.seedAtByEpic,
        lastSeenByArtifact: readState.lastSeenByArtifact,
      });
      return readFilter === ARTIFACT_READ.Unread ? unread : !unread;
    });
  }, [response, readFilter, artifactsById, readState, epicId]);

  return {
    searchActive,
    results,
    response,
    isUnsupported,
    isError,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}

/**
 * The screen-reader status line for an artifact search, in one place so every
 * surface announces the same outcome. Silence while no query is active is
 * deliberate: an empty live region must not narrate a search nobody started.
 */
export function deriveArtifactSearchStatusMessage(args: {
  readonly searchActive: boolean;
  readonly isUnsupported: boolean;
  readonly isError: boolean;
  readonly response: SearchArtifactsResponse | null;
  readonly resultCount: number;
  readonly staleActive: boolean;
}): string {
  if (!args.searchActive) return "";
  if (args.isUnsupported)
    return "Artifact search isn't available on this host.";
  if (args.isError) return "Artifact search failed.";
  if (args.staleActive) return "That artifact no longer exists.";
  if (args.response === null) return "Searching artifacts…";
  if (args.response.outcome === "mirror-unavailable") {
    return "Artifact search isn't ready yet.";
  }
  if (args.resultCount === 0) {
    return args.response.truncated
      ? "No matches shown; more results exist beyond the search limit."
      : "No artifacts match your search.";
  }
  const base = `${args.resultCount} artifact ${
    args.resultCount === 1 ? "result" : "results"
  }.`;
  return args.response.truncated
    ? `${base} More are available; refine your search.`
    : base;
}
