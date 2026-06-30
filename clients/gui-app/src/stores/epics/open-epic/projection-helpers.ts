/**
 * Pure projection + Y.Doc-mutation helpers shared between the projector
 * and the store's mutation actions. No React, no zustand, no module
 * state - every function takes its inputs explicitly so it can be
 * exhaustively unit-tested.
 *
 * Y.Doc shape this projects from (mirrors the host V200 epic schema):
 *
 *   doc.getMap("epic") = {
 *     title:                    string,
 *     isTitleEditedByUser:      boolean,
 *     artifacts: Y.Map<string, Y.Map<{
 *        id, kind, title, parentId, createdAt, updatedAt,
 *        artifactRoomId?: string, status?: number,
 *     }>>,
 *     chats:     Y.Map<string, Y.Map<{
 *        id, title, parentId, createdAt, updatedAt, userId, ...
 *     }>>,  // messages/blocks live in flat YKeyValue collections; the GUI
 *           // never reads them from the doc (chat.subscribe streams Message[])
 *     tuiAgents: Y.Map<string, Y.Map<{
 *        id, title, parentId, createdAt, updatedAt, userId,
 *        hostId, harnessId, harnessSessionId, workspaceFolders,
 *     }>>,
 *   }
 */
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type {
  AgentMode,
  ChatRunSettings,
  Message,
  TuiHarnessId,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  agentModeSchema,
  chatRunSettingsSchema,
} from "@traycer/protocol/persistence/epic/schemas";
import * as Y from "yjs";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  ChatProjection,
  ChatsSlice,
  DeletedArtifactProjection,
  DeletedArtifactsSlice,
  EpicHeader,
  EpicProjectedSlices,
  EpicTreeNodeType,
  TerminalAgentsSlice,
  TreeNode,
  TreeSlice,
  TuiAgentProjection,
} from "./types";
import { EMPTY_ARRAY, EMPTY_PROJECTED_SLICES } from "./types";
import { displayTitle, tuiAgentDisplayTitle } from "@/lib/display-title";
import { DEFAULT_SORT_MODE, makeNodeComparator } from "@/lib/epic-sort";

// ─── Type-narrow Y.Doc readers ────────────────────────────────────────────

export function getEpicMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("epic");
}

export function getArtifactsMap(doc: Y.Doc): Y.Map<unknown> | null {
  const value = getEpicMap(doc).get("artifacts");
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
}

export function getDeletedArtifactsMap(doc: Y.Doc): Y.Map<unknown> | null {
  const value = getEpicMap(doc).get("deletedArtifacts");
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
}

export function getDeletedArtifactEntry(
  doc: Y.Doc,
  id: string,
): Y.Map<unknown> | null {
  const map = getDeletedArtifactsMap(doc);
  if (map === null) return null;
  const entry = map.get(id);
  return entry instanceof Y.Map ? (entry as Y.Map<unknown>) : null;
}

export function getChatsMap(doc: Y.Doc): Y.Map<unknown> | null {
  const value = getEpicMap(doc).get("chats");
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
}

export function getTerminalAgentsMap(doc: Y.Doc): Y.Map<unknown> | null {
  const value = getEpicMap(doc).get("tuiAgents");
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
}

export function getTerminalAgentEntry(
  doc: Y.Doc,
  id: string,
): Y.Map<unknown> | null {
  const map = getTerminalAgentsMap(doc);
  if (map === null) return null;
  const entry = map.get(id);
  return entry instanceof Y.Map ? (entry as Y.Map<unknown>) : null;
}

export function getArtifactEntry(
  doc: Y.Doc,
  id: string,
): Y.Map<unknown> | null {
  const map = getArtifactsMap(doc);
  if (map === null) return null;
  const entry = map.get(id);
  return entry instanceof Y.Map ? (entry as Y.Map<unknown>) : null;
}

export function getChatEntry(doc: Y.Doc, id: string): Y.Map<unknown> | null {
  const map = getChatsMap(doc);
  if (map === null) return null;
  const entry = map.get(id);
  return entry instanceof Y.Map ? (entry as Y.Map<unknown>) : null;
}

export function readMaybeString(map: Y.Map<unknown>, key: string): string {
  const value = map.get(key);
  return typeof value === "string" ? value : "";
}

export function readMaybeNumber(map: Y.Map<unknown>, key: string): number {
  const value = map.get(key);
  return typeof value === "number" ? value : 0;
}

export function readMaybeBoolean(map: Y.Map<unknown>, key: string): boolean {
  const value = map.get(key);
  return typeof value === "boolean" ? value : false;
}

export function readMaybeNullableString(
  map: Y.Map<unknown>,
  key: string,
): string | null {
  const value = map.get(key);
  return typeof value === "string" ? value : null;
}

export function readArtifactKind(map: Y.Map<unknown>): EpicArtifactKind | null {
  const value = map.get("kind");
  if (
    value === "spec" ||
    value === "ticket" ||
    value === "story" ||
    value === "review"
  ) {
    return value;
  }
  return null;
}

function readHarnessType(map: Y.Map<unknown>): TuiHarnessId | null {
  const value = map.get("harnessId");
  if (
    value === "claude" ||
    value === "codex" ||
    value === "opencode" ||
    value === "cursor"
  ) {
    return value;
  }
  return null;
}

function readWorkspaceFolders(map: Y.Map<unknown>): readonly string[] {
  const value = map.get("workspaceFolders");
  if (value instanceof Y.Array) {
    return (value as Y.Array<unknown>).toArray().filter(isString);
  }
  if (Array.isArray(value)) {
    return value.filter(isString);
  }
  return EMPTY_ARRAY;
}

function readTerminalShellArgs(map: Y.Map<unknown>): readonly string[] | null {
  const value = map.get("terminalShellArgs");
  if (value instanceof Y.Array) {
    return (value as Y.Array<unknown>).toArray().filter(isString);
  }
  if (Array.isArray(value)) {
    return value.filter(isString);
  }
  return null;
}

function readAgentMode(map: Y.Map<unknown>): AgentMode | null {
  const parsed = agentModeSchema.safeParse(map.get("agentMode"));
  return parsed.success ? parsed.data : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

// ─── Per-entry projectors ─────────────────────────────────────────────────

export function projectArtifact(
  id: string,
  entry: Y.Map<unknown>,
): ArtifactProjection | null {
  const kind = readArtifactKind(entry);
  if (kind === null) return null;
  const status =
    kind === "ticket" || kind === "story"
      ? readMaybeNumber(entry, "status")
      : null;
  const artifactRoomId = readMaybeNullableString(entry, "artifactRoomId");
  return {
    id,
    kind,
    title: readMaybeString(entry, "title"),
    parentId: readMaybeNullableString(entry, "parentId"),
    artifactRoomId:
      artifactRoomId !== null && artifactRoomId.length > 0
        ? artifactRoomId
        : null,
    createdAt: readMaybeNumber(entry, "createdAt"),
    updatedAt: readMaybeNumber(entry, "updatedAt"),
    status,
  };
}

export function projectDeletedArtifact(
  id: string,
  entry: Y.Map<unknown>,
): DeletedArtifactProjection | null {
  const kind = readArtifactKind(entry);
  if (kind === null) return null;
  const status =
    kind === "ticket" || kind === "story"
      ? readMaybeNumber(entry, "status")
      : null;
  return {
    id,
    kind,
    title: readMaybeString(entry, "title"),
    deletedAt: readMaybeString(entry, "deletedAt"),
    status,
  };
}

export function projectChat(id: string, entry: Y.Map<unknown>): ChatProjection {
  return {
    id,
    title: readMaybeString(entry, "title"),
    parentId: readMaybeNullableString(entry, "parentId"),
    createdAt: readMaybeNumber(entry, "createdAt"),
    updatedAt: readMaybeNumber(entry, "updatedAt"),
    userId: readMaybeNullableString(entry, "userId"),
    hostId: readMaybeNullableString(entry, "hostId"),
    isTitleEditedByUser: readMaybeBoolean(entry, "isTitleEditedByUser"),
    settings: coerceChatRunSettings(entry.get("settings")),
  };
}

/**
 * Trust the host-written shape (it persists protocol-valid settings) but
 * guard the discriminant so a malformed/absent value projects as `null`
 * rather than a bogus object. Explicitly coerce optional fields that the
 * schema added later (e.g. `serviceTier`) so chats persisted before those
 * fields existed don't leak `undefined` through a `string | null` type -
 * `chatRunSettingsEq` and any downstream `=== null` check would otherwise
 * compare undefined and produce spurious inequality.
 */
function coerceChatRunSettings(raw: unknown): ChatRunSettings | null {
  const parsed = chatRunSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function projectTerminalAgent(
  id: string,
  entry: Y.Map<unknown>,
): TuiAgentProjection | null {
  const harnessId = readHarnessType(entry);
  if (harnessId === null) return null;
  const hostId = entry.get("hostId");
  if (typeof hostId !== "string") return null;
  const harnessSessionId = entry.get("harnessSessionId");
  // Claude/OpenCode require a non-null harness session id (allocated
  // synchronously). Codex tolerates null until `thread/started` back-fills;
  // Cursor tolerates null when `create-chat` minting failed (re-mints on the
  // next launch) rather than persisting a bogus id.
  if (
    typeof harnessSessionId !== "string" &&
    harnessId !== "codex" &&
    harnessId !== "cursor"
  ) {
    return null;
  }
  const model = entry.get("model");
  const reasoningEffort = entry.get("reasoningEffort");
  // Raw durable per-agent override. Preserve strings verbatim - including
  // `""` (explicit "no extra args"). Absent/legacy/non-string values project
  // as `null` ("resolve provider Settings default"). Distinct from the
  // computed `terminalShellArgs`.
  const terminalAgentArgs = entry.get("terminalAgentArgs");
  const terminalShellCommand = entry.get("terminalShellCommand");
  const agentMode = readAgentMode(entry);
  if (agentMode === null) return null;
  return {
    id,
    harnessId,
    title: readMaybeString(entry, "title"),
    parentId: readMaybeNullableString(entry, "parentId"),
    createdAt: readMaybeNumber(entry, "createdAt"),
    updatedAt: readMaybeNumber(entry, "updatedAt"),
    userId: readMaybeNullableString(entry, "userId"),
    hostId,
    workspaceFolders: readWorkspaceFolders(entry),
    model: typeof model === "string" ? model : null,
    reasoningEffort:
      typeof reasoningEffort === "string" ? reasoningEffort : null,
    agentMode,
    harnessSessionId:
      typeof harnessSessionId === "string" ? harnessSessionId : null,
    terminalAgentArgs:
      typeof terminalAgentArgs === "string" ? terminalAgentArgs : null,
    terminalShellCommand:
      typeof terminalShellCommand === "string" ? terminalShellCommand : null,
    terminalShellArgs: readTerminalShellArgs(entry),
  };
}

/**
 * Stable per-row id for the messages slice. Decoupled from the raw
 * `messageId` so user + assistant rows share one keyspace and React keys
 * stay stable across snapshot/delta and the optimistic→real swap:
 *   - user      → `user:<messageId>`
 *   - assistant → `assistant:<turnId>` (fallback `assistant:ts:<ts>:<index>`)
 */
export function messageRowId(message: Message, index: number): string {
  if (message.role === "user") return `user:${message.messageId}`;
  if (message.turnId !== null) return `assistant:${message.turnId}`;
  return `assistant:ts:${message.timestamp}:${index}`;
}

// ─── Equality short-circuits ──────────────────────────────────────────────

export function artifactProjectionsEq(
  a: ArtifactProjection,
  b: ArtifactProjection,
): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.title === b.title &&
    a.parentId === b.parentId &&
    a.artifactRoomId === b.artifactRoomId &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.status === b.status
  );
}

export function deletedArtifactProjectionsEq(
  a: DeletedArtifactProjection,
  b: DeletedArtifactProjection,
): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.title === b.title &&
    a.deletedAt === b.deletedAt &&
    a.status === b.status
  );
}

export function chatProjectionsEq(
  a: ChatProjection,
  b: ChatProjection,
): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.parentId === b.parentId &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.userId === b.userId &&
    a.hostId === b.hostId &&
    a.isTitleEditedByUser === b.isTitleEditedByUser &&
    chatRunSettingsEq(a.settings, b.settings)
  );
}

function chatRunSettingsEq(
  a: ChatRunSettings | null,
  b: ChatRunSettings | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  // Keyed by every `ChatRunSettings` field via `satisfies`: adding a field to
  // the type forces an entry here (compile error otherwise), so the comparison
  // can't silently ignore a new field.
  const fieldsEqual = {
    harnessId: a.harnessId === b.harnessId,
    model: a.model === b.model,
    permissionMode: a.permissionMode === b.permissionMode,
    reasoningEffort: a.reasoningEffort === b.reasoningEffort,
    serviceTier: a.serviceTier === b.serviceTier,
    agentMode: a.agentMode === b.agentMode,
  } satisfies Record<keyof ChatRunSettings, boolean>;
  return Object.values(fieldsEqual).every((equal) => equal);
}

export function terminalAgentProjectionsEq(
  a: TuiAgentProjection,
  b: TuiAgentProjection,
): boolean {
  const scalarFieldsEqual = [
    a.id === b.id,
    a.harnessId === b.harnessId,
    a.title === b.title,
    a.parentId === b.parentId,
    a.createdAt === b.createdAt,
    a.updatedAt === b.updatedAt,
    a.userId === b.userId,
    a.hostId === b.hostId,
    a.harnessSessionId === b.harnessSessionId,
    a.terminalAgentArgs === b.terminalAgentArgs,
    a.terminalShellCommand === b.terminalShellCommand,
    a.model === b.model,
    a.reasoningEffort === b.reasoningEffort,
    a.agentMode === b.agentMode,
  ].every((fieldEqual) => fieldEqual);

  return (
    scalarFieldsEqual &&
    arrayShallowEq(a.terminalShellArgs ?? [], b.terminalShellArgs ?? []) &&
    arrayShallowEq(a.workspaceFolders, b.workspaceFolders)
  );
}

export function treeNodesEq(a: TreeNode, b: TreeNode): boolean {
  return (
    a.id === b.id &&
    a.parentId === b.parentId &&
    a.title === b.title &&
    a.type === b.type &&
    a.status === b.status &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt
  );
}

export function arrayShallowEq<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── Slice builders (full-doc sweep) ──────────────────────────────────────

// Full-doc sweep of a `byId`/`allIds` map slice (live artifacts, deleted-
// artifact tombstones): project every live `Y.Map` child, drop nulls, and
// collapse an empty result to the shared `EMPTY_ARRAY` so identity stays stable.
function projectMapSlice<T>(
  doc: Y.Doc,
  resolveMap: (doc: Y.Doc) => Y.Map<unknown> | null,
  project: (id: string, entry: Y.Map<unknown>) => T | null,
  emptySlice: {
    readonly byId: Readonly<Record<string, T>>;
    readonly allIds: readonly string[];
  },
): {
  readonly byId: Readonly<Record<string, T>>;
  readonly allIds: readonly string[];
} {
  const map = resolveMap(doc);
  if (map === null) return emptySlice;
  const byId: Record<string, T> = {};
  const allIds: string[] = [];
  for (const [id, entry] of map.entries()) {
    if (!(entry instanceof Y.Map)) continue;
    const projected = project(id, entry as Y.Map<unknown>);
    if (projected === null) continue;
    byId[id] = projected;
    allIds.push(id);
  }
  return { byId, allIds: allIds.length === 0 ? EMPTY_ARRAY : allIds };
}

function projectArtifactsSlice(doc: Y.Doc): ArtifactsSlice {
  return projectMapSlice(
    doc,
    getArtifactsMap,
    projectArtifact,
    EMPTY_PROJECTED_SLICES.artifacts,
  );
}

function projectDeletedArtifactsSlice(doc: Y.Doc): DeletedArtifactsSlice {
  return projectMapSlice(
    doc,
    getDeletedArtifactsMap,
    projectDeletedArtifact,
    EMPTY_PROJECTED_SLICES.deletedArtifacts,
  );
}

/**
 * Chats and terminal agents are private to their owners. The shared epic Y.Doc
 * carries every collaborator's records, so the projector is the chokepoint that
 * keeps another user's agents out of every downstream slice.
 *
 * Fail open when ownership is unknown so a user never loses sight of their own
 * work: a record with no `userId` yet or an unauthenticated/hydrating session
 * (`currentUserId === null`) stays visible. Only a record KNOWN to belong to a
 * different user is hidden. Host owner gates are the hard privacy boundary;
 * this is the display filter.
 */
function isOwnedRecordVisibleToUser(
  ownerUserId: string | null,
  currentUserId: string | null,
): boolean {
  if (currentUserId === null) return true;
  if (ownerUserId === null) return true;
  return ownerUserId === currentUserId;
}

export function isChatVisibleToUser(
  chatUserId: string | null,
  currentUserId: string | null,
): boolean {
  return isOwnedRecordVisibleToUser(chatUserId, currentUserId);
}

export function isTerminalAgentVisibleToUser(
  agentUserId: string | null,
  currentUserId: string | null,
): boolean {
  return isOwnedRecordVisibleToUser(agentUserId, currentUserId);
}

function projectChatsSlice(
  doc: Y.Doc,
  currentUserId: string | null,
): ChatsSlice {
  const map = getChatsMap(doc);
  if (map === null) {
    return EMPTY_PROJECTED_SLICES.chats;
  }
  const byId: Record<string, ChatProjection> = {};
  const allIds: string[] = [];
  for (const [id, entry] of map.entries()) {
    if (!(entry instanceof Y.Map)) continue;
    const projected = projectChat(id, entry as Y.Map<unknown>);
    if (!isChatVisibleToUser(projected.userId, currentUserId)) continue;
    byId[id] = projected;
    allIds.push(id);
  }
  return {
    byId,
    allIds: allIds.length === 0 ? EMPTY_ARRAY : allIds,
  };
}

function projectTerminalAgentsSlice(
  doc: Y.Doc,
  currentUserId: string | null,
): TerminalAgentsSlice {
  const map = getTerminalAgentsMap(doc);
  if (map === null) {
    return EMPTY_PROJECTED_SLICES.tuiAgents;
  }
  const byId: Record<string, TuiAgentProjection> = {};
  const allIds: string[] = [];
  for (const [id, entry] of map.entries()) {
    if (!(entry instanceof Y.Map)) continue;
    const projected = projectTerminalAgent(id, entry as Y.Map<unknown>);
    if (projected === null) continue;
    if (!isTerminalAgentVisibleToUser(projected.userId, currentUserId)) {
      continue;
    }
    byId[id] = projected;
    allIds.push(id);
  }
  return {
    byId,
    allIds: allIds.length === 0 ? EMPTY_ARRAY : allIds,
  };
}

function projectEpicHeader(doc: Y.Doc): EpicHeader {
  const epic = getEpicMap(doc);
  return {
    title: readMaybeString(epic, "title"),
    updatedAt: readMaybeNumber(epic, "updatedAt"),
    isTitleEditedByUser: readMaybeBoolean(epic, "isTitleEditedByUser"),
  };
}

// ─── Tree slice (composed from artifacts + chats) ─────────────────────────

interface RawTreeRecord {
  readonly id: string;
  readonly parentIdRaw: string | null;
  readonly title: string;
  readonly type: EpicTreeNodeType;
  readonly status: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function collectRawTreeRecords(
  artifacts: ArtifactsSlice,
  chats: ChatsSlice,
  tuiAgents: TerminalAgentsSlice,
): ReadonlyArray<RawTreeRecord> {
  const out: RawTreeRecord[] = [];
  for (const id of chats.allIds) {
    const chat = chats.byId[id];
    out.push({
      id,
      parentIdRaw: chat.parentId,
      title: displayTitle(chat.title, "chat"),
      type: "chat",
      status: null,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    });
  }
  for (const id of tuiAgents.allIds) {
    const agent = tuiAgents.byId[id];
    out.push({
      id,
      parentIdRaw: agent.parentId,
      title: tuiAgentDisplayTitle({
        title: agent.title,
        harnessId: agent.harnessId,
      }),
      type: "terminal-agent",
      status: null,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    });
  }
  for (const id of artifacts.allIds) {
    const artifact = artifacts.byId[id];
    out.push({
      id,
      parentIdRaw: artifact.parentId,
      title: displayTitle(artifact.title, artifact.kind),
      type: artifact.kind,
      status: artifact.status,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    });
  }
  return out;
}

/**
 * Resolve `parentIdRaw` to its effective parent in the rendered tree.
 *
 * Two parent-child families coexist in the same `TreeSlice`:
 *   - **Artifact tree** - `spec`/`ticket`/`story`/`review` nest under
 *     other artifacts (folder structure). Artifacts NEVER nest under a
 *     chat or terminal-agent.
 *   - **Agent tree** - `chat` and `terminal-agent` nest under another
 *     chat or terminal-agent: `agent.create` sets the new agent's
 *     `parentId` to its sender, so a child agent surfaces under the
 *     agent that spawned it. Agents NEVER nest under an artifact.
 *
 * Resolution rules:
 *   - `null` → `null` (root)
 *   - unknown id → `null` (orphan promotion - e.g. stale `parentId`
 *     after the parent was deleted)
 *   - cross-family pairing (artifact ↔ agent in either direction) →
 *     `null` (orphan promotion)
 *   - same-family pairing → keep `rawParentId`
 */
function resolveEffectiveParent(
  rawParentId: string | null,
  childType: EpicTreeNodeType,
  byId: ReadonlyMap<string, RawTreeRecord>,
): string | null {
  if (rawParentId === null) return null;
  const parent = byId.get(rawParentId);
  if (parent === undefined) return null;
  const childIsAgent = childType === "chat" || childType === "terminal-agent";
  const parentIsAgent =
    parent.type === "chat" || parent.type === "terminal-agent";
  return childIsAgent === parentIsAgent ? rawParentId : null;
}

// Canonical projector order = the sidebar's default sort (most recent
// activity first). Sharing `DEFAULT_SORT_MODE` keeps this in lockstep with
// the presentation-layer re-sort, so the default case is a genuine no-op
// downstream (`sortNodeIds` with a null comparator returns ids untouched).
const compareNodes = makeNodeComparator(DEFAULT_SORT_MODE);

export function projectTreeSlice(
  artifacts: ArtifactsSlice,
  chats: ChatsSlice,
  tuiAgents: TerminalAgentsSlice,
): TreeSlice {
  const raw = collectRawTreeRecords(artifacts, chats, tuiAgents);
  if (raw.length === 0) {
    return EMPTY_PROJECTED_SLICES.tree;
  }
  const rawById = new Map<string, RawTreeRecord>();
  for (const r of raw) rawById.set(r.id, r);

  const nodeById: Record<string, TreeNode> = {};
  for (const r of raw) {
    const parentId = resolveEffectiveParent(r.parentIdRaw, r.type, rawById);
    nodeById[r.id] = {
      id: r.id,
      parentId,
      title: r.title,
      type: r.type,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  const buckets = new Map<string | null, TreeNode[]>();
  for (const id of Object.keys(nodeById)) {
    const node = nodeById[id];
    const bucket = buckets.get(node.parentId);
    if (bucket === undefined) {
      buckets.set(node.parentId, [node]);
    } else {
      bucket.push(node);
    }
  }

  const childrenByParent: Record<string, readonly string[]> = {};
  let rootIds: readonly string[] = EMPTY_ARRAY;
  for (const [parentId, nodes] of buckets.entries()) {
    nodes.sort(compareNodes);
    const ids = nodes.map((n) => n.id);
    if (parentId === null) {
      rootIds = ids;
    } else {
      childrenByParent[parentId] = ids;
    }
  }

  return { rootIds, childrenByParent, nodeById };
}

// ─── Full-doc projection (snapshot + initial attach) ──────────────────────

export function projectFullState(
  doc: Y.Doc,
  currentUserId: string | null,
): EpicProjectedSlices {
  const artifacts = projectArtifactsSlice(doc);
  const deletedArtifacts = projectDeletedArtifactsSlice(doc);
  const chats = projectChatsSlice(doc, currentUserId);
  const tuiAgents = projectTerminalAgentsSlice(doc, currentUserId);
  const tree = projectTreeSlice(artifacts, chats, tuiAgents);
  const contentRevByArtifactId: Record<string, number> = {};
  for (const id of artifacts.allIds) {
    contentRevByArtifactId[id] = 0;
  }
  return {
    epic: projectEpicHeader(doc),
    artifacts,
    deletedArtifacts,
    chats,
    tuiAgents,
    tree,
    contentRevByArtifactId,
  };
}

// ─── Y.Doc mutation helpers (used by store actions) ───────────────────────

export type AddableArtifactType =
  "chat" | "spec" | "ticket" | "story" | "review";

export const NEW_ARTIFACT_TITLES: Readonly<
  Record<AddableArtifactType, string>
> = {
  chat: "New chat",
  spec: "New spec",
  ticket: "New ticket",
  story: "New story",
  review: "New review",
};

export function ensureMap(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
  const existing = parent.get(key);
  if (existing instanceof Y.Map) return existing as Y.Map<unknown>;
  const next = new Y.Map<unknown>();
  parent.set(key, next);
  return next;
}
