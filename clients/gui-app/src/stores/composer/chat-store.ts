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
  InterviewDeliveryProjection,
  InterviewOutcome,
  InterviewQuestion,
  InterviewSettlementAuthority,
  ImageResolutionEntry,
  ImageGenerationResult,
  TodoItem,
  AgentUserMessage,
  BrowserAnnotationRecord,
} from "@traycer/protocol/persistence/epic/schemas";
import type {
  AgentMessageReceipt,
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
  ProviderNoticeDetail,
  ProviderNoticeTone,
  ToolCallManagedCommand,
  ToolInputDetail,
  WorkflowMeta,
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

// Terminal outcome for an action segment whose turn ended before its own completion event arrived:
// `interrupted` (the user hit Stop) or `superseded` (a steer-restart replaced the turn).
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

export interface AssistantMarkdownImageResolution {
  readonly messageId: string;
  readonly entry: ImageResolutionEntry;
}

export interface AssistantMarkdownImageTarget {
  readonly toolBlockId: string;
  readonly rowId: string;
}

export interface AssistantMarkdownImageContext {
  readonly epicId: string;
  readonly chatId: string;
  readonly resolutions: ReadonlyArray<AssistantMarkdownImageResolution>;
  readonly deduplicatedTargetsBySource: ReadonlyMap<
    string,
    AssistantMarkdownImageTarget
  >;
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
  // Precomputed display data (the raw harness input is no longer persisted): the ≤80-char header
  // line + the optional expand body.
  inputSummary: string | null;
  inputDetail: ToolInputDetail | null;
  taskTodoItems: ReadonlyArray<ParsedTaskTodo> | null;
  error: string | null;
  agentMessageSend: AgentMessageSend | null;
  // The shell a `traycer_run_shell` call created, stamped on the block at completion.
  managedCommand: ToolCallManagedCommand | null;
  // Where a `traycer_send_message` call landed: the receiver's transcript
  // message id, stamped on the block at completion. Lets the "Sent message"
  // card jump to that row in the receiver's scrollback. Null for every other
  // tool call, for a TUI receiver, and for sends persisted before the host
  // carried this (the card then just opens the receiver's tile).
  agentMessageReceipt: AgentMessageReceipt | null;
  isStreaming: boolean;
  // Terminal outcome when the turn ended mid-flight (else null). See SegmentEndState.
  endState: SegmentEndState;
  // True when `status === "errored"` was an explicit stop (deadline-killed Monitor, user-stopped
  // command) rather than a genuine failure.
  stopped: boolean;
  // Latest intermediate progress line for an in-flight call (replace-latest;
  // null when the harness reports none). Shown only while streaming.
  progress: string | null;
  // Capped terminal output from a backgrounded command/monitor once it settles.
  backgroundOutput: BackgroundTaskOutput | null;
  // Persistent: true for a backgrounded command/Monitor (Bash run_in_background or the Monitor
  // tool).
  backgroundTask: boolean | null;
  // Wall-clock start of the call. Drives the elapsed heartbeat while running.
  startedAt: number;
  // Completed background command/Monitor duration; null while streaming, for
  // non-background tools, or when persisted data predates immutable tool start.
  durationMs: number | null;
  // Owning subagent block id when this call was made by a subagent (nests under
  // that subagent block). Null for top-level / main-agent tool calls.
  parentId: string | null;
  /** Generated images carried by chat.subscribe@1.6. Normalized at projection. */
  imageResults: ReadonlyArray<ImageGenerationResult>;
}

// Recursive: a subagent's own children can themselves be nested subagent cards (any spawn depth),
// not just their tool/file_change/command activity.
export type SubagentChildSegment =
  | ToolSegment
  | FileChangeSegment
  | CommandSegment
  | SubagentSegment
  | ProviderNoticeSegment;

// A durable provider-generated notice (Codex model reroute / safety verification / buffering, and
// future harness equivalents), projected from a `text` content block whose `providerNotice`
export interface ProviderNoticeSegment {
  id: string;
  kind: "provider_notice";
  status: "streaming" | "completed" | "errored";
  tone: ProviderNoticeTone;
  title: string;
  message: string | null;
  details: ReadonlyArray<ProviderNoticeDetail>;
  // Owning subagent block id when this notice arrived on a subagent's thread
  // (nests under that subagent block). Null for a top-level notice.
  parentId: string | null;
}

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
  // Latest intermediate progress line, mirroring `ToolSegment.progress` so the streaming footer is
  // one shared component.
  progress: string | null;
  // Wall-clock start of the command (block timestamp; stays anchored while
  // streaming). Drives the elapsed heartbeat shown while it runs.
  startedAt: number;
  // Persistent: true once the harness promoted this command to a backgrounded one (Codex yields a
  // long-running exec to the background at the parent turn's end).
  backgroundTask: boolean | null;
  // True when the terminal outcome was an explicit stop (the host terminated the backgrounded
  // command) rather than a real non-zero exit.
  stopped: boolean;
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
  // True when `status === "errored"` was an explicit stop rather than a genuine failure - mirrors
  // ToolSegment.stopped.
  stopped: boolean;
  // Immutable spawn time, driving the live elapsed heartbeat on the card while
  // running. Null for blocks persisted before this field existed.
  startedAt: number | null;
  // Total run duration once finished (spawn -> completion); null while streaming or when `startedAt`
  // is unknown. Drives the static "Ns" label, mirroring reasoning's "Thought for Xs".
  durationMs: number | null;
  // The spawning tool_call block id (Claude's Task/Agent tool). The timeline builder drops the
  // matching top-level tool segment so the card is the sole representation.
  spawnToolCallId: string | null;
  // Owning subagent block id when this agent was itself spawned by another agent (nests under that
  // parent's card, any depth). Null for a top-level agent.
  parentId: string | null;
  // Present iff this card is a workflow run's dual-written card - the rich fleet data (intent,
  // activity timeline, fleet counts, tokens) an old reader can't render.
  workflowMeta: WorkflowMeta | null;
  // The subagent's own activity nested under this block, keyed off each child segment's `parentId
  // === this.id` - tool calls, file changes, commands, AND nested agent cards (any depth).
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

/** A semantic artifact create / update / delete card. */
/**
 * The merged file change behind an artifact card (first-before → last-after across any coalesced
 * edits), carried on the `artifact_operation` block itself so it's available the moment the edit
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
 * One artifact row inside a "Changes" group / accumulated panel, derived from a checkpoint
 * manifest entry's artifact tag.
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
  | {
      id: string;
      kind: "text";
      markdown: string;
      isStreaming: boolean;
      assistantImageContext?: AssistantMarkdownImageContext;
    }
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
  | ProviderNoticeSegment
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
      kind: "imported-chat-marker";
      /**
       * Synthesized in `rendered-messages` from the chat's `chat.imported`
       * event and never persisted - the event itself is the record.
       */
      sourceProvider: GuiHarnessId;
      importedAt: number;
      sourceCwd: string;
    }
  | {
      id: string;
      kind: "setup-card";
      /** Consolidated worktree-setup view-model (T2 deriver output). */
      model: SetupCardViewModel;
      viewTabId: string;
      /**
       * the raw triggering message id this card is associated with
       * (`SetupCardRow.triggeringMessageId`) - `null` only for the genesis card or a defensive
       */
      anchorMessageId: string | null;
      isGenesisPin: boolean;
    };

export interface InterviewSegment {
  id: string;
  kind: "interview";
  /** Block status: "streaming" while pending, otherwise resolved/errored. */
  status: "streaming" | "completed" | "errored";
  toolName: string | null;
  questions: ReadonlyArray<InterviewQuestion>;
  answers: ReadonlyArray<InterviewAnswer>;
  draftAnswers: ReadonlyArray<InterviewAnswer>;
  outcome: InterviewOutcome | null;
  settlement: InterviewSettlementAuthority | null;
  error: string | null;
  delivery: InterviewDeliveryProjection | null;
  /**
   * True when this question was carried into a Cross Question fork without being answered (the host
   * settles the copied block with a `forkedWithoutAnswer` marker).
   */
  forkedWithoutAnswer: boolean;
}

/**
 * Inter-agent provenance attached to a `role: "user"` message whose sender was another agent (via
 * `agent.sendMessage`). `null` for human-authored user messages and for assistant turns.
 */
export interface AgentSenderInfo {
  readonly agentId: string;
  /**
   * Sender's chat/agent title captured when the message was delivered. Used as the display name fallback
   * when the sender is no longer in the live epic projection (e.g.
   */
  readonly senderTitle: string | null;
  readonly expectReply: boolean;
  readonly responseId: string | null;
}

/** In-progress run state of the assistant turn this row renders. */
export type ChatMessageRunState = "running" | "stopping";

export interface ChatMessageSteerBadge {
  readonly status: "requested" | "steering" | "steered";
  readonly mode: ChatQueueSteerMode | null;
}

/**
 * Per-turn agent run metadata for an assistant row, surfaced in the elapsed footer's info tooltip
 * (provider, profile, model, reasoning effort, fast mode).
 */
export interface AssistantTurnMeta {
  /** Raw harness id, used to pick the provider's mono icon for the footer. */
  readonly provider: GuiHarnessId;
  readonly providerLabel: string;
  /** Profile label snapshotted when the turn's provider session was minted. */
  readonly profileLabel: string | null;
  /**
   * NAME of the environment variable whose credential actually authenticated this turn, recorded by
   * the host at spawn time; `null` when the turn ran on the profile named by `profileLabel`.
   */
  readonly envCredentialVar: string | null;
  readonly modelLabel: string | null;
  /** Raw persisted reasoning effort id from the host turn. */
  readonly reasoningEffort: string | null;
  /** Picker-style label resolved from the selected model's reasoning options. */
  readonly reasoningEffortLabel: string | null;
  readonly serviceTier: string | null;
  /** Cumulative billed cost for the turn in USD, from the turn's final usage. */
  readonly costUsd: number | null;
}

/**
 * Present when the user (or a cascaded `agent.stop`) ended this turn via the persisted
 * `turn.stopped` chat event, rather than the turn finishing naturally.
 */
export interface ChatMessageStoppedInfo {
  readonly stoppedAt: number;
  readonly reason: string | null;
  /**
   * Whether the TURN (not necessarily this specific row) produced response output before it was
   * stopped. An `autonomous_resume` divider is a turn boundary, not a response.
   */
  readonly turnHadOutput: boolean;
  /** Every assistant segment in the turn, in order and BY REFERENCE. */
  readonly turnReplySegments: ReadonlyArray<MessageSegment>;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  segments: ReadonlyArray<MessageSegment>;
  structuredContent: JsonContent | null;
  attachments: ReadonlyArray<Attachment>;
  browserAnnotations?: ReadonlyArray<BrowserAnnotationRecord>;
  settings: ChatRunSettings | null;
  createdAt: number;
  /** Wall-clock start used by the assistant elapsed timer. */
  elapsedStartedAt?: number;
  /**
   * Whether every assistant segment in this completed turn is an `autonomous_resume` divider.
   * Stamped only on the turn's final assistant row; `undefined` on live and non-final rows.
   */
  turnHasOnlyAutonomousResumeSegments?: boolean;
  /** Whether this completed row should render the elapsed footer. */
  showCompletionFooter?: boolean;
  /** Wall-clock time the assistant turn finished, in ms. Non-null only for completed assistant rows. */
  completedAt: number | null;
  /** See `ChatMessageStoppedInfo`. */
  stopped: ChatMessageStoppedInfo | null;
  /**
   * User-wait time already accumulated during this assistant turn. The assistant timer subtracts
   * this so it measures agent work rather than time blocked on approvals or questions.
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
        stopped: null,
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
