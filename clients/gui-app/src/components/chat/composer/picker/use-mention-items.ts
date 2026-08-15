import { useCallback, useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";

import { useEpicMentionEntries } from "@/hooks/composer/use-epic-mention-entries";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useWorkspaceEntries } from "@/hooks/composer/use-workspace-entries";
import { useWorktreeListBindingsForEpicForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import type { HostRpcRegistry } from "@/lib/host";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  ChatProjection,
  ChatsSlice,
  TerminalAgentsSlice,
  TuiAgentProjection,
} from "@/stores/epics/open-epic/types";
import { isSubsequence } from "@traycer/protocol/utils/text/fuzzy";
import { canParticipateInA2A } from "@traycer/protocol/host/agent/shared";
import type { EpicMentionArtifactSuggestion } from "@traycer/protocol/host/epic/unary-schemas";
import {
  epicArtifactMentionId,
  epicArtifactMentionToken,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  EMPTY_GITHUB_SECTION_CONTEXT,
  githubMentionCategoryAvailable,
  isArtifactMentionStep,
  mentionProviderRegistry,
  parseGithubReferenceQuery,
  ROOT_MENTION_STEP,
  type ComposerMentionProviderContext,
  type MentionEpicRequest,
  type MentionFlowStep,
  type MentionStepChrome,
  type MentionStepEntries,
  type MentionWorkspaceRequest,
} from "@/lib/composer/mentions";
import { shouldCloseMentionForNoMatches } from "@/lib/composer/mentions/mention-dismissal";
import { useGithubMentionSections } from "./use-github-mention-sections";
import { buildEpicMentionSuggestionsFromTasks } from "@/lib/composer/mentions/local-epic-suggestions";
import { taskMentionTitleFromRawTitle } from "@/lib/composer/mentions/task-mention-helpers";
import { displayTitle } from "@/lib/display-title";
import type {
  EpicAgentMentionEntry,
  EpicChatMentionEntry,
  EpicMentionEntry,
  EpicTerminalAgentMentionEntry,
  EpicTerminalMentionEntry,
  WorkspaceEntry,
} from "@/lib/composer/types";
import { useTerminalListFor } from "@/hooks/terminal/use-terminal-list-for-query";
import { isVisibleEpicTerminalSession } from "@/lib/terminals/terminal-session-filters";
import { terminalSessionLabel } from "@/lib/terminals/terminal-title";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";

import type {
  ComposerPickerItem,
  ComposerPickerStore,
} from "./composer-picker-store";

const MENTION_RESULT_LIMIT = 25;
const MENTION_QUERY_DEBOUNCE_MS = 250;
// Artifacts answer from local epic state behind a cloud list; a refetch that
// has not settled in ten seconds is not going to.
const ARTIFACT_REFRESH_TIMEOUT_MS = 10_000;
const EMPTY_WORKSPACE_REQUESTS: ReadonlyArray<MentionWorkspaceRequest> = [];
const EMPTY_EPIC_REQUESTS: ReadonlyArray<MentionEpicRequest> = [];
const EMPTY_WORKSPACE_ENTRIES: ReadonlyArray<WorkspaceEntry> = [];
const EMPTY_EPIC_ENTRIES: ReadonlyArray<EpicMentionEntry> = [];
const EMPTY_STEP_ENTRIES: MentionStepEntries = {
  entries: [],
  matchedCount: null,
};

export interface UseMentionItemsParams {
  readonly pickerStore: ComposerPickerStore;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly mentionRoots: ReadonlyArray<string>;
  readonly currentEpicId: string | null;
}

interface MentionPickerSlice {
  readonly active: boolean;
  readonly sessionId: number | null;
  readonly query: string;
  readonly step: MentionFlowStep;
}

function selectMentionSlice(state: {
  open: boolean;
  sessionId: number | null;
  kind: "mention" | "slash" | null;
  query: string;
  step: MentionFlowStep;
}): MentionPickerSlice {
  return {
    active: state.open && state.kind === "mention",
    // Watched so a swap to a session with an identical query and step still
    // republishes the rows `openPicker` just dropped. See the slash picker's
    // slice for the swap this guards.
    sessionId: state.kind === "mention" ? state.sessionId : null,
    query: state.kind === "mention" ? state.query : "",
    step: state.kind === "mention" ? state.step : ROOT_MENTION_STEP,
  };
}

export function useMentionItems(params: UseMentionItemsParams): void {
  const { pickerStore, hostClient, mentionRoots, currentEpicId } = params;

  const slice = useStore(pickerStore, useShallow(selectMentionSlice));
  const { active, sessionId, query, step } = slice;
  const debouncedQuery = useDebouncedValue(query, MENTION_QUERY_DEBOUNCE_MS);

  // The @-mention Agent list is the ONLY consumer of the open-epic chat and
  // TUI-agent records, and only while the picker is open. Source it HERE, gated
  // on `active`, rather than threading it as an eager prop from the chat tile: a
  // record's `updatedAt` bumps on every streaming-throttle tick (~80ms), which
  // re-identified the records array and re-rendered the whole composer + its
  // Radix chrome. Reading live via `getState` at query time keeps the recency
  // sort accurate without subscribing the composer to that churn.
  // `handle === null` is the landing composer (no open epic).
  // The Epic's attached roots (binding running dirs + workspace paths on this
  // host) drive which mention roots are eligible for the scoped
  // `workspace.searchPaths`; anything not in this set (global folders, or every
  // root when there is no open Epic) keeps the legacy raw-root RPC. Gated on the
  // picker being open with a current Epic so a closed composer holds no
  // bindings subscription.
  const epicIdOrEmpty = currentEpicId ?? "";
  const bindingsQuery = useWorktreeListBindingsForEpicForClient({
    client: hostClient,
    epicId: epicIdOrEmpty,
    enabled: active && currentEpicId !== null,
  });
  const epicAttachedRoots = useMemo<ReadonlySet<string>>(() => {
    const rows = bindingsQuery.data?.rows ?? [];
    if (rows.length === 0) return EMPTY_ATTACHED_ROOTS;
    return new Set(rows.flatMap((row) => [row.runningDir, row.workspacePath]));
  }, [bindingsQuery.data?.rows]);
  const handle = useMaybeOpenEpicHandle();
  const epicAgentEntries = useMemo<ReadonlyArray<EpicAgentMentionEntry>>(() => {
    if (!active || handle === null || currentEpicId === null) {
      return EMPTY_AGENT_ENTRIES;
    }
    const state = handle.store.getState();
    return epicAgentMentionEntriesFromEpic(
      state.chats,
      state.tuiAgents,
      currentEpicId,
      state.epic.title,
    );
    // Snapshot the Agent list when the picker opens (`active` flips). The query
    // filters this list downstream, so it does not need to re-pull per keystroke;
    // the list only changes if an Agent is added/removed while the picker is
    // open, which re-snapshots on the next open.
  }, [active, handle, currentEpicId]);

  // Plain terminals are the one Task entity that never reaches the Y.Doc - the
  // host's `terminal.list` is their source of truth - so unlike the Agent and
  // artifact lists above this one cannot be read off the open-epic store. It
  // goes through the SAME query the Terminals panel uses, which means the two
  // surfaces share one cache entry and can never disagree about what exists.
  // A null client is `useTerminalListFor`'s disable switch, so a closed picker
  // (or a composer with no open Task) holds no terminal subscription at all.
  // "Requested" mirrors the query's real enable condition, including the
  // client: with no hostClient the query is disabled and no rows are ever
  // coming, so the zero-match verdict must not wait on it (a disabled query
  // pends forever - gating on isPending would pin the menu open offline).
  const terminalsRequested =
    active && currentEpicId !== null && hostClient !== null;
  const terminalListQuery = useTerminalListFor(
    terminalsRequested ? hostClient : null,
    { kind: "epic", epicId: epicIdOrEmpty },
  );
  const terminalSessions = terminalListQuery.data?.sessions;
  const epicTerminalEntries = useMemo<
    ReadonlyArray<EpicTerminalMentionEntry>
  >(() => {
    if (terminalSessions === undefined || currentEpicId === null) {
      return EMPTY_TERMINAL_ENTRIES;
    }
    return epicTerminalMentionEntriesFromSessions(
      terminalSessions,
      currentEpicId,
    );
  }, [terminalSessions, currentEpicId]);

  // The current epic's COMPLETE local artifact set, read the same churn-free way
  // (via `getState`) as the chats above. Cloud `epic.mention*` returns at most
  // 25 artifacts per kind across all epics, so on a large epic some of the
  // current epic's artifacts never make the cut; merging the local set in
  // (see `enrichedArtifactEntries`) guarantees the user always sees every
  // artifact of the epic they're working in. Unlike chats, the artifact mention
  // providers don't query-filter downstream, so filter by the (debounced) query
  // here to stay consistent with the cloud list.
  const localArtifactEntries = useMemo<
    ReadonlyArray<EpicMentionArtifactSuggestion>
  >(() => {
    if (!active || handle === null || currentEpicId === null) {
      return EMPTY_ARTIFACT_ENTRIES;
    }
    const state = handle.store.getState();
    return buildCurrentEpicArtifactMentionEntries(
      state.artifacts,
      currentEpicId,
      state.epic.title,
      debouncedQuery,
    );
  }, [active, handle, currentEpicId, debouncedQuery]);

  // Gated on `active`: while the picker is closed this composer holds no
  // tasks-cache subscription at all, so background cache ticks can't recompute
  // the enrichment memos below (which would mint fresh array identities even
  // when nothing is shown).
  const { tasks: cachedEpicTasks } = useCloudEpicTasksQuery(undefined, {
    enabled: active,
  });
  const localEpicSuggestions = useMemo(
    () =>
      active
        ? buildEpicMentionSuggestionsFromTasks(
            cachedEpicTasks,
            debouncedQuery,
            MENTION_RESULT_LIMIT,
          )
        : EMPTY_EPIC_ENTRIES,
    [active, cachedEpicTasks, debouncedQuery],
  );

  // PR/issue rows for whichever step is open, plus that step's chrome. Both
  // sections are read cache-only at root so root search has warm rows without
  // a GitHub call per keystroke; only an opened section fetches.
  const github = useGithubMentionSections({
    client: hostClient,
    active,
    step,
    currentEpicId,
    mentionRoots,
    query,
    debouncedQuery,
    limit: MENTION_RESULT_LIMIT,
  });

  // Request-shaping contexts carry no rows; the GitHub arm is only read by
  // `stepEntries`/`rootSearchEntries`, which run off `resolvedContext` below.
  // The request contexts drive host lookups, never the rendered rows, so this
  // stub reports `supported: false` - it is not an answer about the host, and
  // nothing should read a category's availability off it.
  const emptyGithubContext = useMemo(
    () => ({
      pullRequests: EMPTY_GITHUB_SECTION_CONTEXT,
      issues: EMPTY_GITHUB_SECTION_CONTEXT,
      supported: false,
      now: 0,
    }),
    [],
  );

  // Live `query` drives the picker shell + workspace requests so file/folder
  // results feel immediate; cloud-backed artifact requests use the debounced
  // query so each keystroke doesn't fan out an `epic.mention*` RPC per provider.
  const requestContext = useMemo<ComposerMentionProviderContext>(
    () => ({
      roots: mentionRoots,
      query,
      limit: MENTION_RESULT_LIMIT,
      workspaceEntries: EMPTY_WORKSPACE_ENTRIES,
      epicEntries: EMPTY_EPIC_ENTRIES,
      currentEpicId,
      agentEntries: EMPTY_AGENT_ENTRIES,
      terminalEntries: EMPTY_TERMINAL_ENTRIES,
      epicAttachedRoots,
      github: emptyGithubContext,
    }),
    [currentEpicId, emptyGithubContext, epicAttachedRoots, mentionRoots, query],
  );

  const debouncedRequestContext = useMemo<ComposerMentionProviderContext>(
    () => ({
      roots: mentionRoots,
      query: debouncedQuery,
      limit: MENTION_RESULT_LIMIT,
      workspaceEntries: EMPTY_WORKSPACE_ENTRIES,
      epicEntries: EMPTY_EPIC_ENTRIES,
      currentEpicId,
      agentEntries: EMPTY_AGENT_ENTRIES,
      terminalEntries: EMPTY_TERMINAL_ENTRIES,
      epicAttachedRoots,
      github: emptyGithubContext,
    }),
    [
      currentEpicId,
      debouncedQuery,
      emptyGithubContext,
      epicAttachedRoots,
      mentionRoots,
    ],
  );

  const workspaceRequests = useMemo<ReadonlyArray<MentionWorkspaceRequest>>(
    () =>
      active
        ? mentionProviderRegistry.workspaceRequests(step, requestContext)
        : EMPTY_WORKSPACE_REQUESTS,
    [active, requestContext, step],
  );

  const epicRequests = useMemo<ReadonlyArray<MentionEpicRequest>>(
    () =>
      active
        ? mentionProviderRegistry.epicRequests(step, debouncedRequestContext)
        : EMPTY_EPIC_REQUESTS,
    [active, debouncedRequestContext, step],
  );

  const {
    data: workspaceEntries,
    isLoading: workspaceLoading,
    isFetching: workspaceFetching,
    error: workspaceError,
  } = useWorkspaceEntries({ requests: workspaceRequests, client: hostClient });
  const {
    data: remoteEpicEntries,
    isLoading: epicLoading,
    isFetching: epicFetching,
    error: epicError,
    refetch: refetchEpicMentions,
  } = useEpicMentionEntries({
    requests: epicRequests,
    client: hostClient,
  });
  const epicTitleByIdFromCache = useMemo(() => {
    if (cachedEpicTasks.length === 0) return EMPTY_TITLE_MAP;
    const titles = new Map<string, string>();
    for (const task of cachedEpicTasks) {
      const light = task.epic?.light;
      if (light === null || light === undefined) continue;
      titles.set(light.id, light.title);
    }
    return titles;
  }, [cachedEpicTasks]);
  const enrichedRemoteEpicEntries = useMemo<
    ReadonlyArray<EpicMentionEntry>
  >(() => {
    const enrichedCloud = remoteEpicEntries.map((entry) => {
      const normalizedEntry = normalizeTaskMentionEntry(entry);
      if (normalizedEntry.kind !== "epic-artifact") return normalizedEntry;
      const cachedTitle = epicTitleByIdFromCache.get(entry.epicId);
      if (cachedTitle === undefined) return normalizedEntry;
      const epicTitle = taskMentionTitle(cachedTitle);
      if (normalizedEntry.epicTitle === epicTitle) return normalizedEntry;
      return {
        ...normalizedEntry,
        epicTitle,
        description:
          normalizedEntry.description === normalizedEntry.epicTitle
            ? epicTitle
            : normalizedEntry.description,
      };
    });
    if (currentEpicId === null) {
      return enrichedCloud.length === 0 ? EMPTY_EPIC_ENTRIES : enrichedCloud;
    }
    const merged = mergeCurrentEpicArtifactMentions(
      localArtifactEntries,
      enrichedCloud,
      currentEpicId,
    );
    return merged.length === 0 ? EMPTY_EPIC_ENTRIES : merged;
  }, [
    remoteEpicEntries,
    epicTitleByIdFromCache,
    currentEpicId,
    localArtifactEntries,
  ]);
  const epicEntries = useMemo<ReadonlyArray<EpicMentionEntry>>(() => {
    return mergeTaskAndArtifactMentionEntries(
      localEpicSuggestions,
      enrichedRemoteEpicEntries,
    );
  }, [enrichedRemoteEpicEntries, localEpicSuggestions]);

  const resolvedContext = useMemo<ComposerMentionProviderContext>(
    () => ({
      roots: mentionRoots,
      query,
      limit: MENTION_RESULT_LIMIT,
      workspaceEntries:
        workspaceRequests.length > 0
          ? workspaceEntries
          : EMPTY_WORKSPACE_ENTRIES,
      epicEntries: epicRequests.length > 0 ? epicEntries : EMPTY_EPIC_ENTRIES,
      currentEpicId,
      agentEntries: epicAgentEntries,
      terminalEntries: epicTerminalEntries,
      epicAttachedRoots,
      github: github.context,
    }),
    [
      currentEpicId,
      epicAgentEntries,
      epicTerminalEntries,
      epicAttachedRoots,
      epicEntries,
      epicRequests.length,
      github.context,
      mentionRoots,
      query,
      workspaceEntries,
      workspaceRequests.length,
    ],
  );

  const stepEntries = useMemo<MentionStepEntries>(
    () =>
      active
        ? mentionProviderRegistry.entriesWithMatches(step, resolvedContext)
        : EMPTY_STEP_ENTRIES,
    [active, resolvedContext, step],
  );
  const entries = stepEntries.entries;

  const items = useMemo<ReadonlyArray<ComposerPickerItem>>(
    () =>
      entries.map((entry) => ({
        id: entry.id,
        kind: "mention",
        entry,
      })),
    [entries],
  );

  // A source counts only when it was actually asked for rows: an idle query's
  // flags say nothing about a step that never requested it.
  const loading =
    active &&
    anySourcePending({
      workspaceRequested: workspaceRequests.length > 0,
      workspacePending: workspaceLoading,
      epicRequested: epicRequests.length > 0,
      epicPending: epicLoading,
      githubPending: github.loading,
    });

  const fetching =
    active &&
    anySourcePending({
      workspaceRequested: workspaceRequests.length > 0,
      workspacePending: workspaceFetching,
      epicRequested: epicRequests.length > 0,
      epicPending: epicFetching,
      // Core flows asks for the header spinner AND the `Checking…` stamp during
      // a background refetch, explicitly "same as Artifacts" - so the GitHub
      // sections drive it too. They sit in the same menu as the section that
      // does; reporting in-flight work differently there would read as one of
      // them being broken.
      githubPending: github.checking,
    });

  const readiness = useReactiveHostReadiness(hostClient);
  const stepChrome = useMentionStepChrome({
    active,
    step,
    githubChrome: github.chrome,
    artifactRefetch: refetchEpicMentions,
    artifactFetching: epicFetching,
    hostId: readiness.hostId,
    epicId: epicIdOrEmpty,
  });

  useEffect(() => {
    if (!active || sessionId === null) return;
    pickerStore
      .getState()
      .setStepChrome({ sessionId, step, chrome: stepChrome });
  }, [active, pickerStore, sessionId, step, stepChrome]);

  useEffect(() => {
    if (!active || sessionId === null) return;
    pickerStore.getState().setItems({
      sessionId,
      kind: "mention",
      query,
      // Mentions have no scope; the store holds null for a mention picker, so
      // this matches its guard rather than opting out of it.
      slashScope: null,
      step,
      items,
      loading,
      // Mention providers keep their existing empty-on-failure behavior; only
      // the slash catalog reports load failures into the picker for now.
      loadFailed: false,
      retryLoad: null,
    });
  }, [active, items, loading, pickerStore, query, sessionId, step]);

  useEffect(() => {
    if (!active) return;
    pickerStore.getState().setFetching(fetching);
  }, [active, fetching, pickerStore]);

  // Zero-real-match dismissal: once every source has settled for the CURRENT
  // query (debounce flushed, nothing loading or refetching) and the ranked
  // root search matched nothing, the menu closes the way Escape would.
  // Session-scoped close, so a session that already yielded cannot shut its
  // successor's menu.
  const dismissForNoMatches = mentionNoMatchDismissVerdict({
    active,
    stepKind: step.kind,
    query,
    debouncedQuery,
    matchedCount: stepEntries.matchedCount,
    loading,
    fetching,
    workspaceRequestCount: workspaceRequests.length,
    workspaceError,
    epicRequestCount: epicRequests.length,
    epicError,
    // The terminal list feeds root-search entries but lives outside the
    // aggregated loading/fetching flags above (those cover only the
    // query-driven workspace/epic requests) - so its state gates the
    // zero-match verdict separately.
    terminalRequested: terminalsRequested,
    terminalLoading: terminalListQuery.isLoading,
    terminalFetching: terminalListQuery.isFetching,
    terminalError: terminalListQuery.error,
    githubErrored: github.errored,
    // Only a reference the GitHub sections could actually resolve earns the
    // exemption. The exemption exists because those sections offer a
    // `Resolve in ...` row for a reference the cache does not hold - but when
    // the category is unavailable, neither section contributes any row at
    // all. Exempting `@#123` there suppresses the ordinary zero-match close
    // over a picker that is genuinely empty and can never fill, and it stays
    // open indefinitely. Availability is the provider's OWN predicate, not a
    // restated copy of it, so a new availability term cannot strand this gate.
    referenceQuery:
      githubMentionCategoryAvailable(
        github.context.supported,
        mentionRoots.length,
      ) && parseGithubReferenceQuery(query) !== null,
  });

  useEffect(() => {
    if (!dismissForNoMatches || sessionId === null) return;
    const state = pickerStore.getState();
    // A stale effect must never fire the CURRENT session's dismiss handle:
    // this verdict was computed for `sessionId`, but the store may already
    // belong to a successor session by the time the effect runs.
    if (state.sessionId !== sessionId) return;
    // Prefer the session's dismissal handle: it also ends the tiptap
    // suggestion session, so the zero-match close cannot leak into the next
    // `@` occurrence. Bare `closeSession` is the fallback for owners that
    // registered no handle.
    if (state.dismiss !== null) {
      state.dismiss();
      return;
    }
    state.closeSession(sessionId);
  }, [dismissForNoMatches, pickerStore, sessionId]);
}

interface SourcePendingInput {
  readonly workspaceRequested: boolean;
  readonly workspacePending: boolean;
  readonly epicRequested: boolean;
  readonly epicPending: boolean;
  readonly githubPending: boolean;
}

function anySourcePending(input: SourcePendingInput): boolean {
  return (
    (input.workspaceRequested && input.workspacePending) ||
    (input.epicRequested && input.epicPending) ||
    input.githubPending
  );
}

interface MentionStepChromeInput {
  readonly active: boolean;
  readonly step: MentionFlowStep;
  readonly githubChrome: MentionStepChrome | null;
  readonly artifactRefetch: () => Promise<void>;
  readonly artifactFetching: boolean;
  /**
   * The bound host, part of the refresh button's target identity beside the
   * epic. The landing composer's `epicId` is empty on EVERY host, so without
   * the host in the key an app-wide host swap mid-refresh keeps the same
   * control mounted - its component-local spinner then holds the NEW host's
   * Refresh disabled until the DEPARTED host's promise settles or times out.
   */
  readonly hostId: string | null;
  /** Artifacts are per-epic, so the epic is this refresh button's target. */
  readonly epicId: string;
}

/**
 * The chrome the CURRENT step publishes.
 *
 * The GitHub sections bring their own; Artifacts contributes only a refresh,
 * and this is where the long-standing no-op is fixed. The button used to call
 * `setStep` with the step it was already on, which the picker store
 * early-returns from - so it spun for its 350ms minimum and refetched nothing.
 * It now calls the `epic.mention*` queries' real `refetch`, which was exposed
 * all along and never called.
 */
function useMentionStepChrome(
  input: MentionStepChromeInput,
): MentionStepChrome | null {
  const {
    active,
    step,
    githubChrome,
    artifactRefetch,
    artifactFetching,
    hostId,
    epicId,
  } = input;
  // `refetch` is rebuilt every render (it closes over the current query array),
  // so publishing it directly would change the chrome's identity on every pass
  // and republish forever. The ref holds ONE stable closure over the latest.
  const artifactRefetchRef = useRef(artifactRefetch);
  useEffect(() => {
    artifactRefetchRef.current = artifactRefetch;
  }, [artifactRefetch]);
  const refreshArtifacts = useCallback(() => artifactRefetchRef.current(), []);

  return useMemo<MentionStepChrome | null>(() => {
    if (!active) return null;
    if (githubChrome !== null) return githubChrome;
    if (!isArtifactMentionStep(step)) return null;
    return {
      refresh: {
        onRefresh: refreshArtifacts,
        refreshing: artifactFetching,
        label: "Refresh artifacts",
        timeoutMs: ARTIFACT_REFRESH_TIMEOUT_MS,
        // Answered BY the bound host FOR the current epic, so both name the
        // target - same identity rule as the GitHub sections' key, whose
        // `scopeKey` already carries the host. See `hostId` above for the
        // landing-composer swap this remounts across.
        targetKey: artifactsRefreshTargetKey(hostId, epicId),
      },
      freshness: null,
      notice: null,
      filter: null,
      banner: null,
      appendedStatus: null,
      emptyLabel: null,
    };
  }, [
    active,
    artifactFetching,
    epicId,
    githubChrome,
    hostId,
    refreshArtifacts,
    step,
  ]);
}

/**
 * The artifact refresh button's remount identity: host AND epic. The two
 * landing composers of two hosts share the empty epic, so an epic-only key
 * survives an app-wide host swap and strands the new host's control behind
 * the departed host's in-flight spinner.
 */
export function artifactsRefreshTargetKey(
  hostId: string | null,
  epicId: string,
): string {
  return `artifacts\x1f${hostId ?? ""}\x1f${epicId}`;
}

interface MentionNoMatchVerdictInput {
  readonly active: boolean;
  readonly stepKind: "root" | "provider";
  readonly query: string;
  readonly debouncedQuery: string;
  readonly matchedCount: number | null;
  readonly loading: boolean;
  readonly fetching: boolean;
  readonly workspaceRequestCount: number;
  readonly workspaceError: Error | null;
  readonly epicRequestCount: number;
  readonly epicError: Error | null;
  readonly terminalRequested: boolean;
  readonly terminalLoading: boolean;
  readonly terminalFetching: boolean;
  readonly terminalError: Error | null;
  /**
   * Already requested-gated at the source: each catalog reports an error only
   * while its own read is enabled, so there is no separate request count to
   * pair it with here.
   */
  readonly githubErrored: boolean;
  readonly referenceQuery: boolean;
}

/**
 * Whether the open mention picker should close because a fully settled search
 * genuinely matched nothing. A source is "errored" only when it was actually
 * asked for rows (request count > 0, or the terminal list enabled) — a failed
 * search proves nothing empty, so it blocks this close and only this close.
 * The terminal list is folded into the settled/errored aggregates here: its
 * rows feed root search, so a still-loading or failed terminal query must
 * hold the menu open exactly like the workspace and epic sources do.
 */
export function mentionNoMatchDismissVerdict(
  input: MentionNoMatchVerdictInput,
): boolean {
  const sourcesErrored =
    (input.workspaceRequestCount > 0 && input.workspaceError !== null) ||
    (input.epicRequestCount > 0 && input.epicError !== null) ||
    (input.terminalRequested && input.terminalError !== null) ||
    input.githubErrored;
  const terminalPending =
    input.terminalRequested &&
    (input.terminalLoading || input.terminalFetching);
  return (
    input.active &&
    shouldCloseMentionForNoMatches({
      stepKind: input.stepKind,
      query: input.query,
      debouncedQuery: input.debouncedQuery,
      matchedCount: input.matchedCount,
      loading: input.loading || terminalPending,
      fetching: input.fetching,
      sourcesErrored,
      referenceQuery: input.referenceQuery,
    })
  );
}

const EMPTY_AGENT_ENTRIES: ReadonlyArray<EpicAgentMentionEntry> = [];
const EMPTY_TERMINAL_ENTRIES: ReadonlyArray<EpicTerminalMentionEntry> = [];
const EMPTY_ATTACHED_ROOTS: ReadonlySet<string> = new Set();
const EMPTY_ARTIFACT_ENTRIES: ReadonlyArray<EpicMentionArtifactSuggestion> = [];
const EMPTY_TITLE_MAP: ReadonlyMap<string, string> = new Map();

function buildChatMentionEntry(
  chat: ChatProjection,
  epicId: string,
  epicTitle: string,
): EpicChatMentionEntry {
  return {
    kind: "epic-chat",
    id: `chat:${epicId}:${chat.id}`,
    token: `chat:${epicId}/${chat.id}`,
    epicId,
    epicTitle,
    chatId: chat.id,
    // The picker addresses the durable Agent, so an untitled record falls back
    // to "Untitled agent" regardless of interface. A record whose stored title
    // literally reads "Untitled chat" keeps that text - it is data, not a
    // fallback, and is indistinguishable from a title the user chose.
    label: displayTitle(chat.title, "agent"),
    description: epicTitle,
    parentId: chat.parentId,
    updatedAt: chat.updatedAt,
    archived: chat.archivedAt !== null,
    agentInterface: "chat",
    // Every GUI-backed Agent's runtime supports A2A (provider-native via the
    // MCP bridge) - mirrors `canParticipateInA2A`'s `surface === "gui"` arm.
    runtimeSupportsMessageDelivery: true,
  };
}

function buildTerminalAgentMentionEntry(
  agent: TuiAgentProjection,
  epicId: string,
  epicTitle: string,
): EpicTerminalAgentMentionEntry {
  return {
    kind: "epic-terminal-agent",
    id: `terminal-agent:${epicId}:${agent.id}`,
    token: `terminal-agent:${epicId}/${agent.id}`,
    epicId,
    epicTitle,
    terminalAgentId: agent.id,
    harnessId: agent.harnessId,
    // Same interface-agnostic fallback as the chat arm. Harness identity stays
    // secondary metadata rather than becoming the Agent's title fallback.
    label: displayTitle(agent.title, "agent"),
    description: epicTitle,
    parentId: agent.parentId,
    updatedAt: agent.updatedAt,
    archived: agent.archivedAt !== null,
    agentInterface: "terminal",
    // Delivery support is a runtime capability, not a referenceability gate:
    // Codex and OpenCode Terminal Agents stay listed with `false` here rather
    // than being filtered out. Single-sourced from the protocol's A2A gate.
    runtimeSupportsMessageDelivery: canParticipateInA2A({
      surface: "tui",
      harnessId: agent.harnessId,
    }),
  };
}

/**
 * Pure projection of the open-epic Agent records - GUI chat-interface Agents
 * AND TUI terminal-interface Agents - into one @-mention suggestion list.
 * Extracted so the picker can source the list live at query time (see
 * `useMentionItems`) instead of having it threaded in as an eager prop - which
 * re-rendered the whole composer on every streaming `updatedAt` bump.
 *
 * Every projected record is referenceable. Interface and message-delivery
 * capability ride along as secondary metadata so the picker can label a row
 * without dropping it. The one exclusion is Cursor: it is GUI-only in the
 * product today, so a persisted Cursor TUI record (a reserved compatibility
 * value in the released schema) must not surface as a referenceable Terminal
 * Agent until minimal Cursor TUI support ships.
 */
export function epicAgentMentionEntriesFromEpic(
  chats: ChatsSlice,
  tuiAgents: TerminalAgentsSlice,
  epicId: string,
  rawEpicTitle: string,
): ReadonlyArray<EpicAgentMentionEntry> {
  if (chats.allIds.length === 0 && tuiAgents.allIds.length === 0) {
    return EMPTY_AGENT_ENTRIES;
  }
  const epicTitle = taskMentionTitle(rawEpicTitle);
  const chatEntries = chats.allIds.flatMap((id) => {
    if (!Object.hasOwn(chats.byId, id)) return [];
    return [buildChatMentionEntry(chats.byId[id], epicId, epicTitle)];
  });
  const terminalEntries = tuiAgents.allIds.flatMap((id) => {
    if (!Object.hasOwn(tuiAgents.byId, id)) return [];
    const agent = tuiAgents.byId[id];
    if (agent.harnessId === "cursor") return [];
    return [buildTerminalAgentMentionEntry(agent, epicId, epicTitle)];
  });
  const entries: ReadonlyArray<EpicAgentMentionEntry> = [
    ...chatEntries,
    ...terminalEntries,
  ];
  return entries.length === 0 ? EMPTY_AGENT_ENTRIES : entries;
}

/**
 * Pure projection of the host's `terminal.list` rows into @-mention terminal
 * suggestions for one Task.
 *
 * Filtered by `isVisibleEpicTerminalSession` - the same predicate the Terminals
 * panel applies - so the picker lists a terminal exactly while that panel does.
 * That is the whole visibility rule: it also keeps the host's `terminal-agent`
 * backing PTYs out (they are Agents, listed under Agents) and drops sessions
 * belonging to another Task or to the host's landing scope.
 */
export function epicTerminalMentionEntriesFromSessions(
  sessions: ReadonlyArray<CanonicalTerminalSessionInfo>,
  epicId: string,
): ReadonlyArray<EpicTerminalMentionEntry> {
  const entries = sessions.flatMap((session) => {
    if (!isVisibleEpicTerminalSession(session, epicId)) return [];
    return [buildTerminalMentionEntry(session, epicId)];
  });
  return entries.length === 0 ? EMPTY_TERMINAL_ENTRIES : entries;
}

function buildTerminalMentionEntry(
  session: CanonicalTerminalSessionInfo,
  epicId: string,
): EpicTerminalMentionEntry {
  return {
    kind: "epic-terminal",
    id: `terminal:${epicId}:${session.sessionId}`,
    token: `terminal:${epicId}/${session.sessionId}`,
    epicId,
    terminalId: session.sessionId,
    label: terminalSessionLabel(session),
    // The chip's tooltip and the row's secondary line: where this shell is.
    description: session.cwd,
    cwd: session.cwd,
    // Terminals carry no "updated" clock, so recency ranking falls back to
    // start time - newest shell first, which is the one just opened.
    updatedAt: session.createdAt,
  };
}

function matchesMentionQuery(label: string, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true;
  const normalizedLabel = label.toLowerCase();
  return (
    normalizedLabel.includes(normalizedQuery) ||
    isSubsequence(normalizedQuery, normalizedLabel)
  );
}

function localArtifactSuggestion(
  artifact: ArtifactProjection,
  currentEpicId: string,
  epicTitle: string,
  label: string,
): EpicMentionArtifactSuggestion {
  // Mirrors the host resolver's id/token format so a current-epic artifact
  // returned by BOTH the cloud list and the local store de-dupes to one entry.
  const common = {
    id: epicArtifactMentionId(artifact.kind, currentEpicId, artifact.id),
    token: epicArtifactMentionToken(artifact.kind, currentEpicId, artifact.id),
    epicId: currentEpicId,
    epicTitle,
    artifactId: artifact.id,
    label,
    description: epicTitle,
    status: artifact.status,
    updatedAt: artifact.updatedAt,
  };
  switch (artifact.kind) {
    case "spec":
      return { kind: "epic-artifact", artifactType: "spec", ...common };
    case "ticket":
      return { kind: "epic-artifact", artifactType: "ticket", ...common };
    case "story":
      return { kind: "epic-artifact", artifactType: "story", ...common };
    case "review":
      return { kind: "epic-artifact", artifactType: "review", ...common };
  }
}

/**
 * Pure projection of the open-epic artifact slice into @-mention artifact
 * suggestions for the current epic, filtered by `query`. Sourced live at query
 * time (see `useMentionItems`) the same churn-free way as chats, and merged
 * with the cloud `epic.mention*` list so the current epic's artifacts are never
 * dropped by the cloud's 25-per-kind cap.
 */
export function buildCurrentEpicArtifactMentionEntries(
  artifacts: ArtifactsSlice,
  currentEpicId: string,
  rawEpicTitle: string,
  query: string,
): ReadonlyArray<EpicMentionArtifactSuggestion> {
  if (artifacts.allIds.length === 0) return EMPTY_ARTIFACT_ENTRIES;
  const normalizedQuery = query.trim().toLowerCase();
  const epicTitle = taskMentionTitle(rawEpicTitle);
  const entries = artifacts.allIds.flatMap((id) => {
    if (!Object.hasOwn(artifacts.byId, id)) return [];
    const artifact = artifacts.byId[id];
    const label = displayTitle(artifact.title, artifact.kind);
    if (!matchesMentionQuery(label, normalizedQuery)) return [];
    return [localArtifactSuggestion(artifact, currentEpicId, epicTitle, label)];
  });
  return entries.length === 0 ? EMPTY_ARTIFACT_ENTRIES : entries;
}

/**
 * Merges the COMPLETE local current-epic artifact set with the cloud
 * `epic.mention*` list (so the current epic's artifacts are never dropped by
 * the cloud's 25-per-kind cap), de-duped by entry id (the fresher local copy
 * wins for the current epic). Orders current-epic artifacts first, other epics'
 * next; each group sorted by last-updated, descending.
 */
export function mergeCurrentEpicArtifactMentions(
  localCurrentEpicEntries: ReadonlyArray<EpicMentionArtifactSuggestion>,
  cloudEntries: ReadonlyArray<EpicMentionEntry>,
  currentEpicId: string,
): ReadonlyArray<EpicMentionEntry> {
  const byId = new Map<string, EpicMentionEntry>();
  for (const entry of localCurrentEpicEntries) byId.set(entry.id, entry);
  for (const entry of cloudEntries) {
    if (
      entry.kind === "epic-artifact" &&
      entry.epicId === currentEpicId &&
      byId.has(entry.id)
    ) {
      continue;
    }
    byId.set(entry.id, entry);
  }
  const merged = [...byId.values()];
  const isCurrentEpicArtifact = (entry: EpicMentionEntry): boolean =>
    entry.kind === "epic-artifact" && entry.epicId === currentEpicId;
  const byRecency = (a: EpicMentionEntry, b: EpicMentionEntry): number =>
    (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  return [
    ...merged.filter(isCurrentEpicArtifact).toSorted(byRecency),
    ...merged
      .filter((entry) => !isCurrentEpicArtifact(entry))
      .toSorted(byRecency),
  ];
}

export function mergeTaskAndArtifactMentionEntries(
  localTaskEntries: ReadonlyArray<EpicMentionEntry>,
  cloudAndArtifactEntries: ReadonlyArray<EpicMentionEntry>,
): ReadonlyArray<EpicMentionEntry> {
  if (localTaskEntries.length === 0 && cloudAndArtifactEntries.length === 0) {
    return EMPTY_EPIC_ENTRIES;
  }

  const normalizedLocalEntries = localTaskEntries.map(
    normalizeTaskMentionEntry,
  );
  const seenTaskIds = normalizedLocalEntries.reduce((ids, entry) => {
    if (entry.kind === "epic") ids.add(entry.id);
    return ids;
  }, new Set<string>());
  const normalizedCloudEntries = cloudAndArtifactEntries
    .map(normalizeTaskMentionEntry)
    .filter((entry) => {
      if (entry.kind !== "epic") return true;
      if (seenTaskIds.has(entry.id)) return false;
      seenTaskIds.add(entry.id);
      return true;
    });

  const merged: ReadonlyArray<EpicMentionEntry> = [
    ...normalizedLocalEntries,
    ...normalizedCloudEntries,
  ];
  return merged.length === 0 ? EMPTY_EPIC_ENTRIES : merged;
}

function normalizeTaskMentionEntry(entry: EpicMentionEntry): EpicMentionEntry {
  return entry;
}

function taskMentionTitle(rawTitle: string): string {
  return taskMentionTitleFromRawTitle(rawTitle);
}
