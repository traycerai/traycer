import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";

import { useEpicMentionEntries } from "@/hooks/composer/use-epic-mention-entries";
import { useWorkspaceEntries } from "@/hooks/composer/use-workspace-entries";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import type { HostRpcRegistry } from "@/lib/host";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  ChatProjection,
  ChatsSlice,
} from "@/stores/epics/open-epic/types";
import { isSubsequence } from "@traycer/protocol/utils/text/fuzzy";
import type { EpicMentionArtifactSuggestion } from "@traycer/protocol/host/epic/unary-schemas";
import {
  epicArtifactMentionId,
  epicArtifactMentionToken,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  mentionProviderRegistry,
  ROOT_MENTION_STEP,
  type ComposerMentionProviderContext,
  type MentionEpicRequest,
  type MentionFlowStep,
  type MentionMenuEntry,
  type MentionWorkspaceRequest,
} from "@/lib/composer/mentions";
import { buildEpicMentionSuggestionsFromTasks } from "@/lib/composer/mentions/local-epic-suggestions";
import { taskMentionTitleFromRawTitle } from "@/lib/composer/mentions/task-mention-helpers";
import { displayTitle } from "@/lib/display-title";
import type {
  EpicChatMentionEntry,
  EpicMentionEntry,
  WorkspaceEntry,
} from "@/lib/composer/types";

import type {
  ComposerPickerItem,
  ComposerPickerStore,
} from "./composer-picker-store";

const MENTION_RESULT_LIMIT = 25;
const MENTION_QUERY_DEBOUNCE_MS = 250;
const EMPTY_WORKSPACE_REQUESTS: ReadonlyArray<MentionWorkspaceRequest> = [];
const EMPTY_EPIC_REQUESTS: ReadonlyArray<MentionEpicRequest> = [];
const EMPTY_WORKSPACE_ENTRIES: ReadonlyArray<WorkspaceEntry> = [];
const EMPTY_EPIC_ENTRIES: ReadonlyArray<EpicMentionEntry> = [];

export interface UseMentionItemsParams {
  readonly pickerStore: ComposerPickerStore;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly mentionRoots: ReadonlyArray<string>;
  readonly currentEpicId: string | null;
}

interface MentionPickerSlice {
  readonly active: boolean;
  readonly query: string;
  readonly step: MentionFlowStep;
}

function selectMentionSlice(state: {
  open: boolean;
  kind: "mention" | "slash" | null;
  query: string;
  step: MentionFlowStep;
}): MentionPickerSlice {
  return {
    active: state.open && state.kind === "mention",
    query: state.kind === "mention" ? state.query : "",
    step: state.kind === "mention" ? state.step : ROOT_MENTION_STEP,
  };
}

export function useMentionItems(params: UseMentionItemsParams): void {
  const { pickerStore, hostClient, mentionRoots, currentEpicId } = params;

  const slice = useStore(pickerStore, useShallow(selectMentionSlice));
  const { active, query, step } = slice;
  const debouncedQuery = useDebouncedValue(query, MENTION_QUERY_DEBOUNCE_MS);

  // The @-mention chat list is the ONLY consumer of the open-epic chat records,
  // and only while the picker is open. Source it HERE, gated on `active`, rather
  // than threading it as an eager prop from the chat tile: a chat's `updatedAt`
  // bumps on every streaming-throttle tick (~80ms), which re-identified the
  // records array and re-rendered the whole composer + its Radix chrome. Reading
  // live via `getState` at query time keeps the recency sort accurate without
  // subscribing the composer to that churn. `handle === null` is the landing
  // composer (no open epic).
  const handle = useMaybeOpenEpicHandle();
  const epicChatEntries = useMemo<ReadonlyArray<EpicChatMentionEntry>>(() => {
    if (!active || handle === null || currentEpicId === null) {
      return EMPTY_CHAT_ENTRIES;
    }
    const state = handle.store.getState();
    return epicChatMentionEntriesFromChats(
      state.chats,
      currentEpicId,
      state.epic.title,
    );
    // Snapshot the chat list when the picker opens (`active` flips). The query
    // filters this list downstream, so it does not need to re-pull per keystroke;
    // the list only changes if a chat is added/removed while the picker is open,
    // which re-snapshots on the next open.
  }, [active, handle, currentEpicId]);

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
      chatEntries: EMPTY_CHAT_ENTRIES,
    }),
    [currentEpicId, mentionRoots, query],
  );

  const debouncedRequestContext = useMemo<ComposerMentionProviderContext>(
    () => ({
      roots: mentionRoots,
      query: debouncedQuery,
      limit: MENTION_RESULT_LIMIT,
      workspaceEntries: EMPTY_WORKSPACE_ENTRIES,
      epicEntries: EMPTY_EPIC_ENTRIES,
      currentEpicId,
      chatEntries: EMPTY_CHAT_ENTRIES,
    }),
    [currentEpicId, debouncedQuery, mentionRoots],
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

  const { data: workspaceEntries, isLoading: workspaceLoading } =
    useWorkspaceEntries({ requests: workspaceRequests, client: hostClient });
  const { data: remoteEpicEntries, isLoading: epicLoading } =
    useEpicMentionEntries({
      requests: epicRequests,
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
      chatEntries: epicChatEntries,
    }),
    [
      currentEpicId,
      epicChatEntries,
      epicEntries,
      epicRequests.length,
      mentionRoots,
      query,
      workspaceEntries,
      workspaceRequests.length,
    ],
  );

  const entries = useMemo<ReadonlyArray<MentionMenuEntry>>(
    () =>
      active ? mentionProviderRegistry.entries(step, resolvedContext) : [],
    [active, resolvedContext, step],
  );

  const items = useMemo<ReadonlyArray<ComposerPickerItem>>(
    () =>
      entries.map((entry) => ({
        id: entry.id,
        kind: "mention",
        entry,
      })),
    [entries],
  );

  const loading =
    active &&
    ((workspaceRequests.length > 0 && workspaceLoading) ||
      (epicRequests.length > 0 && epicLoading));

  useEffect(() => {
    if (!active) return;
    pickerStore.getState().setItems({
      kind: "mention",
      query,
      step,
      items,
      loading,
    });
  }, [active, items, loading, pickerStore, query, step]);
}

const EMPTY_CHAT_ENTRIES: ReadonlyArray<EpicChatMentionEntry> = [];
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
    label: displayTitle(chat.title, "chat"),
    description: epicTitle,
    parentId: chat.parentId,
    updatedAt: chat.updatedAt,
  };
}

/**
 * Pure projection of the open-epic chat slice into @-mention chat entries.
 * Extracted so the picker can source the list live at query time (see
 * `useMentionItems`) instead of having it threaded in as an eager prop - which
 * re-rendered the whole composer on every streaming `updatedAt` bump.
 */
export function epicChatMentionEntriesFromChats(
  chats: ChatsSlice,
  epicId: string,
  rawEpicTitle: string,
): ReadonlyArray<EpicChatMentionEntry> {
  if (chats.allIds.length === 0) return EMPTY_CHAT_ENTRIES;
  const epicTitle = taskMentionTitle(rawEpicTitle);
  const entries = chats.allIds.flatMap((id) => {
    if (!Object.hasOwn(chats.byId, id)) return [];
    const chat = chats.byId[id];
    return [buildChatMentionEntry(chat, epicId, epicTitle)];
  });
  return entries.length === 0 ? EMPTY_CHAT_ENTRIES : entries;
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
