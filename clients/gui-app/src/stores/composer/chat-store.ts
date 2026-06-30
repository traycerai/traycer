import { v4 as uuidv4 } from "uuid";
import { create } from "zustand";
import type {
  ChatQueueSteerMode,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ApprovalDecision,
  ChatSessionAnchor,
  GuiHarnessId,
  InterviewAnswer,
  InterviewQuestion,
  TodoItem,
  AgentUserMessage,
} from "@traycer/protocol/persistence/epic/schemas";
import type {
  AgentMessageSend,
  ArtifactOperationAction,
  BackgroundTaskOutput,
  ContentBlock,
  DiffSource,
  FileEditReason,
  PlanAction,
  PlanContentRef,
  AutonomousResumeTrigger,
  PlanSource,
  PlanStatus,
  PlanStep,
  ToolInputDetail,
} from "@traycer/protocol/persistence/epic/content-blocks";
import type { ParsedTaskTodo } from "@traycer/protocol/host/agent/gui/task-todo-tools";

export type {
  DiffSource,
  FileEditReason,
} from "@traycer/protocol/persistence/epic/content-blocks";
import type { Attachment } from "@/lib/composer/types";
import type {
  EpicArtifactKind,
  JsonContent,
} from "@traycer/protocol/common/registry";
import type {
  CheckpointFileOperation,
  TurnCheckpointManifest,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type { SnapshotSourceBlockIds } from "@/lib/chat/snapshot-source-block-ids";
import type { SetupCardViewModel } from "@/components/chat/segments/setup-card-segment";

export type ChatMessageRole = "user" | "assistant" | "system";

// Terminal outcome for an action segment whose turn ended before its own
// completion event arrived: `interrupted` (the user hit Stop) or `superseded`
// (a steer-restart replaced the turn). Null for the normal lifecycle
// (streaming / completed / errored) - in those cases `isStreaming` and `error`
// already carry the state. Derived from the persisted block-status enum (via
// Extract) so it stays in lockstep with it - a renamed/removed status fails to
// compile here rather than silently dropping a badge.
export type SegmentEndState = Extract<
  ContentBlock["status"],
  "interrupted" | "superseded"
> | null;

export interface SegmentTodoItem {
  id: string;
  status: TodoItem["status"];
  text: string;
  priority: string | null;
  activeForm: string | null;
}

export interface FileChangeSegment {
  id: string;
  kind: "file_change";
  filePath: string;
  operation: string;
  diffSource: DiffSource;
  // Content-addressed snapshot refs; the before/after text is lazy-fetched on
  // expand via `snapshots.readSnapshotDiff` (not inlined in the chat doc).
  beforeHash: string | null;
  afterHash: string | null;
  // +N/−M counts persisted on the block so the collapsed header needs no fetch.
  additions: number;
  deletions: number;
  sourceBlockIds: SnapshotSourceBlockIds;
  reason: FileEditReason;
  isStreaming: boolean;
  // Terminal outcome when the turn ended mid-flight (else null). See SegmentEndState.
  endState: SegmentEndState;
  // Owning subagent block id when this change was made by a subagent (nests
  // under that subagent block). Null for top-level / main-agent changes.
  parentId: string | null;
}

export interface ToolSegment {
  id: string;
  kind: "tool";
  toolName: string;
  // Precomputed display data (the raw harness input is no longer persisted): the
  // ≤80-char header line + the optional expand body. `taskTodoItems` is the call
  // parsed into todo item(s) for the pinned-todo stack (null for non-task tools).
  inputSummary: string | null;
  inputDetail: ToolInputDetail | null;
  taskTodoItems: ReadonlyArray<ParsedTaskTodo> | null;
  error: string | null;
  agentMessageSend: AgentMessageSend | null;
  isStreaming: boolean;
  // Terminal outcome when the turn ended mid-flight (else null). See SegmentEndState.
  endState: SegmentEndState;
  // Latest intermediate progress line for an in-flight call (replace-latest;
  // null when the harness reports none). Shown only while streaming.
  progress: string | null;
  // Capped terminal output from a backgrounded command/monitor once it settles.
  backgroundOutput: BackgroundTaskOutput | null;
  // Persistent: true for a backgrounded command/Monitor (Bash run_in_background
  // or the Monitor tool). Drives standalone-card promotion across the whole
  // lifecycle - running -> completed/stopped/errored -> reload - so it never
  // collapses back into the generic activity group.
  backgroundTask: boolean;
  // Wall-clock start of the call. Drives the elapsed heartbeat while running.
  startedAt: number;
  // Completed background command/Monitor duration; null while streaming, for
  // non-background tools, or when persisted data predates immutable tool start.
  durationMs: number | null;
  // Owning subagent block id when this call was made by a subagent (nests under
  // that subagent block). Null for top-level / main-agent tool calls.
  parentId: string | null;
}

export type SubagentChildSegment =
  ToolSegment | FileChangeSegment | CommandSegment;

export interface ReasoningSegment {
  id: string;
  kind: "reasoning";
  markdown: string;
  isStreaming: boolean;
  // Thinking duration once completed (`null` while streaming or for blocks
  // persisted before `startedAt` existed). Drives the "Thought for Xs" label.
  durationMs: number | null;
}

export interface CommandSegment {
  id: string;
  kind: "command";
  command: string;
  cwd: string | null;
  exitCode: number | null;
  isStreaming: boolean;
  // Terminal outcome when the turn ended mid-flight (else null). See SegmentEndState.
  endState: SegmentEndState;
  // Latest intermediate progress line, mirroring `ToolSegment.progress` so the
  // streaming footer is one shared component. Commands carry no progress signal
  // today (always null); kept for symmetry and a future `command.progress`.
  progress: string | null;
  // Wall-clock start of the command (block timestamp; stays anchored while
  // streaming). Drives the elapsed heartbeat shown while it runs.
  startedAt: number;
  // Owning subagent block id when this command was run by a subagent (nests
  // under that subagent block). Null for top-level / main-agent commands.
  parentId: string | null;
}

export interface SubagentSegment {
  id: string;
  kind: "subagent";
  name: string | null;
  agentType: string | null;
  task: string | null;
  progressUpdates: ReadonlyArray<string>;
  result: string | null;
  isStreaming: boolean;
  // Terminal outcome when the turn ended mid-flight (else null). See SegmentEndState.
  endState: SegmentEndState;
  // Immutable spawn time, driving the live elapsed heartbeat on the card while
  // running. Null for blocks persisted before this field existed.
  startedAt: number | null;
  // Total run duration once finished (spawn -> completion); null while streaming
  // or when `startedAt` is unknown. Drives the static "Ns" label, mirroring
  // reasoning's "Thought for Xs".
  durationMs: number | null;
  // The spawning tool_call block id (Claude's Task/Agent tool). The timeline
  // builder drops the matching top-level tool segment so the card is the sole
  // representation. Null for harnesses that emit no separate spawn tool call.
  spawnToolCallId: string | null;
  // The subagent's own activity (tool calls + file changes) nested under this
  // block, keyed off each child segment's `parentId === this.id`.
  children: ReadonlyArray<SubagentChildSegment>;
}

export interface ApprovalSegment {
  id: string;
  kind: "approval";
  toolName: string | null;
  description: string | null;
  // Precomputed expand body for the pending tool's input (raw input not stored).
  inputSummary: string | null;
  inputDetail: ToolInputDetail | null;
  decision: ApprovalDecision | null;
}

export interface PlanSegmentModel {
  id: string;
  kind: "plan";
  planId: string;
  planStatus: PlanStatus;
  harnessId: string;
  source: PlanSource;
  title: string | null;
  summary: string | null;
  markdownPreview: string;
  fullContentRef: PlanContentRef | null;
  steps: ReadonlyArray<PlanStep>;
  actions: ReadonlyArray<PlanAction>;
  approvalId: string | null;
  supersededByPlanId: string | null;
  isStreaming: boolean;
  contentIdentity: string;
}

/**
 * A semantic artifact create / update / delete card. The card resolves the live
 * title / ticket status / deletion tombstone reactively from the open-epic
 * projection by `artifactId`; `title` is only a fallback for the short delete
 * window before the tombstone projection arrives. `kind` is the segment
 * discriminant, so the artifact's own kind is named `artifactKind`.
 */
/**
 * The merged file change behind an artifact card (first-before → last-after
 * across any coalesced edits), carried on the `artifact_operation` block itself
 * so it's available the moment the edit completes - no wait for turn-end
 * checkpoint capture. Null when no snapshot was captured (bash delete / post-hoc
 * edit). The card lazy-fetches the before/after by hash on expand.
 */
export interface ArtifactSegmentChange {
  beforeHash: string | null;
  afterHash: string | null;
}

export interface ArtifactOperationSegment {
  id: string;
  kind: "artifact_operation";
  operation: ArtifactOperationAction;
  artifactKind: EpicArtifactKind;
  artifactId: string;
  title: string | null;
  change: ArtifactSegmentChange | null;
}

/**
 * One artifact row inside a "Changes" group / accumulated panel, derived from a
 * checkpoint manifest entry's artifact tag. Title/kind are fallbacks; the live
 * title is re-resolved from the open-epic projection by `artifactId`. The hashes
 * back a click → merged-diff open.
 */
export interface ArtifactChangeRow {
  artifactId: string | null;
  artifactKind: EpicArtifactKind | null;
  title: string | null;
  operation: CheckpointFileOperation;
  filePath: string;
  beforeHash: string | null;
  afterHash: string | null;
}

export type MessageSegment =
  | { id: string; kind: "text"; markdown: string; isStreaming: boolean }
  | ReasoningSegment
  | ToolSegment
  | FileChangeSegment
  | {
      id: string;
      kind: "file_change_group";
      files: ReadonlyArray<FileChangeSegment>;
      // Artifact changes in the same turn, rendered as titled rows alongside
      // the file rows. Derived from the checkpoint manifest's artifact entries.
      artifacts: ReadonlyArray<ArtifactChangeRow>;
      checkpointManifest: TurnCheckpointManifest | null;
      hasLaterOverlappingChanges: boolean;
    }
  | CommandSegment
  | SubagentSegment
  | ApprovalSegment
  | ArtifactOperationSegment
  | PlanSegmentModel
  | {
      id: string;
      kind: "todo";
      items: ReadonlyArray<SegmentTodoItem>;
    }
  | {
      id: string;
      kind: "error";
      message: string;
      recoverable: boolean;
      code: string | null;
    }
  | {
      id: string;
      kind: "compaction";
      status: "streaming" | "completed" | "errored";
      trigger: "auto" | "manual" | null;
      preTokens: number | null;
      postTokens: number | null;
      durationMs: number | null;
      summary: string | null;
      error: string | null;
    }
  | {
      id: string;
      kind: "autonomous_resume";
      triggers: ReadonlyArray<AutonomousResumeTrigger>;
    }
  | InterviewSegment
  | {
      id: string;
      kind: "forked-chat-link";
      viewTabId: string;
      sourceChatId: string;
      sourceChatTitle: string;
      sourceHostId: string;
    }
  | {
      id: string;
      kind: "setup-card";
      /**
       * Consolidated worktree-setup view-model (T2 deriver output). The segment
       * is synthesized in `rendered-messages` for a `role: "system"` row and is
       * never persisted, so it carries the tab-scoped `viewTabId` the card needs
       * for its focus-terminal path rather than threading a per-row prop.
       */
      model: SetupCardViewModel;
      viewTabId: string;
    };

export interface InterviewSegment {
  id: string;
  kind: "interview";
  /** Block status: "streaming" while pending, otherwise resolved/errored. */
  status: "streaming" | "completed" | "errored";
  toolName: string | null;
  title: string | null;
  description: string | null;
  questions: ReadonlyArray<InterviewQuestion>;
  answers: ReadonlyArray<InterviewAnswer>;
  error: string | null;
}

/**
 * Inter-agent provenance attached to a `role: "user"` message whose
 * sender was another agent (via `agent.sendMessage`). `null` for
 * human-authored user messages and for assistant turns. The receiver
 * GUI renders an agent-sourced row with distinct styling and a footer
 * that surfaces the sender id and (when `expectReply` is true)
 * instructions for replying via the CLI.
 */
export interface AgentSenderInfo {
  readonly agentId: string;
  /**
   * Sender's chat/agent title captured when the message was delivered.
   * Used as the display name fallback when the sender is no longer in the
   * live epic projection (e.g. cross-host) so we still show a name rather
   * than a raw id.
   */
  readonly senderTitle: string | null;
  readonly expectReply: boolean;
  readonly responseId: string | null;
}

/**
 * In-progress run state of the assistant turn this row renders. Mirrors the
 * host-owned chat `runStatus` (minus `idle`) and is only non-null for the
 * single active turn, so the response row can show a "Working…" indicator
 * for the whole turn (first message and every multi-turn send) and flip to
 * "Stopping…" the moment a stop is requested. Always `null` for user rows
 * and completed assistant turns.
 */
export type ChatMessageRunState = "running" | "stopping";

export interface ChatMessageSteerBadge {
  readonly status: "requested" | "steering" | "steered";
  readonly mode: ChatQueueSteerMode | null;
}

/**
 * Per-turn agent run metadata for an assistant row, surfaced in the elapsed
 * footer's info tooltip (provider, model, reasoning effort, fast mode). Only
 * set on assistant rows; `null` for user/system rows and assistant turns that
 * predate the persisted `reasoningEffort` / `serviceTier` fields.
 */
export interface AssistantTurnMeta {
  /** Raw harness id, used to pick the provider's mono icon for the footer. */
  readonly provider: GuiHarnessId;
  readonly providerLabel: string;
  readonly modelLabel: string | null;
  /** Raw persisted reasoning effort id from the host turn. */
  readonly reasoningEffort: string | null;
  /** Picker-style label resolved from the selected model's reasoning options. */
  readonly reasoningEffortLabel: string | null;
  readonly serviceTier: string | null;
  /**
   * Cumulative billed cost for the turn in USD, from the turn's final usage.
   * `null` for harnesses that don't price the turn (Codex/Cursor) and for live/
   * pending turns whose cost isn't known until completion.
   */
  readonly costUsd: number | null;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  segments: ReadonlyArray<MessageSegment>;
  structuredContent: JsonContent | null;
  attachments: ReadonlyArray<Attachment>;
  settings: ChatRunSettings | null;
  createdAt: number;
  /**
   * Wall-clock time the assistant turn finished, in ms. Non-null only for
   * completed assistant rows (drives the "Worked for Nm Xs" footer). Always
   * `null` for user rows, pending rows, and in-progress assistant turns.
   */
  completedAt: number | null;
  /**
   * User-wait time already accumulated during this assistant turn. The
   * assistant timer subtracts this so it measures agent work rather than time
   * blocked on approvals or questions.
   */
  pausedDurationMs?: number;
  /**
   * Start of the currently-open user-wait interval, if this turn is waiting on
   * the user now. While set, the live assistant timer freezes.
   */
  pausedSinceMs?: number | null;
  persistentMessageId: string | null;
  senderLabel: string | null;
  assistantMeta: AssistantTurnMeta | null;
  statusLabel: string | null;
  agentSenderInfo: AgentSenderInfo | null;
  agentMessage: AgentUserMessage | null;
  runState: ChatMessageRunState | null;
  sessionAnchor: ChatSessionAnchor | null;
  steerBadge: ChatMessageSteerBadge | null;
}

export interface ChatMessageInput {
  role: ChatMessageRole;
  content: JsonContent;
  contentText: string;
  attachments: ReadonlyArray<Attachment>;
  settings: ChatRunSettings | null;
}

interface ChatStore {
  messagesByTaskId: Record<string, ReadonlyArray<ChatMessage>>;
  appendMessage: (taskId: string, input: ChatMessageInput) => void;
  clearMessages: (taskId: string) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messagesByTaskId: {},
  appendMessage: (taskId, input) => {
    set((state) => {
      const existing = state.messagesByTaskId[taskId] ?? [];
      const messageId = uuidv4();
      const segments: ReadonlyArray<MessageSegment> =
        input.contentText.length > 0
          ? [
              {
                id: `${messageId}:text`,
                kind: "text",
                markdown: input.contentText,
                isStreaming: false,
              },
            ]
          : [];
      const next: ChatMessage = {
        id: messageId,
        role: input.role,
        content: input.contentText,
        segments,
        structuredContent: input.content,
        attachments: input.attachments,
        settings: input.settings,
        createdAt: Date.now(),
        completedAt: null,
        persistentMessageId: null,
        senderLabel: null,
        assistantMeta: null,
        statusLabel: null,
        agentSenderInfo: null,
        agentMessage: null,
        runState: null,
        sessionAnchor: null,
        steerBadge: null,
      };
      return {
        messagesByTaskId: {
          ...state.messagesByTaskId,
          [taskId]: [...existing, next],
        },
      };
    });
  },
  clearMessages: (taskId) => {
    set((state) => {
      if (!(taskId in state.messagesByTaskId)) {
        return state;
      }
      const next = { ...state.messagesByTaskId };
      delete next[taskId];
      return { messagesByTaskId: next };
    });
  },
}));
