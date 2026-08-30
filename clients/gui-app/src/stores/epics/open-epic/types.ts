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
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";

export type EpicTreeNodeType = "chat" | "terminal-agent" | EpicArtifactKind;

export interface ArtifactProjection {
  readonly id: string;
  readonly kind: EpicArtifactKind;
  readonly title: string;
  /**
   * On-disk folder name for this artifact's `index.md` (its own directory
   * under `epics/<epicId>/artifacts/...`, distinct from `title`, which the
   * user can rename freely afterward). Empty string for a legacy/malformed
   * entry that predates the field. Root-to-leaf folder names walked via
   * `parentId` reconstruct an artifact-shaped path for a relative markdown
   * link authored inside this artifact - see `artifact-folder-chain.ts`.
   */
  readonly folderName: string;
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
  /**
   * Host-backed archive flag (`epic.setChatArchived`). `null` = active. The
   * sidebar applies the selected archive visibility to this timestamp. Records
   * written before the field existed project as `null`, so pre-archive chats
   * read as active.
   */
  readonly archivedAt: number | null;
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
/**
 * The three planes a terminal-agent row can reach this renderer from, mirroring
 * `epic.listTuiAgents@1.2`'s `origin`. See {@link TuiAgentProjection.origin}.
 */
export type TuiAgentProjectionOrigin = "registry" | "doc" | "cloud";

export interface TuiAgentProjection {
  readonly id: string;
  /**
   * Whether this agent's parent pointer still lives in the epic Y.Doc rather
   * than on the host's record plane - the routing fact `isDocOnlyTerminalAgent`
   * needs, carried on the agent instead of inferred from which slice produced
   * it.
   *
   * Inference used to be sound: the doc arm meant doc, the record arm meant
   * registry. `epic.listTuiAgents@1.1` broke that by serving the doc-resident
   * remainder AS records (an agent bound to an un-upgraded peer host), and
   * `epic.subscribe@2` finishes the job by removing the doc arm entirely - at
   * which point "which slice was it in" has no answer at all and every agent
   * looks registry-backed. Routing one of these to `epic.reparentChat` names
   * no registry chat and fails host-side.
   */
  readonly docResident: boolean;
  /**
   * WHICH PLANE this agent's row came from, and therefore how much of the
   * projection below is real.
   *
   * `registry` and `doc` are LOCAL to the host serving this epic and carry the
   * whole record. `cloud` is a read-only REPLICA of an agent bound to another
   * of the user's machines, and the cloud metadata projection it came from has
   * no resume metadata in it at all - so on a `cloud` row `workspaceFolders`
   * is empty, `agentMode` is the launch default, and every launch override and
   * `harnessSessionId` is null. Those are PLACEHOLDERS, not values.
   *
   * Read this before any of them. It is not a decoration on `docResident` - it
   * answers a different question ("does this row have the fields") from the one
   * `docResident` answers ("is this row addressable through the registry
   * affordances"), which is why both are carried.
   *
   * The one thing it settles for good: a `cloud` row can never be cloned,
   * forked or resumed onto this machine. There is no `harnessSessionId` to
   * resume from and there never will be - which is also the no-double-driver
   * property, one driver per provider CLI session, by construction.
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
   * Host-backed archive flag, the terminal-agent twin of
   * {@link ChatProjection.archivedAt} - one `epic.setChatArchived` RPC keyed by
   * id covers both record kinds, so the sidebar treats them identically.
   */
  readonly archivedAt: number | null;
  /**
   * Which of the harness's logged-in profiles (subscriptions) this agent runs
   * on. `null` = the ambient/host login, so agents persisted before profiles
   * existed still project cleanly. See the multi-profile decision log.
   */
  readonly profileId: string | null;
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

export interface AgentRolesSlice {
  readonly byAgentId: Readonly<Record<string, readonly RoleClaim[]>>;
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
  /**
   * The Y.Doc's own chat entries, before the host's store-backed records are
   * folded in. Not for components - it is the projector's INPUT state, kept
   * separate so an incremental doc patch (including the upgrade sweep's
   * DELETE of a proven-published entry) reconciles against the doc's history
   * rather than against the union, which would let a doc removal take a live
   * store-backed chat with it.
   */
  readonly docChats: ChatsSlice;
  /** Doc entries unioned with the host's records. Components read THIS. */
  readonly chats: ChatsSlice;
  /**
   * The Y.Doc's own terminal-agent entries, before the host's registry rows
   * (`epic.listTuiAgents`) are folded in - the terminal-agent twin of
   * {@link EpicProjectedSlices.docChats}, kept separate for the same reason: a
   * doc removal must reconcile against the doc's own history rather than
   * against the union, or it would take a live registry-backed agent with it.
   */
  readonly docTuiAgents: TerminalAgentsSlice;
  /** Doc entries unioned with the host's registry rows. Components read THIS. */
  readonly tuiAgents: TerminalAgentsSlice;
  readonly agentRoles: AgentRolesSlice;
  readonly tree: TreeSlice;
}

export const EMPTY_ARRAY: readonly string[] = Object.freeze([]);

export const EMPTY_ARTIFACT_ROOMS_SLICE: ArtifactRoomsSlice = Object.freeze({
  stateByArtifactRoomId: Object.freeze(
    {} as Record<string, EpicArtifactRoomAvailability>,
  ),
});

/**
 * Starting value for the per-artifact-room host-dirty mirror. Empty means
 * "nothing known to be dirty", which is also the correct RESET value on every
 * re-subscribe: the host tracks what it has emitted per subscription, so a
 * fresh subscription re-emits `artifactRoomDirty` for whatever is still dirty
 * and never re-states what is clean.
 */
export const EMPTY_ARTIFACT_ROOM_DIRTY: Readonly<Record<string, boolean>> =
  Object.freeze({} as Record<string, boolean>);

/**
 * The empty chat table, shared by the doc slice, the record slice and the union
 * so "nothing here" is one reference everywhere - a fresh empty object per
 * source would make every downstream `Object.is` check see a change.
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
