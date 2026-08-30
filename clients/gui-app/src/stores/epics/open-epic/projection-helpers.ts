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
 *        hostId, harnessId, harnessSessionId, workspaceFolders, workspaceMode,
 *     }>>,
 *   }
 */
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { ChatRecordSummary } from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV12 } from "@traycer/protocol/host/epic/tui-agent-records";
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
import {
  projectVisibleRoleClaims,
  roleClaimSchema,
  type RoleClaim,
} from "@traycer/protocol/persistence/epic/role-claims";
import * as Y from "yjs";
import type { PendingMetadataOverlay } from "./pending-metadata-overlay";
import {
  applyPendingOverlayToArtifacts,
  applyPendingOverlayToChats,
  applyPendingOverlayToEpicHeader,
  applyPendingOverlayToTuiAgents,
  collectDeadPendingMutations,
} from "./pending-metadata-overlay";
import type {
  ArtifactProjection,
  AgentRolesSlice,
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
import {
  EMPTY_AGENT_ROLES_SLICE,
  EMPTY_ARRAY,
  EMPTY_PROJECTED_SLICES,
} from "./types";
import { displayTitle } from "@/lib/display-title";
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

export function getRoleClaimsMap(doc: Y.Doc): Y.Map<unknown> | null {
  const value = getEpicMap(doc).get("roleClaims");
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

/**
 * Nullable-number reader for fields whose ABSENCE is meaningful (`archivedAt`),
 * unlike {@link readMaybeNumber}, which floors a missing value to `0`. A record
 * persisted before the field existed must project as `null` ("not archived"),
 * and `0` would read as an epoch-zero archive timestamp instead.
 */
export function readMaybeNullableNumber(
  map: Y.Map<unknown>,
  key: string,
): number | null {
  const value = map.get(key);
  return typeof value === "number" ? value : null;
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
  if (value === "claude" || value === "codex" || value === "opencode") {
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

function readWorkspaceMode(
  map: Y.Map<unknown>,
): "inherit" | "folderless" | undefined {
  const value = map.get("workspaceMode");
  return value === "inherit" || value === "folderless" ? value : undefined;
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
    folderName: readMaybeString(entry, "folderName"),
    parentId: readMaybeNullableString(entry, "parentId"),
    artifactRoomId:
      artifactRoomId !== null && artifactRoomId.length > 0
        ? artifactRoomId
        : null,
    createdAt: readMaybeNumber(entry, "createdAt"),
    updatedAt: readMaybeNumber(entry, "updatedAt"),
    status,
    createdManually: readMaybeBoolean(entry, "createdManually"),
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
    archivedAt: readMaybeNullableNumber(entry, "archivedAt"),
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
  // The host persists settings as a nested Y.Map (`createTypedMap`), so the
  // replicated entry must be serialized before schema validation - zod cannot
  // read fields off a Y.Map and would reject every real record.
  const value = raw instanceof Y.Map ? raw.toJSON() : raw;
  const parsed = chatRunSettingsSchema.safeParse(value);
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
  // synchronously). Codex tolerates null until `thread/started` back-fills.
  if (typeof harnessSessionId !== "string" && harnessId !== "codex") {
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
  const profileId = entry.get("profileId");
  return {
    id,
    // This IS the doc arm - every entry it reads is by definition still
    // pointing at the Y.Doc.
    docResident: true,
    origin: "doc",
    harnessId,
    title: readMaybeString(entry, "title"),
    parentId: readMaybeNullableString(entry, "parentId"),
    createdAt: readMaybeNumber(entry, "createdAt"),
    updatedAt: readMaybeNumber(entry, "updatedAt"),
    userId: readMaybeNullableString(entry, "userId"),
    hostId,
    workspaceFolders: readWorkspaceFolders(entry),
    workspaceMode: readWorkspaceMode(entry),
    model: typeof model === "string" ? model : null,
    reasoningEffort:
      typeof reasoningEffort === "string" ? reasoningEffort : null,
    agentMode,
    archivedAt: readMaybeNullableNumber(entry, "archivedAt"),
    profileId: typeof profileId === "string" ? profileId : null,
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
    a.folderName === b.folderName &&
    a.parentId === b.parentId &&
    a.artifactRoomId === b.artifactRoomId &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.status === b.status &&
    a.createdManually === b.createdManually
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
    a.archivedAt === b.archivedAt &&
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
    profileId: a.profileId === b.profileId,
  } satisfies Record<keyof ChatRunSettings, boolean>;
  return Object.values(fieldsEqual).every((equal) => equal);
}

export function terminalAgentProjectionsEq(
  a: TuiAgentProjection,
  b: TuiAgentProjection,
): boolean {
  const scalarFieldsEqual = [
    a.id === b.id,
    // Adoption flips this with nothing else necessarily changing (the sweep
    // imports a frozen entry verbatim), so omitting it here would freeze the
    // stale routing decision behind the change gate.
    a.docResident === b.docResident,
    // A row can move between planes without any other field changing - an
    // agent this device only replicated and has since adopted reads
    // identically apart from its origin - so omitting it here would freeze
    // every origin-gated affordance on the stale answer.
    a.origin === b.origin,
    a.harnessId === b.harnessId,
    a.title === b.title,
    a.parentId === b.parentId,
    a.createdAt === b.createdAt,
    a.updatedAt === b.updatedAt,
    a.userId === b.userId,
    a.hostId === b.hostId,
    a.workspaceMode === b.workspaceMode,
    a.profileId === b.profileId,
    a.harnessSessionId === b.harnessSessionId,
    a.terminalAgentArgs === b.terminalAgentArgs,
    a.terminalShellCommand === b.terminalShellCommand,
    a.model === b.model,
    a.reasoningEffort === b.reasoningEffort,
    a.agentMode === b.agentMode,
    a.archivedAt === b.archivedAt,
  ].every((fieldEqual) => fieldEqual);

  // Nullability first: `?? []` on both sides would call `null` and `[]`
  // equal, and any identity-preserving consumer (the incremental reconcile,
  // the full-projection stabilizer) would then splice a stale `null` row back
  // over a real `null → []` transition.
  const shellArgsEqual =
    a.terminalShellArgs === null || b.terminalShellArgs === null
      ? a.terminalShellArgs === b.terminalShellArgs
      : arrayShallowEq(a.terminalShellArgs, b.terminalShellArgs);
  return (
    scalarFieldsEqual &&
    shellArgsEqual &&
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

/**
 * One host-served registry row, in the renderer's chat-record shape.
 *
 * ## `settings` is `null`, and that is the row's honest answer
 *
 * The registry carries a settings SUMMARY (the harness id) and not the tuple -
 * see `chat-registry-row.ts` for why a growing settings object has no place in
 * an index that holds every chat at once. Synthesizing a `ChatRunSettings` from
 * a harness id would mean inventing a model, a permission mode and an agent
 * mode this host never said anything about, so a store-only chat reads as
 * "settings not known here" until its own `chat.subscribe` stream supplies
 * them. A chat that ALSO has a frozen doc entry keeps that entry's settings -
 * see {@link unionChatsSlice}.
 *
 * ## `archivedAt` is derived from `archived`, not copied
 *
 * The renderer has exactly one archived-ness carrier - `archivedAt !== null` is
 * the predicate the sidebar, the tree filter, the quote targets and the comm
 * graph all read - while the two sync planes disagree about the TYPE of that
 * fact: the host registry stores a TIMESTAMP, the cloud row stores a BOOLEAN,
 * and a FOREIGN row is a replica of the cloud row. So copying `archivedAt`
 * straight through would read every foreign archived chat as active, which is
 * the one way this projection can silently lie about state rather than merely
 * lack detail. `archived` is the rendering-authoritative field per the
 * contract; the timestamp is display detail, and `updatedAt` stands in when the
 * plane that answered never carried one.
 */
export function chatProjectionFromRecord(
  record: ChatRecordSummary,
): ChatProjection {
  return {
    id: record.chatId,
    title: record.title,
    parentId: record.parentChatId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    userId: record.ownerUserId,
    // Never `null` here, unlike a legacy doc entry: the registry row always
    // names the host that minted the chat.
    hostId: record.originHostId,
    isTitleEditedByUser: record.isTitleEditedByUser,
    settings: null,
    archivedAt: record.archived
      ? (record.archivedAt ?? record.updatedAt)
      : null,
  };
}

/**
 * The host-served rows as a slice.
 *
 * A pure mapping, with no ownership filter: the display boundary for "somebody
 * else's agent" is applied in {@link unionChatsSlice}, at projection time,
 * because that is when the signed-in user is known. Filtering here would freeze
 * the answer at the moment the rows ARRIVED, and a user switch afterwards would
 * re-project the previous user's chats out of a slice that had already been
 * declared safe.
 */
export function chatRecordsSlice(
  records: readonly ChatRecordSummary[],
): ChatsSlice {
  const byId: Record<string, ChatProjection> = {};
  const allIds: string[] = [];
  for (const record of records) {
    const projected = chatProjectionFromRecord(record);
    byId[projected.id] = projected;
    allIds.push(projected.id);
  }
  return { byId, allIds: allIds.length === 0 ? EMPTY_ARRAY : allIds };
}

/**
 * Whether two chat tables say the same thing, entry for entry.
 *
 * The record channel's change gate: a poll that re-serves an unchanged list
 * must not re-project the epic, and reference equality cannot answer that -
 * every response is freshly parsed objects.
 */
export function chatSlicesEq(a: ChatsSlice, b: ChatsSlice): boolean {
  if (a === b) return true;
  if (!arrayShallowEq(a.allIds, b.allIds)) return false;
  return a.allIds.every((id) => chatProjectionsEq(a.byId[id], b.byId[id]));
}

/**
 * The renderer's chat record table: the doc projection UNIONED with the host's
 * store-backed rows.
 *
 * ## Why a union, and who wins
 *
 * The two sources describe the same chats at different ages. Since the
 * single-write pivot NOTHING maintains a doc chat entry: a chat created after
 * the upgrade never gets one, and an existing entry freezes at whatever an
 * earlier build last projected, until the upgrade sweep deletes it outright once
 * publication is proven. The registry row, by contrast, is written by the same
 * commit that decides the fact. So for every field both carry, the ROW wins -
 * not as a tie-break preference but because the doc's copy is a stale mirror by
 * construction.
 *
 * The single exception is `settings`, and it is not a conflict at all: the row
 * does not carry the tuple (only the harness summary), so a frozen doc entry is
 * the only place a client-side settings value can come from. Taking the row's
 * `null` there would DROP a value rather than replace it.
 *
 * ## Identity
 *
 * With no records (doc-only mode - an older host that lacks
 * `epic.listChatRecords`, or a response that has not arrived yet) the doc slice
 * is returned by REFERENCE. That is what makes the union free for every host
 * without the method: the record table, `allIds`, and every downstream slice
 * keep the exact identities the projector produced.
 */
export function unionChatsSlice(
  docChats: ChatsSlice,
  records: ChatsSlice,
  currentUserId: string | null,
): ChatsSlice {
  if (records.allIds.length === 0) return docChats;
  const byId: Record<string, ChatProjection> = { ...docChats.byId };
  const allIds: string[] = [...docChats.allIds];
  for (const id of records.allIds) {
    const record = records.byId[id];
    // The same display filter `projectChatsSlice` applies, applied to the same
    // effect: a host that answered for a DIFFERENT signed-in user (rows in hand
    // when the account switched) must not reach a slice this user reads.
    // Redundant against a correct host - the resolver is viewer-scoped - and a
    // boundary that only holds while the other side behaves is not one.
    //
    // It also has a SECOND job now that the record layer serves FOREIGN rows.
    // A foreign row on another of the viewer's OWN hosts passes here and lands
    // in the table, which is what makes cross-host chats renderable from one
    // read path. A COLLABORATOR's row (task-visibility, a different owner) does
    // not, and must not until this slice is re-keyed: `byId` is keyed on
    // `chatId` ALONE, while a chat is only identified server-side by the triple
    // `(taskId, ownerUserId, chatId)` - two users can legitimately hold the
    // same host-minted `chatId` in one task. Admitting other owners here would
    // collapse two people's chats into one entry. That re-keying is the real
    // precondition for retiring the sidebar's `epic.listCloudChats` arm, which
    // is where collaborators' chats are served from today.
    if (!isChatVisibleToUser(record.userId, currentUserId)) continue;
    if (!Object.hasOwn(byId, id)) {
      byId[id] = record;
      allIds.push(id);
      continue;
    }
    const doc = byId[id];
    const merged: ChatProjection = { ...record, settings: doc.settings };
    // Preserve the previous reference when nothing actually differs, so a chat
    // present in BOTH sources does not churn its `byId` entry on every poll.
    byId[id] = chatProjectionsEq(doc, merged) ? doc : merged;
  }
  return { byId, allIds };
}

/**
 * Whether this build projects an epic-doc replica at all - i.e. whether
 * {@link projectTerminalAgentsSlice} below has a document to read.
 *
 * `true` for as long as the renderer subscribes at `epic.subscribe@1`, which
 * is every build up to and including the one that lands the `@2` client.
 *
 * It is a REQUEST FIELD, not a local detail: `epic.listTuiAgents@1.1` serves
 * the doc-resident remainder only to a caller that declares `false`, because a
 * caller with a replica already holds those entries live and a second
 * poll-stale copy only gives its union a conflict to resolve. The host cannot
 * derive this - `epic.subscribe`'s major is negotiated independently of
 * `epic.listTuiAgents`' minor - so this constant is the whole answer.
 *
 * FLIP IT IN THE SAME CHANGE THAT DELETES THE DOC ARM. Leaving it `true` past
 * that point costs the doc-resident agents their only remaining source (the
 * `@1` behaviour this minor exists to replace); flipping it early costs the
 * duplicate-row conflict. `true` is the safe end of that trade, which is why
 * it is the value that ships until the doc arm is actually gone.
 */
export const GUI_PROJECTS_EPIC_DOC_REPLICA = true;

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

/**
 * The harness discriminator travels as an OPEN string on the wire so a newer
 * host's vendor still parses; this is where the client narrows it to what it
 * can dispatch. Mirrors {@link projectTerminalAgent}'s reject arm
 * (`readHarnessType`): `cursor` - a reserved compatibility value with no
 * runtime surface - and any unknown vendor drop the row rather than reach a
 * tile that could not launch it.
 */
function narrowTuiHarnessId(value: string): TuiHarnessId | null {
  if (value === "claude" || value === "codex" || value === "opencode") {
    return value;
  }
  return null;
}

/**
 * One host-served row, in the renderer's terminal-agent shape, or `null` for a
 * row this build cannot dispatch (unknown/reserved harness).
 *
 * ## Two populations, and only one of them carries a whole record
 *
 * The LOCAL arms (`registry`, `doc`) lack nothing: a terminal agent's resume
 * metadata IS its record, so the row carries everything the doc entry ever did
 * and the union has no doc-supplied exception like the chats' `settings`.
 *
 * The `cloud` arm is a replica of an agent on another of the user's machines,
 * and the cloud metadata projection carries no resume metadata at all. Those
 * fields are filled with the SAME inert values the launch path would have used
 * anyway - an empty workspace list, the `regular` mode launch hardcodes - and
 * `origin` is what tells a consumer they are placeholders. Filling them is not
 * a claim: a replica has no launch path on this machine to mislead, because
 * without a `harnessSessionId` there is nothing to resume and no fork to seed.
 * The affordances that WOULD read them gate on `origin` first.
 *
 * `archivedAt` is derived from `archived`, not copied - same trap, same fix as
 * the chat row: the boolean is the rendering-authoritative field, and
 * `updatedAt` stands in when the plane that answered carried no timestamp.
 */
export function tuiAgentProjectionFromRecord(
  record: TuiAgentRecordSummaryV12,
): TuiAgentProjection | null {
  if (record.origin === "cloud") return cloudReplicaProjection(record);
  const harnessId = narrowTuiHarnessId(record.harnessId);
  if (harnessId === null) return null;
  return {
    id: record.tuiAgentId,
    // Passed through, never assumed false: from `@1.1` the record plane
    // carries BOTH registry rows and the doc-resident remainder, and the host
    // is the only party that can still tell them apart.
    docResident: record.docResident,
    origin: record.origin,
    harnessId,
    title: record.title,
    parentId: record.parentId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    userId: record.ownerUserId,
    hostId: record.hostId,
    workspaceFolders: record.workspaceFolders,
    workspaceMode: record.workspaceMode ?? undefined,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    agentMode: record.agentMode,
    archivedAt: record.archived
      ? (record.archivedAt ?? record.updatedAt)
      : null,
    profileId: record.profileId,
    harnessSessionId: record.harnessSessionId,
    terminalAgentArgs: record.terminalAgentArgs,
    terminalShellCommand: record.terminalShellCommand,
    terminalShellArgs: record.terminalShellArgs,
  };
}

/**
 * A cross-host replica in the renderer's shape.
 *
 * `harnessId` is narrowed exactly as a local row's is, and a replica NAMING a
 * harness this build cannot dispatch is dropped for the same reason: the
 * roster row would open a tile that could not attach.
 *
 * A replica whose cloud row never recorded a harness at all is a different
 * case and is LISTED, with `harnessId: null`. The protocol arm makes the field
 * nullable on purpose - a row written before `runSettingsSummary` carried the
 * harness has none - and says such a row renders without a harness mark. An
 * earlier cut dropped it here, and this comment still described that; the
 * agent then vanished from the roster on every other machine even though the
 * host stored and served it correctly.
 *
 * `docResident: false` is a fact and not a placeholder: a replica is not the
 * doc map's frozen copy, and it IS addressable through the registry
 * affordances - on its OWN host, which is where every mutation aimed at it has
 * to go regardless.
 *
 * ## A row whose cloud record never named a harness is LISTED, not dropped
 *
 * The protocol arm makes `harnessId` nullable on purpose - a cloud row written
 * before `runSettingsSummary` carried the harness has none - and says such a
 * row renders without a harness mark. Returning `null` here instead made the
 * agent vanish from the roster on every other machine, which is the one
 * outcome the contract rules out: the host stores and serves it correctly, and
 * only this projection was losing it.
 *
 * So the projection carries `harnessId: null` through, and the consumers that
 * genuinely need one refuse individually - it cannot be launched, forked or
 * mentioned, because nothing can dispatch a harness nobody named. What it CAN
 * do is appear in the tree, which is the whole of what phase 2 promises for an
 * agent on another machine.
 *
 * A harness this build cannot NARROW is still dropped, and that is a different
 * case: the row named something (a newer vendor), and a tile that could not
 * dispatch it would be a row promising a session this build cannot open.
 */
function cloudReplicaProjection(
  record: Extract<TuiAgentRecordSummaryV12, { origin: "cloud" }>,
): TuiAgentProjection | null {
  const harnessId =
    record.harnessId === null ? null : narrowTuiHarnessId(record.harnessId);
  if (harnessId === null && record.harnessId !== null) return null;
  return {
    id: record.tuiAgentId,
    docResident: false,
    origin: "cloud",
    harnessId,
    title: record.title,
    parentId: record.parentId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    userId: record.ownerUserId,
    hostId: record.hostId,
    // Placeholders - see the header. `origin` is the discriminator that keeps
    // a consumer from reading them as facts about the remote machine.
    workspaceFolders: EMPTY_ARRAY,
    workspaceMode: undefined,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    archivedAt: record.archived ? record.updatedAt : null,
    profileId: null,
    // THE ABSENCE THAT MATTERS. Never crosses the cloud metadata projection,
    // so cloning this agent onto this machine is impossible by construction
    // rather than merely unimplemented.
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
  };
}

/**
 * The host-served terminal-agent rows as a slice. A pure mapping, like
 * {@link chatRecordsSlice}: the ownership filter is the store's ingest
 * (`publishTuiAgentRecords`), applied when the signed-in user is known, so a
 * user switch re-derives the slice from retained rows instead of trusting a
 * selection frozen at arrival time. Undispatchable rows are dropped here.
 */
export function tuiAgentRecordsSlice(
  records: readonly TuiAgentRecordSummaryV12[],
): TerminalAgentsSlice {
  const byId: Record<string, TuiAgentProjection> = {};
  const allIds: string[] = [];
  for (const record of records) {
    const projected = tuiAgentProjectionFromRecord(record);
    if (projected === null) continue;
    byId[projected.id] = projected;
    allIds.push(projected.id);
  }
  return { byId, allIds: allIds.length === 0 ? EMPTY_ARRAY : allIds };
}

/**
 * Whether two terminal-agent tables say the same thing, entry for entry - the
 * terminal twin of {@link chatSlicesEq}, and the record channel's change gate
 * for the same reason: every poll answer is freshly parsed objects.
 */
export function terminalAgentSlicesEq(
  a: TerminalAgentsSlice,
  b: TerminalAgentsSlice,
): boolean {
  if (a === b) return true;
  if (!arrayShallowEq(a.allIds, b.allIds)) return false;
  return a.allIds.every((id) =>
    terminalAgentProjectionsEq(a.byId[id], b.byId[id]),
  );
}

/**
 * The renderer's terminal-agent table: the doc projection UNIONED with the
 * host's registry rows, mirroring {@link unionChatsSlice}.
 *
 * The ROW wins every field it shares with a doc entry - the two sources never
 * overlap for one record on a migrated host (a host new enough to serve
 * `epic.listTuiAgents` has stopped writing the doc map and swept its own
 * entries), so an overlap means the doc's copy is a frozen pre-migration
 * mirror. There is no `settings`-style doc-only field to preserve: the row
 * carries the full record.
 *
 * ## `@1.1` nearly broke that, and record-wins is only safe because it does not
 *
 * `epic.listTuiAgents@1.1` serves the doc-resident remainder as ROWS. Were
 * those rows to reach a client that still projects a doc, the overlap would be
 * DELIBERATE and the premise above would invert: the record is the host's
 * poll-time re-read, while this client's doc entry is the live one it just
 * wrote to. Record-wins would then discard the fresher side, and a reparent of
 * such an agent would snap back to its old parent on the next projection.
 *
 * That cannot happen, and not by luck: the caller declares
 * `hasDocReplica` on the request (see `GUI_PROJECTS_EPIC_DOC_REPLICA`) and the
 * host serves the remainder only when it is `false` - i.e. only to a client
 * with no doc arm for these rows to collide with. Keep that request field
 * honest and record-wins stays correct; set it to `false` while still
 * projecting a doc and this function is where the damage lands.
 *
 * NO display filter here, unlike the chats' union: the host serves the
 * CALLER'S OWN rows only (structurally owner-private, per the contract), and
 * the store's ingest applies `isTerminalAgentVisibleToUser` again when it
 * selects rows for the current user - the doc arm keeps its own filter in
 * `projectTerminalAgentsSlice`/`applyTerminalAgentsSlice`.
 *
 * Identity: with no record rows the doc slice is returned BY REFERENCE (the
 * doc-only mode of an older host is free), and an entry present in both
 * sources keeps its doc reference when nothing differs, so the WeakMap caches
 * keyed on projection identity (`recordForTerminalAgent`) and `pickStableIds`
 * stay stable across polls.
 */
export function unionTerminalAgentsSlice(
  docAgents: TerminalAgentsSlice,
  records: TerminalAgentsSlice,
): TerminalAgentsSlice {
  if (records.allIds.length === 0) return docAgents;
  const byId: Record<string, TuiAgentProjection> = { ...docAgents.byId };
  const allIds: string[] = [...docAgents.allIds];
  for (const id of records.allIds) {
    const record = records.byId[id];
    if (!Object.hasOwn(byId, id)) {
      byId[id] = record;
      allIds.push(id);
      continue;
    }
    const docEntry = byId[id];
    // Preserve the previous reference when nothing actually differs, so an
    // agent present in BOTH sources does not churn its entry on every poll.
    byId[id] = terminalAgentProjectionsEq(docEntry, record) ? docEntry : record;
  }
  return { byId, allIds };
}

function readRoleClaims(doc: Y.Doc): RoleClaim[] {
  const map = getRoleClaimsMap(doc);
  if (map === null) return [];
  const claims: RoleClaim[] = [];
  for (const [claimId, entry] of map.entries()) {
    if (!(entry instanceof Y.Map)) continue;
    const parsed = roleClaimSchema.safeParse(entry.toJSON());
    if (!parsed.success || parsed.data.claimId !== claimId) continue;
    claims.push(parsed.data);
  }
  return claims;
}

export function projectAgentRolesSlice(
  doc: Y.Doc,
  currentUserId: string | null,
  chats: ChatsSlice,
  tuiAgents: TerminalAgentsSlice,
): AgentRolesSlice {
  if (currentUserId === null) return EMPTY_AGENT_ROLES_SLICE;
  const liveAgentIds = new Set([...chats.allIds, ...tuiAgents.allIds]);
  const visibleClaims = projectVisibleRoleClaims(readRoleClaims(doc), {
    userId: currentUserId,
    liveAgentIds,
  });
  if (visibleClaims.length === 0) return EMPTY_AGENT_ROLES_SLICE;
  const claimsByAgentId = new Map<string, RoleClaim[]>();
  for (const claim of visibleClaims) {
    const current = claimsByAgentId.get(claim.agentId);
    if (current === undefined) {
      claimsByAgentId.set(claim.agentId, [claim]);
    } else {
      current.push(claim);
    }
  }
  return { byAgentId: Object.fromEntries(claimsByAgentId) };
}

function projectEpicHeader(doc: Y.Doc): EpicHeader {
  const epic = getEpicMap(doc);
  return {
    title: readMaybeString(epic, "title"),
    updatedAt: readMaybeNumber(epic, "updatedAt"),
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
      // Durable Agent tree row: an untitled Chat-interface Agent falls back to
      // "Untitled agent", not "Untitled chat". `type` stays the structural
      // "chat" interface discriminator.
      title: displayTitle(chat.title, "agent"),
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
      // Durable Agent tree row: an untitled Terminal-interface Agent falls back
      // to "Untitled agent" too (harness identity is separate interface
      // metadata, not the title fallback). `type` stays the interface
      // discriminator.
      title: displayTitle(agent.title, "agent"),
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

/**
 * Everything a projection folds in besides the doc itself.
 *
 * Grouped rather than passed positionally because all three share one
 * property: they arrive on their own schedule and must be read AT projection
 * time, never captured when the session was constructed. The projector holds a
 * lazy getter for each for that reason. (It also keeps `projectFullState`
 * inside the repo's parameter-count limit, which is the same pressure pointing
 * the same way.)
 */
export interface ProjectionInputs {
  /**
   * The host's store-backed chat records (`epic.listChatRecords`). Empty in
   * doc-only mode - an older host, or before the first response - and the union
   * then returns the doc slice itself.
   */
  readonly chatRecords: ChatsSlice;
  /**
   * The host's registry-backed terminal-agent rows (`epic.listTuiAgents`),
   * with exactly the chat records' contract: empty in doc-only mode, and the
   * union then returns the doc slice itself.
   */
  readonly tuiAgentRecords: TerminalAgentsSlice;
  /**
   * Metadata mutations this client has stamped and has no answer for yet.
   * Empty when nothing is in flight, and every applier is then a reference
   * pass-through, so the common case costs nothing.
   */
  readonly pendingOverlay: PendingMetadataOverlay;
  /**
   * Receives the request ids of overlay chains this projection proved
   * finished (`collectDeadPendingMutations`): landed-only chains whose row
   * caught up or was overwritten. The store deletes them from the retained
   * map - without republishing, since a dead chain already displays the
   * authoritative value. `null` for callers with no map to sweep (tests
   * projecting a bare doc).
   */
  readonly reportDeadMutations:
    | ((requestIds: readonly string[]) => void)
    | null;
}

export function projectFullState(
  doc: Y.Doc,
  currentUserId: string | null,
  inputs: ProjectionInputs,
): EpicProjectedSlices {
  const { chatRecords, tuiAgentRecords, pendingOverlay, reportDeadMutations } =
    inputs;
  const artifacts = projectArtifactsSlice(doc);
  const deletedArtifacts = projectDeletedArtifactsSlice(doc);
  const docChats = projectChatsSlice(doc, currentUserId);
  const chats = unionChatsSlice(docChats, chatRecords, currentUserId);
  const docTuiAgents = projectTerminalAgentsSlice(doc, currentUserId);
  const tuiAgents = unionTerminalAgentsSlice(docTuiAgents, tuiAgentRecords);
  const epicHeader = projectEpicHeader(doc);
  // Sweep finished overlay chains against the PRE-overlay values - the only
  // place both the union slices and the overlay are in hand together. Runs
  // before the appliers so a chain proven dead here never patches this
  // projection either (the map mutation the callback performs is visible to
  // nothing else mid-projection; the appliers below read the same `pendingOverlay`
  // reference, which the callback edits in place).
  if (reportDeadMutations !== null && pendingOverlay.size > 0) {
    const dead = collectDeadPendingMutations(pendingOverlay, {
      artifacts,
      chats,
      tuiAgents,
      epicTitle: epicHeader.title,
    });
    if (dead.length > 0) reportDeadMutations(dead);
  }
  const agentRoles = projectAgentRolesSlice(
    doc,
    currentUserId,
    chats,
    tuiAgents,
  );
  // The optimistic overlay lands HERE - on the union outputs components read,
  // and BEFORE the tree is built, so a pending reparent restructures
  // `childrenByParent` / `rootIds` for free instead of needing the tree
  // patched a second time.
  //
  // `docChats` / `docTuiAgents` are deliberately NOT overlaid: they are the
  // projector's own input state, and an incremental doc patch has to reconcile
  // against the doc's history rather than against a display patch.
  const overlaidArtifacts = applyPendingOverlayToArtifacts(
    artifacts,
    pendingOverlay,
  );
  const overlaidChats = applyPendingOverlayToChats(chats, pendingOverlay);
  const overlaidTuiAgents = applyPendingOverlayToTuiAgents(
    tuiAgents,
    pendingOverlay,
  );
  const tree = projectTreeSlice(
    overlaidArtifacts,
    overlaidChats,
    overlaidTuiAgents,
  );
  return {
    epic: applyPendingOverlayToEpicHeader(epicHeader, pendingOverlay),
    artifacts: overlaidArtifacts,
    deletedArtifacts,
    docChats,
    chats: overlaidChats,
    docTuiAgents,
    tuiAgents: overlaidTuiAgents,
    agentRoles,
    tree,
  };
}

// ─── Y.Doc mutation helpers (used by store actions) ───────────────────────

export type AddableArtifactType =
  | "chat"
  | "spec"
  | "ticket"
  | "story"
  | "review";

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
