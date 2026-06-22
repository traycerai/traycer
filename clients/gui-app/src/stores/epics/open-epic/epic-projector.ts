/**
 * Y.Doc → Zustand projector for the per-Epic store.
 *
 * Responsibilities:
 *   - `attach(doc, store)`: install a single `observeDeep` on `doc.getMap("epic")`
 *     and run an initial full projection.
 *   - `detach()`: tear the listener down before the doc is destroyed (replica
 *     swap on `requestFreshSnapshot`, store dispose).
 *   - On every Y transaction (regardless of origin), collect typed patches
 *     from the event list, then call `store.setState(...)` exactly ONCE so a
 *     transaction touching N artifacts produces 1 React render, not N.
 *
 * Identity contract: per-entry refs in `byId` tables only change when that
 * entry's projected fields change. Untouched siblings keep their prior
 * reference, so component selectors using `Object.is` skip the render.
 *
 * Suspension flag: `onSnapshot` applies the snapshot bytes (which fire
 * `observeDeep`) and then runs a deterministic full re-project as part of
 * its own atomic `setState`. The `suspend()` / `resume()` pair lets the
 * caller silence the intermediate observeDeep storm so projection happens
 * exactly once per snapshot.
 */
import * as Y from "yjs";
import type { StoreApi } from "zustand";
import type { OpenEpicState } from "./store";
import {
  arrayShallowEq,
  artifactProjectionsEq,
  chatProjectionsEq,
  deletedArtifactProjectionsEq,
  getArtifactEntry,
  getArtifactsMap,
  getChatEntry,
  getChatsMap,
  getDeletedArtifactEntry,
  getDeletedArtifactsMap,
  getEpicMap,
  getTerminalAgentEntry,
  getTerminalAgentsMap,
  isChatVisibleToUser,
  isTerminalAgentVisibleToUser,
  projectArtifact,
  projectChat,
  projectDeletedArtifact,
  projectFullState,
  projectTerminalAgent,
  projectTreeSlice,
  readMaybeBoolean,
  readMaybeNumber,
  readMaybeString,
  terminalAgentProjectionsEq,
  treeNodesEq,
} from "./projection-helpers";
import type {
  ArtifactsSlice,
  ChatProjection,
  ChatsSlice,
  DeletedArtifactsSlice,
  EpicHeader,
  EpicProjectedSlices,
  TuiAgentProjection,
  TerminalAgentsSlice,
  TreeNode,
  TreeSlice,
} from "./types";
import { EMPTY_ARRAY, EMPTY_PROJECTED_SLICES } from "./types";

interface AttachedConfig {
  readonly doc: Y.Doc;
  readonly store: StoreApi<OpenEpicState>;
  readonly handler: (
    events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
    transaction: Y.Transaction,
  ) => void;
}

interface ProjectorPatches {
  artifactsChanged: Set<string>;
  artifactsRemoved: Set<string>;
  artifactsCreated: Set<string>;
  deletedArtifactsChanged: Set<string>;
  deletedArtifactsRemoved: Set<string>;
  chatsChanged: Set<string>;
  chatsRemoved: Set<string>;
  chatsCreated: Set<string>;
  terminalAgentsChanged: Set<string>;
  terminalAgentsRemoved: Set<string>;
  terminalAgentsCreated: Set<string>;
  titleChanged: boolean;
  updatedAtChanged: boolean;
  isTitleEditedByUserChanged: boolean;
  structuralTreeDirty: boolean;
  /**
   * True when the `epic.artifacts` container map itself was added /
   * replaced in this transaction. yjs `observeDeep` does not always
   * surface entries added INSIDE a freshly-created child map within the
   * same transaction (the new child's observers aren't wired until after
   * the transaction commits), so `applyPatches` falls back to a full
   * re-scan of the artifacts container in this case.
   */
  artifactsContainerReseeded: boolean;
  deletedArtifactsContainerReseeded: boolean;
  chatsContainerReseeded: boolean;
  terminalAgentsContainerReseeded: boolean;
}

function emptyPatches(): ProjectorPatches {
  return {
    artifactsChanged: new Set(),
    artifactsRemoved: new Set(),
    artifactsCreated: new Set(),
    deletedArtifactsChanged: new Set(),
    deletedArtifactsRemoved: new Set(),
    chatsChanged: new Set(),
    chatsRemoved: new Set(),
    chatsCreated: new Set(),
    terminalAgentsChanged: new Set(),
    terminalAgentsRemoved: new Set(),
    terminalAgentsCreated: new Set(),
    titleChanged: false,
    updatedAtChanged: false,
    isTitleEditedByUserChanged: false,
    structuralTreeDirty: false,
    artifactsContainerReseeded: false,
    deletedArtifactsContainerReseeded: false,
    chatsContainerReseeded: false,
    terminalAgentsContainerReseeded: false,
  };
}

function patchSetsEmpty(p: ProjectorPatches): boolean {
  return (
    p.artifactsChanged.size === 0 &&
    p.artifactsRemoved.size === 0 &&
    p.artifactsCreated.size === 0 &&
    p.deletedArtifactsChanged.size === 0 &&
    p.deletedArtifactsRemoved.size === 0 &&
    p.chatsChanged.size === 0 &&
    p.chatsRemoved.size === 0 &&
    p.chatsCreated.size === 0 &&
    p.terminalAgentsChanged.size === 0 &&
    p.terminalAgentsRemoved.size === 0 &&
    p.terminalAgentsCreated.size === 0
  );
}

function patchFlagsEmpty(p: ProjectorPatches): boolean {
  return (
    !p.titleChanged &&
    !p.updatedAtChanged &&
    !p.isTitleEditedByUserChanged &&
    !p.structuralTreeDirty &&
    !p.artifactsContainerReseeded &&
    !p.deletedArtifactsContainerReseeded &&
    !p.chatsContainerReseeded &&
    !p.terminalAgentsContainerReseeded
  );
}

function patchesEmpty(p: ProjectorPatches): boolean {
  return patchSetsEmpty(p) && patchFlagsEmpty(p);
}

export interface EpicProjector {
  attach: (doc: Y.Doc, store: StoreApi<OpenEpicState>) => void;
  detach: () => void;
  /**
   * Suspend observeDeep-driven setState calls. Used by `onSnapshot` to
   * apply the snapshot bytes and then run a single atomic re-project as
   * part of its own setState - without this guard the intermediate
   * observeDeep events would each schedule a partial update.
   */
  suspend: () => void;
  resume: () => void;
  /** Force a full re-projection. Returns the projected slices. */
  projectFull: () => EpicProjectedSlices;
}

/**
 * `getCurrentUserId` resolves the signed-in user's id at projection time so the
 * projector can hide chats and terminal agents owned by a different user.
 * It is a getter, not a fixed value, so a session that projects before the auth
 * profile has hydrated picks up the real id on the next projection. Reads the
 * id lazily rather than threading it through every `createOpenEpicStore` caller.
 */
export function createEpicProjector(
  getCurrentUserId: () => string | null,
): EpicProjector {
  let attached: AttachedConfig | null = null;
  let suspended = false;

  function detachInternal(): void {
    if (attached === null) return;
    const epicMap = getEpicMap(attached.doc);
    epicMap.unobserveDeep(attached.handler);
    attached = null;
  }

  function attach(doc: Y.Doc, store: StoreApi<OpenEpicState>): void {
    detachInternal();

    const handler = (
      events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
      _transaction: Y.Transaction,
    ): void => {
      if (suspended) return;
      const patches = collectPatches(events, doc);
      if (patchesEmpty(patches)) return;
      store.setState(
        applyPatches(store.getState(), doc, patches, getCurrentUserId()),
      );
    };
    attached = { doc, store, handler };
    getEpicMap(doc).observeDeep(handler);

    // Initial full projection so attaching to a non-empty doc populates the
    // store deterministically. Skipped during suspended attach so snapshot
    // ingest can apply bytes and then call `projectFull` once.
    if (!suspended) {
      store.setState(projectFullState(doc, getCurrentUserId()));
    }
  }

  function detach(): void {
    detachInternal();
  }

  function suspend(): void {
    suspended = true;
  }

  function resume(): void {
    suspended = false;
  }

  function projectFull(): EpicProjectedSlices {
    if (attached === null) return EMPTY_PROJECTED_SLICES;
    return projectFullState(attached.doc, getCurrentUserId());
  }

  return { attach, detach, suspend, resume, projectFull };
}

// ─── Path classification ──────────────────────────────────────────────────

/**
 * Walk the event's `target` parent chain back to the epic root and read
 * the path segments along the way. We don't trust `event.path` directly
 * because nested map deletions can mutate it after the fact; deriving
 * from the live target is robust against ordering surprises.
 */
function pathOfEvent(event: Y.YEvent<Y.AbstractType<unknown>>): string[] {
  const out: string[] = [];
  for (const segment of event.path) {
    if (typeof segment === "string") {
      out.push(segment);
    } else {
      out.push(String(segment));
    }
  }
  return out;
}

/**
 * Keys on an artifact entry whose change forces a tree rebuild because the
 * tree slice depends on them (parent/child grouping, sort key, label).
 */
const ARTIFACT_TREE_KEYS: ReadonlySet<string> = new Set([
  "parentId",
  "title",
  "status",
  "createdAt",
  "kind",
]);

/**
 * Keys on a chat entry whose change forces a tree rebuild. Ownership changes
 * are handled after projection by comparing visible chat membership, so `userId`
 * does not need to broadly dirty the tree for visible -> visible backfills.
 */
const CHAT_TREE_KEYS: ReadonlySet<string> = new Set([
  "parentId",
  "title",
  "createdAt",
]);

/**
 * Keys on a terminal-agent entry whose change forces a tree rebuild. Ownership
 * changes are handled after projection by comparing visible terminal-agent
 * membership, so `userId` does not need to broadly dirty the tree for visible
 * -> visible backfills.
 */
const TERMINAL_AGENT_TREE_KEYS: ReadonlySet<string> = new Set([
  "parentId",
  "title",
  "createdAt",
]);

function classifyEpicRoot(
  event: Y.YMapEvent<unknown>,
  patches: ProjectorPatches,
): void {
  for (const key of keysChangedAsStrings(event)) {
    if (key === "title") {
      patches.titleChanged = true;
    } else if (key === "updatedAt") {
      patches.updatedAtChanged = true;
    } else if (key === "isTitleEditedByUser") {
      patches.isTitleEditedByUserChanged = true;
    } else if (key === "artifacts") {
      patches.artifactsContainerReseeded = true;
      patches.structuralTreeDirty = true;
    } else if (key === "deletedArtifacts") {
      // Tombstones never enter the tree, so no `structuralTreeDirty`.
      patches.deletedArtifactsContainerReseeded = true;
    } else if (key === "chats") {
      patches.chatsContainerReseeded = true;
      patches.structuralTreeDirty = true;
    } else if (key === "tuiAgents") {
      patches.terminalAgentsContainerReseeded = true;
      patches.structuralTreeDirty = true;
    }
  }
}

function classifyArtifactsContainer(
  event: Y.YMapEvent<unknown>,
  patches: ProjectorPatches,
): void {
  for (const [key, change] of event.changes.keys) {
    if (change.action === "delete") {
      patches.artifactsRemoved.add(key);
    } else if (change.action === "add") {
      patches.artifactsCreated.add(key);
      patches.artifactsChanged.add(key);
    } else {
      patches.artifactsChanged.add(key);
    }
  }
  if (event.changes.keys.size > 0) {
    patches.structuralTreeDirty = true;
  }
}

function classifyDeletedArtifactsContainer(
  event: Y.YMapEvent<unknown>,
  patches: ProjectorPatches,
): void {
  // Tombstone add/update both project the same way (no tree, no created-set
  // semantics); a delete (un-tombstone / hard purge) drops it from the slice.
  for (const [key, change] of event.changes.keys) {
    if (change.action === "delete") {
      patches.deletedArtifactsRemoved.add(key);
    } else {
      patches.deletedArtifactsChanged.add(key);
    }
  }
}

function classifyChatsContainer(
  event: Y.YMapEvent<unknown>,
  patches: ProjectorPatches,
): void {
  for (const [key, change] of event.changes.keys) {
    if (change.action === "delete") {
      patches.chatsRemoved.add(key);
    } else if (change.action === "add") {
      patches.chatsCreated.add(key);
      patches.chatsChanged.add(key);
    } else {
      patches.chatsChanged.add(key);
    }
  }
  if (event.changes.keys.size > 0) {
    patches.structuralTreeDirty = true;
  }
}

function classifyTerminalAgentsContainer(
  event: Y.YMapEvent<unknown>,
  patches: ProjectorPatches,
): void {
  for (const [key, change] of event.changes.keys) {
    if (change.action === "delete") {
      patches.terminalAgentsRemoved.add(key);
    } else if (change.action === "add") {
      patches.terminalAgentsCreated.add(key);
      patches.terminalAgentsChanged.add(key);
    } else {
      patches.terminalAgentsChanged.add(key);
    }
  }
  if (event.changes.keys.size > 0) {
    patches.structuralTreeDirty = true;
  }
}

function keysChangedAsStrings(event: Y.YMapEvent<unknown>): readonly string[] {
  // `Y.YMapEvent.keysChanged` is typed as `Set<any>` in the bundled yjs
  // declarations; project-side lint rejects iterating it without coercion.
  // Materialize to a string array we control.
  const out: string[] = [];
  for (const key of event.keysChanged) {
    out.push(String(key));
  }
  return out;
}

function classifyArtifactEntry(
  artifactId: string,
  path: readonly string[],
  event: Y.YEvent<Y.AbstractType<unknown>>,
  patches: ProjectorPatches,
): void {
  if (path.length === 2 && event instanceof Y.YMapEvent) {
    patches.artifactsChanged.add(artifactId);
    for (const key of keysChangedAsStrings(event)) {
      if (ARTIFACT_TREE_KEYS.has(key)) {
        patches.structuralTreeDirty = true;
      }
    }
    return;
  }
  // Body edits are artifact-room-doc scoped after B6. Legacy nested root
  // `artifacts/{id}/content` changes are intentionally ignored so root
  // metadata projection stays metadata-only.
}

function classifyDeletedArtifactEntry(
  artifactId: string,
  path: readonly string[],
  event: Y.YEvent<Y.AbstractType<unknown>>,
  patches: ProjectorPatches,
): void {
  if (path.length === 2 && event instanceof Y.YMapEvent) {
    patches.deletedArtifactsChanged.add(artifactId);
  }
}

function classifyChatEntry(
  chatId: string,
  path: readonly string[],
  event: Y.YEvent<Y.AbstractType<unknown>>,
  patches: ProjectorPatches,
): void {
  if (path.length === 2 && event instanceof Y.YMapEvent) {
    patches.chatsChanged.add(chatId);
    for (const key of keysChangedAsStrings(event)) {
      if (CHAT_TREE_KEYS.has(key)) {
        patches.structuralTreeDirty = true;
      }
    }
  }
}

function classifyTerminalAgentEntry(
  agentId: string,
  path: readonly string[],
  event: Y.YEvent<Y.AbstractType<unknown>>,
  patches: ProjectorPatches,
): void {
  if (path.length === 2 && event instanceof Y.YMapEvent) {
    patches.terminalAgentsChanged.add(agentId);
    for (const key of keysChangedAsStrings(event)) {
      if (TERMINAL_AGENT_TREE_KEYS.has(key)) {
        patches.structuralTreeDirty = true;
      }
    }
  }
}

// Flat event-routing table (Y path -> handler). The branch count is the routing
// table itself; collapsing it would scatter the dispatch and hurt readability.
// eslint-disable-next-line complexity
function classifyEvent(
  event: Y.YEvent<Y.AbstractType<unknown>>,
  patches: ProjectorPatches,
): void {
  const path = pathOfEvent(event);

  // Y.Map "epic" root: title / isTitleEditedByUser / artifacts /
  // chats. Container additions are uncommon (lazy `ensureMap`) but
  // handled defensively.
  if (path.length === 0 && event instanceof Y.YMapEvent) {
    classifyEpicRoot(event, patches);
    return;
  }

  if (path.length === 1 && event instanceof Y.YMapEvent) {
    if (path[0] === "artifacts") {
      classifyArtifactsContainer(event, patches);
      return;
    }
    if (path[0] === "deletedArtifacts") {
      classifyDeletedArtifactsContainer(event, patches);
      return;
    }
    if (path[0] === "chats") {
      classifyChatsContainer(event, patches);
      return;
    }
    if (path[0] === "tuiAgents") {
      classifyTerminalAgentsContainer(event, patches);
      return;
    }
  }

  if (path.length >= 2 && path[0] === "artifacts") {
    classifyArtifactEntry(path[1], path, event, patches);
    return;
  }

  if (path.length >= 2 && path[0] === "deletedArtifacts") {
    classifyDeletedArtifactEntry(path[1], path, event, patches);
    return;
  }

  if (path.length >= 2 && path[0] === "chats") {
    classifyChatEntry(path[1], path, event, patches);
    return;
  }

  if (path.length >= 2 && path[0] === "tuiAgents") {
    classifyTerminalAgentEntry(path[1], path, event, patches);
  }
}

function collectPatches(
  events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
  _doc: Y.Doc,
): ProjectorPatches {
  const patches = emptyPatches();
  for (const event of events) {
    classifyEvent(event, patches);
  }
  return patches;
}

// ─── Patch application ───────────────────────────────────────────────────

// Mutable mirror of the projected slices so the patch builder below can
// assign to fields without fighting `readonly` modifiers; the result is
// returned as `Partial<OpenEpicState>` and Zustand's setState merges it
// back into the readonly store shape.
//
// Spelled with explicit fields (instead of a `OpenEpicState[K]` mapped
// type) so this module's type-graph stays independent of the circular
// `store.ts` import - typed-eslint rules otherwise see the mapped lookup
// as `error` and reject every `next.X = Y` write site.
type MutableProjectedPatch = {
  epic?: EpicHeader;
  artifacts?: ArtifactsSlice;
  deletedArtifacts?: DeletedArtifactsSlice;
  chats?: ChatsSlice;
  tuiAgents?: TerminalAgentsSlice;
  tree?: TreeSlice;
};

function applyEpicHeader(
  state: OpenEpicState,
  doc: Y.Doc,
  patches: ProjectorPatches,
  next: MutableProjectedPatch,
): void {
  if (
    !patches.titleChanged &&
    !patches.updatedAtChanged &&
    !patches.isTitleEditedByUserChanged
  ) {
    return;
  }
  const epic = getEpicMap(doc);
  const header = {
    title: readMaybeString(epic, "title"),
    updatedAt: readMaybeNumber(epic, "updatedAt"),
    isTitleEditedByUser: readMaybeBoolean(epic, "isTitleEditedByUser"),
  };
  if (
    header.title !== state.epic.title ||
    header.updatedAt !== state.epic.updatedAt ||
    header.isTitleEditedByUser !== state.epic.isTitleEditedByUser
  ) {
    next.epic = header;
  }
}

/**
 * Reseed `targetChanged` from the live container's keys when a container
 * Y.Map was just freshly materialized in this transaction. yjs does not
 * always surface `add`/`update` events on children of a brand-new child
 * map within the same transaction, so we re-derive the set from the
 * authoritative live container.
 */
function reseedFromContainer(
  doc: Y.Doc,
  resolveMap: (doc: Y.Doc) => Y.Map<unknown> | null,
  targetChanged: Set<string>,
): void {
  const map = resolveMap(doc);
  if (map === null) return;
  for (const id of map.keys()) {
    targetChanged.add(id);
  }
}

/**
 * Incremental reconcile of a `byId`/`allIds` map slice from the dirty sets.
 * Returns the next slice when something in scope moved, or `null` when nothing
 * did (the caller keeps the previous slice ref). `extraDirty` is a set whose
 * non-emptiness alone forces past the early-out even with no changed/removed ids
 * (the live-artifact slice passes `artifactsCreated`; tombstones pass `null`).
 * Shared by the live-artifact and deleted-artifact slices so their reconcile +
 * identity contract (`pickStableIds`, empty-array collapse) can never drift.
 */
// Incremental slice reconciler (reseed / changed / removed / extra-dirty paths).
// The branches are the distinct projection transitions; splitting them risks
// subtle divergence between the incremental and full-projection results.
// eslint-disable-next-line complexity
function applyMapSlice<T>(
  prevSlice: {
    readonly byId: Readonly<Record<string, T>>;
    readonly allIds: readonly string[];
  },
  doc: Y.Doc,
  config: {
    readonly resolveMap: (doc: Y.Doc) => Y.Map<unknown> | null;
    readonly getEntry: (doc: Y.Doc, id: string) => Y.Map<unknown> | null;
    readonly project: (id: string, entry: Y.Map<unknown>) => T | null;
    readonly eq: (a: T, b: T) => boolean;
    readonly changed: Set<string>;
    readonly removed: Set<string>;
    readonly reseeded: boolean;
    readonly extraDirty: Set<string> | null;
  },
): {
  readonly byId: Readonly<Record<string, T>>;
  readonly allIds: readonly string[];
} | null {
  if (config.reseeded) {
    reseedFromContainer(doc, config.resolveMap, config.changed);
    // The container itself was dropped — clear the slice rather than leaving
    // stale entries (reseed adds no keys when resolveMap returns null, so the
    // changed/removed sets stay empty and the early-out below would keep
    // whatever was there before).
    if (config.resolveMap(doc) === null) {
      return { byId: {}, allIds: EMPTY_ARRAY };
    }
  }
  const extraDirtySize =
    config.extraDirty === null ? 0 : config.extraDirty.size;
  if (
    config.changed.size === 0 &&
    config.removed.size === 0 &&
    extraDirtySize === 0
  ) {
    return null;
  }
  const byId: Record<string, T> = { ...prevSlice.byId };
  let mutated = false;
  for (const id of config.removed) {
    if (Object.hasOwn(byId, id)) {
      delete byId[id];
      mutated = true;
    }
  }
  for (const id of config.changed) {
    if (config.removed.has(id)) continue;
    const entry = config.getEntry(doc, id);
    const projected = entry === null ? null : config.project(id, entry);
    if (projected === null) {
      if (Object.hasOwn(byId, id)) {
        delete byId[id];
        mutated = true;
      }
      continue;
    }
    if (!Object.hasOwn(byId, id) || !config.eq(byId[id], projected)) {
      byId[id] = projected;
      mutated = true;
    }
  }
  if (!mutated) return null;
  const allIds = computeIdsFromMap(byId);
  const allIdsRef = pickStableIds(allIds, prevSlice.allIds);
  return { byId, allIds: allIdsRef };
}

function applyArtifactsSlice(
  state: OpenEpicState,
  doc: Y.Doc,
  patches: ProjectorPatches,
  next: MutableProjectedPatch,
): ArtifactsSlice {
  const nextSlice = applyMapSlice(state.artifacts, doc, {
    resolveMap: getArtifactsMap,
    getEntry: getArtifactEntry,
    project: projectArtifact,
    eq: artifactProjectionsEq,
    changed: patches.artifactsChanged,
    removed: patches.artifactsRemoved,
    reseeded: patches.artifactsContainerReseeded,
    extraDirty: patches.artifactsCreated,
  });
  if (nextSlice === null) return state.artifacts;
  next.artifacts = nextSlice;
  return nextSlice;
}

/**
 * Project the `deletedArtifacts` tombstone slice. Independent of the artifact
 * tree (tombstones are not tree nodes), so this never touches the tree patch -
 * it only maintains a `byId`/`allIds` table the delete card resolves against.
 */
function applyDeletedArtifactsSlice(
  state: OpenEpicState,
  doc: Y.Doc,
  patches: ProjectorPatches,
  next: MutableProjectedPatch,
): void {
  const nextSlice = applyMapSlice(state.deletedArtifacts, doc, {
    resolveMap: getDeletedArtifactsMap,
    getEntry: getDeletedArtifactEntry,
    project: projectDeletedArtifact,
    eq: deletedArtifactProjectionsEq,
    changed: patches.deletedArtifactsChanged,
    removed: patches.deletedArtifactsRemoved,
    reseeded: patches.deletedArtifactsContainerReseeded,
    extraDirty: null,
  });
  if (nextSlice !== null) next.deletedArtifacts = nextSlice;
}

interface ApplyChatsArgs {
  readonly state: OpenEpicState;
  readonly doc: Y.Doc;
  readonly patches: ProjectorPatches;
  readonly next: MutableProjectedPatch;
  readonly currentUserId: string | null;
}

function applyChatsSlice(args: ApplyChatsArgs): ChatsSlice {
  const { state, doc, patches, next, currentUserId } = args;
  if (patches.chatsContainerReseeded) {
    reseedFromContainer(doc, getChatsMap, patches.chatsChanged);
  }
  if (
    patches.chatsChanged.size === 0 &&
    patches.chatsRemoved.size === 0 &&
    patches.chatsCreated.size === 0
  ) {
    return state.chats;
  }
  const byId: Record<string, ChatProjection> = { ...state.chats.byId };
  let mutated = false;
  for (const id of patches.chatsRemoved) {
    if (Object.hasOwn(byId, id)) {
      delete byId[id];
      mutated = true;
    }
  }
  for (const id of patches.chatsChanged) {
    if (patches.chatsRemoved.has(id)) continue;
    const entry = getChatEntry(doc, id);
    if (entry === null) {
      if (Object.hasOwn(byId, id)) {
        delete byId[id];
        mutated = true;
      }
      continue;
    }
    const projected = projectChat(id, entry);
    // A chat owned by a different user must never enter the projection. Treat a
    // not-visible result like a removal so a chat that arrives mid-session from
    // another collaborator (incremental container add) is dropped from `byId`.
    if (!isChatVisibleToUser(projected.userId, currentUserId)) {
      if (Object.hasOwn(byId, id)) {
        delete byId[id];
        mutated = true;
      }
      continue;
    }
    if (!Object.hasOwn(byId, id) || !chatProjectionsEq(byId[id], projected)) {
      byId[id] = projected;
      mutated = true;
    }
  }
  if (!mutated) return state.chats;
  const allIds = computeIdsFromMap(byId);
  const allIdsRef = pickStableIds(allIds, state.chats.allIds);
  const nextChats: ChatsSlice = { byId, allIds: allIdsRef };
  next.chats = nextChats;
  return nextChats;
}

interface ApplyTerminalAgentsArgs {
  readonly state: OpenEpicState;
  readonly doc: Y.Doc;
  readonly patches: ProjectorPatches;
  readonly next: MutableProjectedPatch;
  readonly currentUserId: string | null;
}

// Mirror of applyMapSlice for the terminal-agents slice, with the extra
// per-agent membership transitions; same rationale for keeping it flat.
// eslint-disable-next-line complexity
function applyTerminalAgentsSlice(
  args: ApplyTerminalAgentsArgs,
): TerminalAgentsSlice {
  const { state, doc, patches, next, currentUserId } = args;
  if (patches.terminalAgentsContainerReseeded) {
    reseedFromContainer(
      doc,
      getTerminalAgentsMap,
      patches.terminalAgentsChanged,
    );
  }
  if (
    patches.terminalAgentsChanged.size === 0 &&
    patches.terminalAgentsRemoved.size === 0 &&
    patches.terminalAgentsCreated.size === 0
  ) {
    return state.tuiAgents;
  }
  const byId: Record<string, TuiAgentProjection> = {
    ...state.tuiAgents.byId,
  };
  let mutated = false;
  for (const id of patches.terminalAgentsRemoved) {
    if (Object.hasOwn(byId, id)) {
      delete byId[id];
      mutated = true;
    }
  }
  for (const id of patches.terminalAgentsChanged) {
    if (patches.terminalAgentsRemoved.has(id)) continue;
    const entry = getTerminalAgentEntry(doc, id);
    const projected = entry === null ? null : projectTerminalAgent(id, entry);
    if (projected === null) {
      if (Object.hasOwn(byId, id)) {
        delete byId[id];
        mutated = true;
      }
      continue;
    }
    // A terminal agent owned by a different user follows the same display
    // ownership gate as GUI chats. Treat not-visible like a removal so live
    // collaborator-created agents never enter `tuiAgents` or the tree.
    if (!isTerminalAgentVisibleToUser(projected.userId, currentUserId)) {
      if (Object.hasOwn(byId, id)) {
        delete byId[id];
        mutated = true;
      }
      continue;
    }
    if (
      !Object.hasOwn(byId, id) ||
      !terminalAgentProjectionsEq(byId[id], projected)
    ) {
      byId[id] = projected;
      mutated = true;
    }
  }
  if (!mutated) return state.tuiAgents;
  const allIds = computeIdsFromMap(byId);
  const allIdsRef = pickStableIds(allIds, state.tuiAgents.allIds);
  const nextSlice: TerminalAgentsSlice = { byId, allIds: allIdsRef };
  next.tuiAgents = nextSlice;
  return nextSlice;
}

interface ApplyTreeArgs {
  readonly state: OpenEpicState;
  readonly patches: ProjectorPatches;
  readonly nextArtifacts: ArtifactsSlice;
  readonly nextChats: ChatsSlice;
  readonly nextTerminalAgents: TerminalAgentsSlice;
  readonly next: MutableProjectedPatch;
}

/**
 * Splice prior identity-equal arrays/nodes into the freshly-computed tree
 * slice so subscribers using `Object.is` skip re-renders when a mutation
 * didn't actually change the slot they care about (e.g. status edit on
 * one node leaves every other node's TreeNode ref intact).
 */
function applyTreeSlice(args: ApplyTreeArgs): void {
  const { state, patches, nextArtifacts, nextChats, nextTerminalAgents, next } =
    args;
  if (!patches.structuralTreeDirty) return;
  const tree = projectTreeSlice(nextArtifacts, nextChats, nextTerminalAgents);
  const rootIds = arrayShallowEq(tree.rootIds, state.tree.rootIds)
    ? state.tree.rootIds
    : tree.rootIds;
  const { value: childrenByParent, identical: childrenIdentical } =
    spliceChildrenByParent(tree.childrenByParent, state.tree.childrenByParent);
  const { value: nodeById, identical: nodesIdentical } = spliceNodeById(
    tree.nodeById,
    state.tree.nodeById,
  );
  const treeChanged =
    rootIds !== state.tree.rootIds || !childrenIdentical || !nodesIdentical;
  if (treeChanged) {
    next.tree = { rootIds, childrenByParent, nodeById };
  }
}

interface SpliceResult<V> {
  readonly value: Readonly<Record<string, V>>;
  readonly identical: boolean;
}

function spliceChildrenByParent(
  next: Readonly<Record<string, readonly string[]>>,
  prev: Readonly<Record<string, readonly string[]>>,
): SpliceResult<readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  const nextKeys = Object.keys(next);
  let identical = nextKeys.length === Object.keys(prev).length;
  for (const k of nextKeys) {
    const nextChildren = next[k];
    if (Object.hasOwn(prev, k) && arrayShallowEq(prev[k], nextChildren)) {
      out[k] = prev[k];
    } else {
      out[k] = nextChildren;
      identical = false;
    }
  }
  return { value: out, identical };
}

function spliceNodeById(
  next: Readonly<Record<string, TreeNode>>,
  prev: Readonly<Record<string, TreeNode>>,
): SpliceResult<TreeNode> {
  const out: Record<string, TreeNode> = {};
  const nextKeys = Object.keys(next);
  let identical = nextKeys.length === Object.keys(prev).length;
  for (const k of nextKeys) {
    const nextNode = next[k];
    if (Object.hasOwn(prev, k) && treeNodesEq(prev[k], nextNode)) {
      out[k] = prev[k];
    } else {
      out[k] = nextNode;
      identical = false;
    }
  }
  return { value: out, identical };
}

function applyPatches(
  state: OpenEpicState,
  doc: Y.Doc,
  patches: ProjectorPatches,
  currentUserId: string | null,
): Partial<OpenEpicState> {
  const next: MutableProjectedPatch = {};
  applyEpicHeader(state, doc, patches, next);
  const nextArtifacts = applyArtifactsSlice(state, doc, patches, next);
  applyDeletedArtifactsSlice(state, doc, patches, next);
  const nextChats = applyChatsSlice({
    state,
    doc,
    patches,
    next,
    currentUserId,
  });
  if (nextChats.allIds !== state.chats.allIds) {
    patches.structuralTreeDirty = true;
  }
  const nextTerminalAgents = applyTerminalAgentsSlice({
    state,
    doc,
    patches,
    next,
    currentUserId,
  });
  if (nextTerminalAgents.allIds !== state.tuiAgents.allIds) {
    patches.structuralTreeDirty = true;
  }
  applyTreeSlice({
    state,
    patches,
    nextArtifacts,
    nextChats,
    nextTerminalAgents,
    next,
  });
  return next;
}

function computeIdsFromMap(map: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(map);
}

function pickStableIds(
  next: readonly string[],
  prev: readonly string[],
): readonly string[] {
  if (arrayShallowEq(next, prev)) return prev;
  if (next.length === 0) return EMPTY_ARRAY;
  return next;
}

// Re-export helpers some tests may want.
export { collectPatches as __collectPatchesForTests };
export { applyPatches as __applyPatchesForTests };

// Light-weight standalone helpers exported for re-use in store actions /
// notifications projector - both want the same parsing primitives without
// re-importing from projection-helpers.
export { getArtifactsMap, getChatsMap, projectFullState };
