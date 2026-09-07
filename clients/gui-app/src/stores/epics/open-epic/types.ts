/**
 * Projected slices owned by `OpenEpicStore` and produced by `epic-projector.ts` from the per-Epic
 * Y.Doc. Identity contract:
 */
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type {
  AgentMode,
  ChatRunSettings,
  TuiHarnessId,
} from "@traycer/protocol/persistence/epic/schemas";
import type { WorktreeBindingWorkspaceMode } from "@traycer/protocol/host/worktree-schemas";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import type { ChatRecordSummary } from "@traycer/protocol/host/epic/chat-records";

export type EpicTreeNodeType = "chat" | "terminal-agent" | EpicArtifactKind;

export interface ArtifactProjection {
  readonly id: string;
  readonly kind: EpicArtifactKind;
  readonly title: string;
  /**
   * On-disk folder name for this artifact's `index.md` (its own directory under
   * `epics/<epicId>/artifacts/...`, distinct from `title`, which the user can rename freely
   */
  readonly folderName: string;
  readonly parentId: string | null;
  readonly artifactRoomId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Status numeric code (0=Todo, 1=InProgress, 2=Done). Null for spec/review. */
  readonly status: number | null;
  /**
   * True for artifacts the user created by hand (host `epic.createArtifact` RPC or a file authored
   * directly on disk), false for agent-created ones.
   */
  readonly createdManually: boolean;
}

export interface ArtifactsSlice {
  readonly byId: Readonly<Record<string, ArtifactProjection>>;
  readonly allIds: readonly string[];
}

/** A deleted-artifact tombstone, projected from `epic.deletedArtifacts`. */
export interface DeletedArtifactProjection {
  readonly id: string;
  readonly kind: EpicArtifactKind;
  readonly title: string;
  readonly deletedAt: string;
  /** Last known status (0=Todo, 1=InProgress, 2=Done). Null for spec/review. */
  readonly status: number | null;
}

export interface DeletedArtifactsSlice {
  readonly byId: Readonly<Record<string, DeletedArtifactProjection>>;
  readonly allIds: readonly string[];
}

export interface ChatProjection {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly userId: string | null;
  /**
   * Host hosting this chat. `null` for legacy chats that predate the field and for the optimistic
   * overlay (where the active host is the implied host).
   */
  readonly hostId: string | null;
  readonly isTitleEditedByUser: boolean;
  readonly docResident: boolean | null;
  /** Persisted run settings (harness/model/permission). `null` until set. */
  readonly settings: ChatRunSettings | null;
  /** Host-backed archive flag (`epic.setChatArchived`). `null` = active. */
  readonly archivedAt: number | null;
}

export interface ChatsSlice {
  readonly byId: Readonly<Record<string, ChatProjection>>;
  readonly allIds: readonly string[];
}

/**
 * One chat record as the CLIENT holds it: the wire row plus the home the plane that delivered it
 * stated.
 */
export interface HeldChatRecordRow extends ChatRecordSummary {
  readonly docResident: boolean | null;
}

/** Projected representation of an `epic.tuiAgents[id]` Y.Map entry. */
/**
 * The three planes a terminal-agent row can reach this renderer from, mirroring
 * `epic.listTuiAgents@1.2`'s `origin`. See {@link TuiAgentProjection.origin}.
 */
export type TuiAgentProjectionOrigin = "registry" | "doc" | "cloud";

export interface TuiAgentProjection {
  readonly id: string;
  readonly docResident: boolean;
  /**
   * WHICH PLANE this agent's row came from, and therefore how much of the projection below is real.
   * `registry` and `doc` are LOCAL to the host serving this epic and carry the whole record.
   */
  readonly origin: TuiAgentProjectionOrigin;
  readonly harnessId: TuiHarnessId | null;
  readonly title: string;
  readonly parentId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly userId: string | null;
  readonly hostId: string;
  readonly workspaceFolders: readonly string[];
  readonly workspaceMode: WorktreeBindingWorkspaceMode | undefined;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly agentMode: AgentMode;
  /**
   * Host-backed archive flag, the terminal-agent twin of {@link ChatProjection.archivedAt} - one
   * `epic.setChatArchived` RPC keyed by id covers both record kinds, so the sidebar treats them
   */
  readonly archivedAt: number | null;
  /**
   * Which of the harness's logged-in profiles (subscriptions) this agent runs on. `null` = the
   * ambient/host login, so agents persisted before profiles existed still project cleanly.
   */
  readonly profileId: string | null;
  /**
   * Upstream harness's CLI-resumable id. Always non-null for Claude/OpenCode;
   * `null` for Codex until `thread/started` back-fills the saved-session id.
   */
  readonly harnessSessionId: string | null;
  /** Raw durable per-agent CLI args override (source of truth for relaunch). */
  readonly terminalAgentArgs: string | null;
  readonly terminalShellCommand: string | null;
  readonly terminalShellArgs: readonly string[] | null;
}

export interface TerminalAgentsSlice {
  readonly byId: Readonly<Record<string, TuiAgentProjection>>;
  readonly allIds: readonly string[];
}

export interface AgentRolesSlice {
  readonly byAgentId: Readonly<Record<string, readonly RoleClaim[]>>;
}

/** Comment threads as the records lane serves them, grouped by artifact. */
export interface CommentThreadsSlice {
  readonly byArtifactId: Readonly<Record<string, readonly CommentThreadWire[]>>;
}

export interface TreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly type: EpicTreeNodeType;
  readonly status: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TreeSlice {
  readonly rootIds: readonly string[];
  readonly childrenByParent: Readonly<Record<string, readonly string[]>>;
  readonly nodeById: Readonly<Record<string, TreeNode>>;
}

export interface EpicHeader {
  readonly title: string;
  readonly updatedAt: number;
}

/**
 * Whether an artifact's BODY is being served. Mirrored from the host's artifact-room manager on
 * `epic.subscribe@1.0`, and from `artifact.subscribe`'s ready/unavailable pair on the lane arm.
 */
export type EpicArtifactRoomAvailability = "ready" | "unavailable" | "retrying";

/** Availability keyed by ARTIFACT id, on both arms. */
export interface ArtifactRoomsSlice {
  readonly stateByArtifactId: Readonly<
    Record<string, EpicArtifactRoomAvailability>
  >;
}

/**
 * Single projected snapshot of the entire Epic Y.Doc. Returned by `projectFullState` on attach and
 * on every `onSnapshot` so the store can apply it as one atomic `setState` (no per-slice flicker).
 */
export interface EpicProjectedSlices {
  readonly epic: EpicHeader;
  readonly artifacts: ArtifactsSlice;
  readonly deletedArtifacts: DeletedArtifactsSlice;
  /** The Y.Doc's own chat entries, before the host's store-backed records are folded in. */
  readonly docChats: ChatsSlice;
  /** Doc entries unioned with the host's records. Components read THIS. */
  readonly chats: ChatsSlice;
  /**
   * The Y.Doc's own terminal-agent entries, before the host's registry rows (`epic.listTuiAgents`)
   * are folded in - the terminal-agent twin of {@link EpicProjectedSlices.docChats}, kept separate
   */
  readonly docTuiAgents: TerminalAgentsSlice;
  /** Doc entries unioned with the host's registry rows. Components read THIS. */
  readonly tuiAgents: TerminalAgentsSlice;
  readonly agentRoles: AgentRolesSlice;
  readonly tree: TreeSlice;
}

export const EMPTY_ARRAY: readonly string[] = Object.freeze([]);

export const EMPTY_ARTIFACT_ROOMS_SLICE: ArtifactRoomsSlice = Object.freeze({
  stateByArtifactId: Object.freeze(
    {} as Record<string, EpicArtifactRoomAvailability>,
  ),
});

/** Starting value for the per-artifact-room host-dirty mirror. */
export const EMPTY_ARTIFACT_ROOM_DIRTY: Readonly<Record<string, boolean>> =
  Object.freeze({} as Record<string, boolean>);

/**
 * The empty chat table, shared by the doc slice, the record slice and the union so "nothing here"
 * is one reference everywhere - a fresh empty object per source would make every downstream
 */
export const EMPTY_CHATS_SLICE: ChatsSlice = Object.freeze({
  byId: Object.freeze({} as Record<string, ChatProjection>),
  allIds: EMPTY_ARRAY,
});

/**
 * The empty terminal-agent table, shared by the doc slice, the record slice
 * and the union for the same identity reason as {@link EMPTY_CHATS_SLICE}.
 */
export const EMPTY_TERMINAL_AGENTS_SLICE: TerminalAgentsSlice = Object.freeze({
  byId: Object.freeze({} as Record<string, TuiAgentProjection>),
  allIds: EMPTY_ARRAY,
});

export const EMPTY_AGENT_ROLES_SLICE: AgentRolesSlice = Object.freeze({
  byAgentId: Object.freeze({} as Record<string, readonly RoleClaim[]>),
});

/**
 * "Nothing said about any artifact's threads" - the pre-lane state, and the state of every legacy
 * connection, whose comment threads still come from the poll.
 */
export const EMPTY_COMMENT_THREADS_SLICE: CommentThreadsSlice = Object.freeze({
  byArtifactId: Object.freeze(
    {} as Record<string, readonly CommentThreadWire[]>,
  ),
});

export const EMPTY_PROJECTED_SLICES: EpicProjectedSlices = Object.freeze({
  epic: Object.freeze({
    title: "",
    updatedAt: 0,
  }),
  artifacts: Object.freeze({
    byId: Object.freeze({} as Record<string, ArtifactProjection>),
    allIds: EMPTY_ARRAY,
  }),
  deletedArtifacts: Object.freeze({
    byId: Object.freeze({} as Record<string, DeletedArtifactProjection>),
    allIds: EMPTY_ARRAY,
  }),
  docChats: EMPTY_CHATS_SLICE,
  chats: EMPTY_CHATS_SLICE,
  docTuiAgents: EMPTY_TERMINAL_AGENTS_SLICE,
  tuiAgents: EMPTY_TERMINAL_AGENTS_SLICE,
  agentRoles: EMPTY_AGENT_ROLES_SLICE,
  tree: Object.freeze({
    rootIds: EMPTY_ARRAY,
    childrenByParent: Object.freeze({} as Record<string, readonly string[]>),
    nodeById: Object.freeze({} as Record<string, TreeNode>),
  }),
});
