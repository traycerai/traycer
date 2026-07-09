/**
 * Projected slices owned by `OpenEpicStore` and produced by
 * `epic-projector.ts` from the per-Epic Y.Doc.
 *
 * Identity contract:
 *   - Every entry under a `byId` table only changes its `===` reference
 *     when one of its projected fields changes. Rewriting an unrelated
 *     entry leaves siblings untouched, so `useEpicStore(s => s.x.byId[id])`
 *     skips the render when nothing changed for that id.
 *   - `allIds` / `idsByChatId` / `childrenByParent[parent]` arrays only
 *     change reference when set membership or order changes. Title /
 *     status / content edits that don't move a node leave the array
 *     reference identical.
 *
 * The projector is the only writer into these slices. Components MUST
 * NOT reach into the Y.Doc directly except through
 * `OpenEpicState.getArtifactFragment(id)` - the editor escape hatch.
 */
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type {
  AgentMode,
  ChatRunSettings,
  TuiHarnessId,
} from "@traycer/protocol/persistence/epic/schemas";
import type { WorktreeBindingWorkspaceMode } from "@traycer/protocol/host/worktree-schemas";

export type EpicTreeNodeType = "chat" | "terminal-agent" | EpicArtifactKind;

export interface ArtifactProjection {
  readonly id: string;
  readonly kind: EpicArtifactKind;
  readonly title: string;
  readonly parentId: string | null;
  readonly artifactRoomId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Status numeric code (0=Todo, 1=InProgress, 2=Done). Null for spec/review. */
  readonly status: number | null;
  /**
   * True for artifacts the user created by hand (host `epic.createArtifact`
   * RPC or a file authored directly on disk), false for agent-created ones.
   * Gates hand-authoring affordances like the doc-title → artifact-title
   * follow in the collab editor.
   */
  readonly createdManually: boolean;
}

export interface ArtifactsSlice {
  readonly byId: Readonly<Record<string, ArtifactProjection>>;
  readonly allIds: readonly string[];
}

/**
 * A deleted-artifact tombstone, projected from `epic.deletedArtifacts`. The
 * host writes one of these when an artifact is removed; it retains the kind,
 * title, and (for ticket/story) last status so the chat's `artifact_operation`
 * delete card can render a strikethrough label + deletion info after the live
 * artifact entry is gone. `deletedAt` is the ISO timestamp the host stamped.
 */
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
   * Host hosting this chat. `null` for legacy chats that predate the
   * field and for the optimistic overlay (where the active host is the
   * implied host). Real projections carry the persisted `Chat.hostId`.
   */
  readonly hostId: string | null;
  readonly isTitleEditedByUser: boolean;
  /** Persisted run settings (harness/model/permission). `null` until set. */
  readonly settings: ChatRunSettings | null;
}

export interface ChatsSlice {
  readonly byId: Readonly<Record<string, ChatProjection>>;
  readonly allIds: readonly string[];
}

/**
 * Projected representation of an `epic.tuiAgents[id]` Y.Map entry.
 * Mirrors `TuiAgent` from the persistence registry but keeps the fields
 * the renderer needs to surface a tile + cascade them into the tree slice.
 */
export interface TuiAgentProjection {
  readonly id: string;
  readonly harnessId: TuiHarnessId;
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
   * Upstream harness's CLI-resumable id. Always non-null for Claude/OpenCode;
   * `null` for Codex until `thread/started` back-fills the saved-session id.
   */
  readonly harnessSessionId: string | null;
  /**
   * Raw durable per-agent CLI args override (source of truth for relaunch).
   * `null` for legacy/absent records and untouched Settings-prefilled values
   * ("resolve provider Settings default"); `""` is an explicit "no extra
   * args" override; a non-empty string is a durable override. Distinct from
   * the computed `terminalShellArgs` below, which is cached launch output.
   */
  readonly terminalAgentArgs: string | null;
  readonly terminalShellCommand: string | null;
  readonly terminalShellArgs: readonly string[] | null;
}

export interface TerminalAgentsSlice {
  readonly byId: Readonly<Record<string, TuiAgentProjection>>;
  readonly allIds: readonly string[];
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
  readonly isTitleEditedByUser: boolean;
}

/**
 * Per-artifact-room availability mirrored from the host's artifact-room manager via
 * `epic.subscribe@1.0` `artifactRoomState` frames. The GUI uses this to render
 * affected artifact bodies as unavailable/retrying without losing root
 * metadata. ArtifactRooms not present in this record are implicitly `unavailable`.
 */
export type EpicArtifactRoomAvailability = "ready" | "unavailable" | "retrying";

export interface ArtifactRoomsSlice {
  readonly stateByArtifactRoomId: Readonly<
    Record<string, EpicArtifactRoomAvailability>
  >;
}

/**
 * Single projected snapshot of the entire Epic Y.Doc. Returned by
 * `projectFullState` on attach and on every `onSnapshot` so the store
 * can apply it as one atomic `setState` (no per-slice flicker).
 */
export interface EpicProjectedSlices {
  readonly epic: EpicHeader;
  readonly artifacts: ArtifactsSlice;
  readonly deletedArtifacts: DeletedArtifactsSlice;
  readonly chats: ChatsSlice;
  readonly tuiAgents: TerminalAgentsSlice;
  readonly tree: TreeSlice;
  readonly contentRevByArtifactId: Readonly<Record<string, number>>;
}

export const EMPTY_ARRAY: readonly string[] = Object.freeze([]);

export const EMPTY_ARTIFACT_ROOMS_SLICE: ArtifactRoomsSlice = Object.freeze({
  stateByArtifactRoomId: Object.freeze(
    {} as Record<string, EpicArtifactRoomAvailability>,
  ),
});

export const EMPTY_PROJECTED_SLICES: EpicProjectedSlices = Object.freeze({
  epic: Object.freeze({
    title: "",
    updatedAt: 0,
    isTitleEditedByUser: false,
  }),
  artifacts: Object.freeze({
    byId: Object.freeze({} as Record<string, ArtifactProjection>),
    allIds: EMPTY_ARRAY,
  }),
  deletedArtifacts: Object.freeze({
    byId: Object.freeze({} as Record<string, DeletedArtifactProjection>),
    allIds: EMPTY_ARRAY,
  }),
  chats: Object.freeze({
    byId: Object.freeze({} as Record<string, ChatProjection>),
    allIds: EMPTY_ARRAY,
  }),
  tuiAgents: Object.freeze({
    byId: Object.freeze({} as Record<string, TuiAgentProjection>),
    allIds: EMPTY_ARRAY,
  }),
  tree: Object.freeze({
    rootIds: EMPTY_ARRAY,
    childrenByParent: Object.freeze({} as Record<string, readonly string[]>),
    nodeById: Object.freeze({} as Record<string, TreeNode>),
  }),
  contentRevByArtifactId: Object.freeze({} as Record<string, number>),
});
