import type {
  RuntimeApprovalDecision,
  RuntimeEvent,
  RuntimePlanAction,
  RuntimePlanStep,
  RuntimeTodoItem,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import type {
  ApprovalDecision as PersistenceApprovalDecision,
  ContentBlock,
  ParsedTaskTodoPersisted,
  PlanAction,
  PlanBlock,
  PlanStep,
  ToolInputDetail,
  TodoItem,
  WorkflowActivityEntry,
  WorkflowMeta,
} from "@traycer/protocol/persistence/epic/schemas";
import { deriveToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";
import {
  isTaskTodoToolName,
  parseTaskTodoToolPayloads,
} from "@traycer/protocol/host/agent/gui/task-todo-tools";

export interface TurnContentState {
  readonly blocks: ContentBlock[];
  readonly blocksVersion: number;
}

/**
 * Finds a block by ID and type using a type predicate callback,
 * returning a narrowed result without any assertion.
 */
function findBlockOfType<T extends ContentBlock["type"]>(
  blocks: ContentBlock[],
  blockId: string,
  type: T,
): Extract<ContentBlock, { type: T }> | undefined {
  return blocks.find(
    (b): b is Extract<ContentBlock, { type: T }> =>
      b.blockId === blockId && b.type === type,
  );
}

function replaceBlock(
  blocks: ContentBlock[],
  blockId: string,
  updated: ContentBlock,
): ContentBlock[] {
  return blocks.map((b) => (b.blockId === blockId ? updated : b));
}

/**
 * Resolve the owner (parent) block id for a block being created or updated.
 * Prefer the event's own `parentBlockId`; fall back to any value the existing
 * block already carries so a later lifecycle event (e.g. `file_change.completed`
 * arriving with the parent after a parent-less `file_change.started`) can adopt
 * it without dropping it. Absent on both ⇒ top-level (null).
 */
function resolveParentBlockId(
  event: { parentBlockId?: string | null },
  existing: { parentBlockId?: string | null } | undefined,
): string | null {
  if (event.parentBlockId !== undefined) return event.parentBlockId;
  return existing?.parentBlockId ?? null;
}

// Terminal status applied to an ACTION block (tool_call / command / file_change
// / subagent) that was still "streaming" when the turn ended. A normal finish
// completes it; a user Stop interrupts it; a steer-restart supersedes it.
// `text`/`reasoning` are content (a partial thought is not a failed action) and
// are always finalized as "completed".
export type FinalizedActionStatus = "completed" | "interrupted" | "superseded";

// THE single rule for how a turn's terminal outcome maps to the status its
// still-open action blocks adopt. Every layer that has to finalize in-flight
// blocks (this accumulator, the host's `finishActiveTurn` belt, the GUI
// materialization net) routes through here so they can never diverge: a clean
// finish completes, a steer-restart supersedes, anything else interrupts.
export function resolveFinalizedActionStatus(
  terminalKind: "completed" | "stopped" | "interrupted",
  isSteerRestart: boolean,
): FinalizedActionStatus {
  if (terminalKind === "completed") return "completed";
  if (terminalKind === "stopped") return "interrupted";
  // interrupted: a steer-restart supersedes in-flight work; any other
  // interruption (error cascade, etc.) cut it off → interrupted.
  return isSteerRestart ? "superseded" : "interrupted";
}

// Map a terminal turn EVENT to the finalized action status (thin adapter over
// `resolveFinalizedActionStatus`).
export function finalizeStatusForTerminalEvent(
  event: Extract<
    RuntimeEvent,
    { type: "turn.completed" | "turn.stopped" | "turn.interrupted" }
  >,
): FinalizedActionStatus {
  const kind =
    event.type === "turn.completed"
      ? "completed"
      : event.type === "turn.stopped"
        ? "stopped"
        : "interrupted";
  return resolveFinalizedActionStatus(
    kind,
    event.type === "turn.interrupted" && event.code === "STEER_RESTART",
  );
}

// Force-finalize blocks still "streaming" when a turn ends (completed / stopped
// / interrupted). A finished turn leaves nothing in flight, so any block whose
// terminal event was never delivered - e.g. a sub-agent or an in-progress file
// edit when the user hits Stop - would otherwise render "in progress" forever.
// Covers tool_call, command, file_change, subagent, text, reasoning, … but NOT
// `approval`/`interview`: those are resolved out-of-band (by user input or the
// host's abandon-cleanup, which emits their own terminal events) rather than
// by the turn ending, and their pending UI is driven by separate streams.
// Force-completing a pending interview here would flip it to "completed" for a
// frame before its `interview.errored` cleanup lands.
//
// `actionStatus` is applied to action blocks (tool_call/command/file_change/
// subagent); text/reasoning are always "completed".
export function finalizeStreamingActionBlocks(
  blocks: ContentBlock[],
  timestamp: number,
  actionStatus: FinalizedActionStatus,
): ContentBlock[] {
  let hasUpdates = false;

  const finalizedBlocks = blocks.map((block) => {
    if (
      block.status === "streaming" &&
      block.type !== "approval" &&
      block.type !== "interview"
    ) {
      hasUpdates = true;
      // For tool_call/command, keep the start timestamp stable. Tool calls also
      // carry immutable `startedAt`; `timestamp` advances only when their own
      // terminal event arrives, which lets background command cards derive a
      // post-completion duration.
      if (block.type === "tool_call" || block.type === "command") {
        return { ...block, status: actionStatus };
      }
      // file_change/subagent are action blocks too, but treat `timestamp` as
      // completion (no live elapsed anchor) - advance it to the turn-end time.
      if (block.type === "file_change" || block.type === "subagent") {
        return { ...block, status: actionStatus, timestamp };
      }
      // A plan left streaming at turn end never received an explicit
      // plan.completed. Flip its block status to completed AND promote
      // planStatus out of "drafting" to the terminal "ready" - otherwise the
      // card shows a frozen "Drafting" spinner forever. Keep the start
      // timestamp (plans carry no live elapsed anchor).
      if (block.type === "plan") {
        return {
          ...block,
          status: "completed" as const,
          planStatus:
            block.planStatus === "drafting" ? "ready" : block.planStatus,
        };
      }
      // text/reasoning are content, not actions: a partial thought/sentence is
      // not a failure. Always "completed", with `timestamp` advanced to turn-end
      // so a derived duration ("Thought for Xs") spans first delta → turn end.
      return { ...block, status: "completed" as const, timestamp };
    }

    return block;
  });

  return hasUpdates ? finalizedBlocks : blocks;
}

// Option B (backgrounded work): restore any subagent/background-tool block that
// `finalizeStreamingActionBlocks` just finalized but was "streaming" before, to
// its pre-finalize (streaming) state. Detached work still streaming at a CLEAN
// turn end outlives the turn that spawned it, so its card must keep reading
// "running" until its OWN completion finalizes it (the host's detached
// execution). Other turn-scoped action blocks (ordinary tool_call/command/
// file_change) stay finalized. Only applied on `turn.completed` - a
// stopped/interrupted turn DOES finalize still-running detached work.
export function reopenStreamingSubagentBlocks(
  before: ContentBlock[],
  finalized: ContentBlock[],
): ContentBlock[] {
  if (finalized === before) return finalized;
  const streamingDetachedIds = streamingDetachedBlockIds(before);
  if (streamingDetachedIds.size === 0) return finalized;
  const beforeById = new Map(before.map((block) => [block.blockId, block]));
  return finalized.map((block) =>
    streamingDetachedIds.has(block.blockId)
      ? (beforeById.get(block.blockId) ?? block)
      : block,
  );
}

function streamingDetachedBlockIds(
  blocks: ContentBlock[],
): ReadonlySet<string> {
  const ids = new Set(
    blocks
      .filter(
        (block) =>
          block.status === "streaming" &&
          (block.type === "subagent" ||
            (block.type === "tool_call" && block.backgroundTask)),
      )
      .map((block) => block.blockId),
  );
  if (ids.size === 0) return ids;

  let changed = true;
  while (changed) {
    changed = false;
    blocks.forEach((block) => {
      if (block.status !== "streaming") return;
      const parentBlockId = block.parentBlockId ?? null;
      if (parentBlockId === null) return;
      if (!ids.has(parentBlockId) || ids.has(block.blockId)) return;
      ids.add(block.blockId);
      changed = true;
    });
  }

  return ids;
}

function finalizeBlock(
  blocks: ContentBlock[],
  blockId: string,
  type: "text" | "reasoning",
  timestamp: number,
): ContentBlock[] {
  const existing = findBlockOfType(blocks, blockId, type);
  if (!existing || existing.status === "completed") {
    return blocks;
  }
  const updated = {
    ...existing,
    status: "completed" as const,
    timestamp,
  };
  return replaceBlock(blocks, blockId, updated);
}

function nullableString(value: string | undefined): string | null {
  return value ?? null;
}

function nullableNumber(value: number | undefined): number | null {
  return value ?? null;
}

// Precomputed, capped display fields for a tool/approval input. The raw harness
// input is never persisted (for Edit/Write/apply_patch it is the full file body,
// the dominant chat-doc bloat); the host stores only the summary line + expand
// body the GUI renders. Computed here, the single block-build chokepoint, so the
// live broadcast and the persisted row carry identical fields.
function toolInputDisplay(
  toolName: string,
  input: unknown,
): { inputSummary: string | null; inputDetail: ToolInputDetail | null } {
  return {
    inputSummary: deriveToolInputSummary(toolName, input),
    inputDetail: deriveToolInputDetail(toolName, input),
  };
}

// Task-todo tools (TaskCreate / TaskUpdate / …) carry their todo item(s) in the
// call input; parsed here so the GUI's pinned-todo stack reads structured items
// instead of the (no-longer-persisted) raw input. Null for every other tool.
function taskTodoItemsFromInput(
  toolName: string,
  input: unknown,
): ParsedTaskTodoPersisted[] | null {
  if (!isTaskTodoToolName(toolName)) return null;
  return parseTaskTodoToolPayloads({ toolName, payloads: [input] });
}

// One construction point for a freshly-opened sub-agent block, shared by the
// `subagent.started` open and the `progress`/`completed` orphan fallbacks (a
// block created when its `started` was dropped or arrived out of order), and
// by the `workflow.*` triple's dual-write onto this same block shape. Keeps
// the block shape - and the `type` discriminant - defined once.
function makeSubAgentBlock(fields: {
  blockId: string;
  status: "streaming" | "completed" | "errored";
  timestamp: number;
  parentBlockId: string | null;
  startedAt: number | null;
  name: string | null;
  agentType: string | null;
  task: string | null;
  progressUpdates: string[];
  result: string | null;
  spawnToolCallId: string | null;
  stopped: boolean;
  workflowMeta: WorkflowMeta | null;
}): Extract<ContentBlock, { type: "subagent" }> {
  return { type: "subagent", ...fields };
}

// Appends a new workflow activity entry, skipping a consecutive duplicate
// (the same aggregate `task_progress` line can re-arrive on repeated polls
// with no new milestone) so the persisted timeline reads as distinct steps.
function appendWorkflowActivity(
  activity: WorkflowActivityEntry[],
  entry: WorkflowActivityEntry | null,
): WorkflowActivityEntry[] {
  if (entry === null) return activity;
  const last = activity[activity.length - 1];
  if (last !== undefined && last.kind === entry.kind && last.text === entry.text) {
    return activity;
  }
  return [...activity, entry];
}

function emptyWorkflowMeta(name: string | null): WorkflowMeta {
  return {
    name: name ?? "",
    intent: null,
    activity: [],
    agentsStarted: null,
    agentsFinished: null,
    totalTokens: null,
  };
}

function nullableMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  return value ?? null;
}

// Sticky-OR with a third "not yet known" state: only an explicit `true` ever
// changes the marker. `existing: null` ("unknown so far") and an `incoming`
// that doesn't confirm either way leave it `null`, rather than collapsing to a
// committed `false` - a later event (the SDK's own retroactive confirmation,
// or simply more of the streamed input parsing) can still resolve it to
// `true`, but nothing ever downgrades a `true` once set.
function mergeBackgroundTaskMarker(
  existing: boolean | null,
  incoming: boolean | undefined,
): boolean | null {
  if (existing === true || incoming === true) return true;
  return existing;
}

function normalizeApprovalDecision(
  decision: RuntimeApprovalDecision,
): PersistenceApprovalDecision {
  return {
    approved: decision.approved,
    reason: decision.reason ?? null,
  };
}

function normalizeTodoItem(item: RuntimeTodoItem): TodoItem {
  return {
    id: item.id ?? null,
    text: item.text,
    status: item.status,
    priority: item.priority ?? null,
    activeForm: item.activeForm ?? null,
  };
}

function normalizePlanStep(step: RuntimePlanStep): PlanStep {
  return {
    id: step.id,
    text: step.text,
    status: step.status,
    activeForm: step.activeForm,
  };
}

function normalizePlanAction(action: RuntimePlanAction): PlanAction {
  return {
    id: action.id,
    label: action.label,
    decision: action.decision,
    variant: action.variant,
  };
}

function findPlanBlock(
  blocks: ContentBlock[],
  blockId: string,
  planId: string,
): PlanBlock | undefined {
  return blocks.find(
    (block): block is PlanBlock =>
      block.type === "plan" &&
      (block.blockId === blockId || block.planId === planId),
  );
}

function statusForPlanStatus(
  planStatus: PlanBlock["planStatus"],
): "streaming" | "completed" {
  return planStatus === "drafting" ? "streaming" : "completed";
}

function makePlanBlock(fields: {
  blockId: string;
  status: "streaming" | "completed";
  timestamp: number;
  parentBlockId: string | null;
  planStatus: PlanBlock["planStatus"];
  planId: string;
  source: PlanBlock["source"];
  title: string | null;
  summary: string | null;
  markdownPreview: string;
  fullContentRef: PlanBlock["fullContentRef"];
  steps: PlanStep[];
  actions: PlanAction[];
  approvalId: string | null;
  supersededByPlanId: string | null;
  metadata: Record<string, unknown> | null;
}): PlanBlock {
  return {
    type: "plan",
    harnessId: fields.source.harnessId,
    ...fields,
  };
}

function findResolvedApprovalDecision(
  blocks: ContentBlock[],
  approvalId: string | null,
): PersistenceApprovalDecision | undefined {
  if (approvalId === null) return undefined;
  const approval = findBlockOfType(blocks, approvalId, "approval");
  return approval?.decision ?? undefined;
}

function applyApprovalDecisionToPlan(
  block: PlanBlock,
  decision: PersistenceApprovalDecision,
  timestamp: number,
): PlanBlock {
  return {
    ...block,
    status: "completed",
    planStatus: decision.approved ? "approved" : "rejected",
    timestamp,
  };
}

function applyAlreadyResolvedApproval(
  blocks: ContentBlock[],
  block: PlanBlock,
  timestamp: number,
): PlanBlock {
  const decision = findResolvedApprovalDecision(blocks, block.approvalId);
  if (decision === undefined) return block;
  return applyApprovalDecisionToPlan(block, decision, timestamp);
}

function updatePlansForApprovalResolution(
  blocks: ContentBlock[],
  approvalId: string,
  decision: PersistenceApprovalDecision,
  timestamp: number,
): ContentBlock[] {
  let hasUpdates = false;
  const updatedBlocks = blocks.map((block) => {
    if (block.type !== "plan" || block.approvalId !== approvalId) return block;
    hasUpdates = true;
    return applyApprovalDecisionToPlan(block, decision, timestamp);
  });
  return hasUpdates ? updatedBlocks : blocks;
}

function plansShareSupersedeScope(left: PlanBlock, right: PlanBlock): boolean {
  if (left.harnessId !== right.harnessId) return false;
  if (left.source.kind !== right.source.kind) return false;
  if (left.source.sessionId !== null && right.source.sessionId !== null) {
    return left.source.sessionId === right.source.sessionId;
  }
  if (left.source.sessionId !== right.source.sessionId) return false;
  if (left.source.turnId !== null && right.source.turnId !== null) {
    return left.source.turnId === right.source.turnId;
  }
  return false;
}

function supersedeActivePeerPlans(
  blocks: ContentBlock[],
  current: PlanBlock,
  timestamp: number,
): ContentBlock[] {
  if (
    current.planStatus !== "ready" &&
    current.planStatus !== "awaiting_approval"
  ) {
    return blocks;
  }

  let hasUpdates = false;
  const updatedBlocks = blocks.map((block) => {
    if (
      block.type !== "plan" ||
      block.planId === current.planId ||
      (block.planStatus !== "drafting" &&
        block.planStatus !== "ready" &&
        block.planStatus !== "awaiting_approval") ||
      !plansShareSupersedeScope(block, current)
    ) {
      return block;
    }

    hasUpdates = true;
    return {
      ...block,
      status: "completed" as const,
      planStatus: "superseded" as const,
      supersededByPlanId: current.planId,
      timestamp,
    };
  });

  return hasUpdates ? updatedBlocks : blocks;
}

function replaceAndSupersedePlanBlock(
  blocks: ContentBlock[],
  blockId: string,
  updated: PlanBlock,
  timestamp: number,
): ContentBlock[] {
  const replaced = replaceBlock(blocks, blockId, updated);
  return supersedeActivePeerPlans(replaced, updated, timestamp);
}

export function createTurnContentState(): TurnContentState {
  return {
    blocks: [],
    blocksVersion: 0,
  };
}

export function accumulateTurnContent(
  state: TurnContentState,
  event: RuntimeEvent,
): TurnContentState {
  const blocks = accumulateEvent(state.blocks, event);
  if (blocks === state.blocks) return state;
  return {
    blocks,
    blocksVersion: state.blocksVersion + 1,
  };
}

export function accumulateEvent(
  blocks: ContentBlock[],
  event: RuntimeEvent,
): ContentBlock[] {
  switch (event.type) {
    case "session.created":
    case "session.resumed":
    case "turn.started":
    case "user_message.anchor_resolved":
    case "usage.updated":
      return blocks;

    case "steer.submitted":
      return [
        ...blocks,
        {
          type: "steer",
          blockId: event.blockId,
          status: "completed",
          timestamp: event.timestamp,
          queueItemId: event.queueItemId,
          messageId: event.messageId,
          content: event.content,
          mode: event.mode,
        },
      ];

    case "turn.completed": {
      const finalized = finalizeStreamingActionBlocks(
        blocks,
        event.timestamp,
        finalizeStatusForTerminalEvent(event),
      );
      // Keep still-streaming detached work (backgrounded subagent/tool card)
      // "running" ONLY on a CLEAN completion. A degraded ending
      // (`event.reason` set - e.g. max_tokens, refusal) is a real termination:
      // the host does NOT keep the query alive for it, so detached work will not
      // continue. Finalize its card here rather than leaving a lying "running".
      return event.reason === undefined
        ? reopenStreamingSubagentBlocks(blocks, finalized)
        : finalized;
    }
    case "turn.stopped":
    case "turn.interrupted":
      // A cut-short turn finalizes everything still streaming, subagents
      // included - they cannot keep running once the turn is torn down.
      return finalizeStreamingActionBlocks(
        blocks,
        event.timestamp,
        finalizeStatusForTerminalEvent(event),
      );

    case "text.delta": {
      const existing = findBlockOfType(blocks, event.blockId, "text");
      if (existing) {
        const updated = {
          ...existing,
          text: existing.text + event.delta,
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "text",
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          text: event.delta,
        },
      ];
    }

    case "text.completed":
      return finalizeBlock(blocks, event.blockId, "text", event.timestamp);

    case "reasoning.delta": {
      const existing = findBlockOfType(blocks, event.blockId, "reasoning");
      if (existing) {
        const updated = {
          ...existing,
          content: existing.content + event.delta,
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "reasoning",
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          // First delta = start of thinking. The `...existing` spread on later
          // deltas and on finalize preserves this, while `timestamp` advances.
          startedAt: event.timestamp,
          content: event.delta,
        },
      ];
    }

    case "reasoning.completed":
      return finalizeBlock(blocks, event.blockId, "reasoning", event.timestamp);

    case "tool_call.started": {
      const startedAt = event.startedAt ?? event.timestamp;
      const existing = findBlockOfType(blocks, event.blockId, "tool_call");
      if (existing) {
        const updated = {
          ...existing,
          toolName: event.toolName,
          // Recompute display fields only when this event carries input; a
          // bare progress/completion event keeps the existing computed fields.
          ...(event.input === undefined
            ? {}
            : {
                ...toolInputDisplay(event.toolName, event.input),
                taskTodoItems: taskTodoItemsFromInput(
                  event.toolName,
                  event.input,
                ),
              }),
          parentBlockId: resolveParentBlockId(event, existing),
          timestamp: event.timestamp,
          startedAt: event.startedAt ?? existing.startedAt ?? startedAt,
          endedAt: existing.endedAt,
          agentMessageSend: event.agentMessageSend ?? existing.agentMessageSend,
          backgroundTask: mergeBackgroundTaskMarker(
            existing.backgroundTask,
            event.backgroundTask,
          ),
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "tool_call",
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          toolName: event.toolName,
          ...toolInputDisplay(event.toolName, event.input),
          taskTodoItems: taskTodoItemsFromInput(event.toolName, event.input),
          error: null,
          agentMessageSend: event.agentMessageSend,
          progress: null,
          backgroundOutput: null,
          startedAt,
          endedAt: null,
          backgroundTask: event.backgroundTask ?? null,
          stopped: false,
        },
      ];
    }

    case "tool_call.completed": {
      const existing = findBlockOfType(blocks, event.blockId, "tool_call");
      if (existing) {
        const updated = {
          ...existing,
          status: "completed" as const,
          parentBlockId: resolveParentBlockId(event, existing),
          timestamp: event.timestamp,
          agentMessageSend: event.agentMessageSend ?? existing.agentMessageSend,
          backgroundOutput: event.backgroundOutput ?? existing.backgroundOutput,
          startedAt: event.backgroundStartedAt ?? existing.startedAt,
          endedAt: event.timestamp,
          backgroundTask: mergeBackgroundTaskMarker(
            existing.backgroundTask,
            event.backgroundTask,
          ),
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "tool_call",
          blockId: event.blockId,
          status: "completed",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          toolName: event.toolName,
          inputSummary: null,
          inputDetail: null,
          taskTodoItems: null,
          error: null,
          agentMessageSend: event.agentMessageSend,
          progress: null,
          backgroundOutput: event.backgroundOutput ?? null,
          startedAt: event.backgroundStartedAt ?? null,
          endedAt: event.timestamp,
          backgroundTask: event.backgroundTask ?? null,
          stopped: false,
        },
      ];
    }

    case "tool_call.errored": {
      const existing = findBlockOfType(blocks, event.blockId, "tool_call");
      if (existing) {
        const updated = {
          ...existing,
          status: "errored" as const,
          stopped: event.terminationReason === "stopped",
          error: event.error,
          parentBlockId: resolveParentBlockId(event, existing),
          timestamp: event.timestamp,
          agentMessageSend: event.agentMessageSend ?? existing.agentMessageSend,
          backgroundOutput: event.backgroundOutput ?? existing.backgroundOutput,
          startedAt: event.backgroundStartedAt ?? existing.startedAt,
          endedAt: event.timestamp,
          backgroundTask: mergeBackgroundTaskMarker(
            existing.backgroundTask,
            event.backgroundTask,
          ),
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "tool_call",
          blockId: event.blockId,
          status: "errored",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          toolName: event.toolName,
          inputSummary: null,
          inputDetail: null,
          taskTodoItems: null,
          error: event.error,
          agentMessageSend: event.agentMessageSend,
          progress: null,
          backgroundOutput: event.backgroundOutput ?? null,
          startedAt: event.backgroundStartedAt ?? null,
          endedAt: event.timestamp,
          backgroundTask: event.backgroundTask ?? null,
          stopped: event.terminationReason === "stopped",
        },
      ];
    }

    case "tool_call.progress": {
      // Replace-latest: stamp the most recent progress line onto the owning
      // tool_call block. Deliberately does NOT advance `timestamp`; while the
      // block streams, timestamp still matches immutable `startedAt`, and once
      // finalized timestamp becomes the completion time for duration derivation.
      // Progress for a tool_call that doesn't exist (or a block of another
      // type) is meaningless - drop it.
      const existing = findBlockOfType(blocks, event.blockId, "tool_call");
      if (!existing) return blocks;
      return replaceBlock(blocks, event.blockId, {
        ...existing,
        progress: event.update,
      });
    }

    case "approval.requested": {
      return [
        ...blocks,
        {
          type: "approval",
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          toolName: event.toolName,
          description: event.description,
          ...toolInputDisplay(event.toolName ?? "", event.input),
          decision: null,
        },
      ];
    }

    case "approval.resolved": {
      const decision = normalizeApprovalDecision(event.decision);
      let blocksWithApproval: ContentBlock[];
      const existing = findBlockOfType(blocks, event.blockId, "approval");
      if (existing) {
        const updated = {
          ...existing,
          status: "completed" as const,
          decision,
          timestamp: event.timestamp,
        };
        blocksWithApproval = replaceBlock(blocks, event.blockId, updated);
      } else {
        blocksWithApproval = [
          ...blocks,
          {
            type: "approval",
            blockId: event.blockId,
            status: "completed",
            timestamp: event.timestamp,
            toolName: null,
            description: null,
            inputSummary: null,
            inputDetail: null,
            decision,
          },
        ];
      }
      return updatePlansForApprovalResolution(
        blocksWithApproval,
        event.blockId,
        decision,
        event.timestamp,
      );
    }

    case "todo.updated": {
      const existing = findBlockOfType(blocks, event.blockId, "todo");
      if (existing) {
        const updated = {
          ...existing,
          status: "completed" as const,
          items: event.items.map(normalizeTodoItem),
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "todo",
          blockId: event.blockId,
          status: "completed",
          timestamp: event.timestamp,
          items: event.items.map(normalizeTodoItem),
        },
      ];
    }

    case "plan.delta": {
      const existing = findPlanBlock(blocks, event.blockId, event.planId);
      if (existing) {
        const updated = applyAlreadyResolvedApproval(
          blocks,
          {
            ...existing,
            timestamp: event.timestamp,
            parentBlockId: resolveParentBlockId(event, existing),
            markdownPreview: existing.markdownPreview + event.delta,
          },
          event.timestamp,
        );
        return replaceBlock(blocks, existing.blockId, updated);
      }
      const created = applyAlreadyResolvedApproval(
        blocks,
        makePlanBlock({
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          planStatus: "drafting",
          planId: event.planId,
          source: event.source,
          title: null,
          summary: null,
          markdownPreview: event.delta,
          fullContentRef: null,
          steps: [],
          actions: [],
          approvalId: null,
          supersededByPlanId: null,
          metadata: null,
        }),
        event.timestamp,
      );
      return [...blocks, created];
    }

    case "plan.updated": {
      const existing = findPlanBlock(blocks, event.blockId, event.planId);
      if (existing) {
        const updated = applyAlreadyResolvedApproval(
          blocks,
          {
            ...existing,
            status: statusForPlanStatus(event.planStatus),
            timestamp: event.timestamp,
            parentBlockId: resolveParentBlockId(event, existing),
            planStatus: event.planStatus,
            planId: event.planId,
            harnessId: event.source.harnessId,
            source: event.source,
            title: event.title,
            summary: event.summary,
            markdownPreview: event.markdownPreview,
            fullContentRef: event.fullContentRef,
            steps: event.steps.map(normalizePlanStep),
            actions: event.actions.map(normalizePlanAction),
            approvalId: event.approvalId,
            supersededByPlanId: event.supersededByPlanId,
            metadata: event.metadata,
          },
          event.timestamp,
        );
        return replaceAndSupersedePlanBlock(
          blocks,
          existing.blockId,
          updated,
          event.timestamp,
        );
      }

      const created = applyAlreadyResolvedApproval(
        blocks,
        makePlanBlock({
          blockId: event.blockId,
          status: statusForPlanStatus(event.planStatus),
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          planStatus: event.planStatus,
          planId: event.planId,
          source: event.source,
          title: event.title,
          summary: event.summary,
          markdownPreview: event.markdownPreview,
          fullContentRef: event.fullContentRef,
          steps: event.steps.map(normalizePlanStep),
          actions: event.actions.map(normalizePlanAction),
          approvalId: event.approvalId,
          supersededByPlanId: event.supersededByPlanId,
          metadata: event.metadata,
        }),
        event.timestamp,
      );
      return supersedeActivePeerPlans(
        [...blocks, created],
        created,
        event.timestamp,
      );
    }

    case "plan.completed": {
      const existing = findPlanBlock(blocks, event.blockId, event.planId);
      if (existing) {
        const updated = applyAlreadyResolvedApproval(
          blocks,
          {
            ...existing,
            status: "completed",
            timestamp: event.timestamp,
            parentBlockId: resolveParentBlockId(event, existing),
            planStatus: event.planStatus,
            planId: event.planId,
            harnessId: event.source.harnessId,
            source: event.source,
            markdownPreview:
              event.markdownPreview === null
                ? existing.markdownPreview
                : event.markdownPreview,
            fullContentRef:
              event.fullContentRef === null
                ? existing.fullContentRef
                : event.fullContentRef,
            actions:
              event.actions.length === 0
                ? existing.actions
                : event.actions.map(normalizePlanAction),
            approvalId: event.approvalId ?? existing.approvalId,
          },
          event.timestamp,
        );
        return replaceAndSupersedePlanBlock(
          blocks,
          existing.blockId,
          updated,
          event.timestamp,
        );
      }

      const created = applyAlreadyResolvedApproval(
        blocks,
        makePlanBlock({
          blockId: event.blockId,
          status: "completed",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          planStatus: event.planStatus,
          planId: event.planId,
          source: event.source,
          title: null,
          summary: null,
          markdownPreview: event.markdownPreview ?? "",
          fullContentRef: event.fullContentRef,
          steps: [],
          actions: event.actions.map(normalizePlanAction),
          approvalId: event.approvalId,
          supersededByPlanId: null,
          metadata: null,
        }),
        event.timestamp,
      );
      return supersedeActivePeerPlans(
        [...blocks, created],
        created,
        event.timestamp,
      );
    }

    case "error": {
      const existing = findBlockOfType(blocks, event.blockId, "error");
      if (existing) {
        const updated = {
          ...existing,
          status: "errored" as const,
          message: event.message,
          recoverable: event.recoverable,
          code: event.code ?? null,
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "error",
          blockId: event.blockId,
          status: "errored",
          timestamp: event.timestamp,
          message: event.message,
          recoverable: event.recoverable,
          code: event.code ?? null,
        },
      ];
    }

    case "compaction.started": {
      const existing = findBlockOfType(blocks, event.blockId, "compaction");
      if (existing) {
        const updated = {
          ...existing,
          status: "streaming" as const,
          trigger: event.trigger ?? existing.trigger,
          preTokens: event.preTokens ?? existing.preTokens,
          summary: event.summary ?? existing.summary,
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "compaction",
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          trigger: event.trigger ?? null,
          preTokens: nullableNumber(event.preTokens),
          postTokens: null,
          durationMs: null,
          summary: nullableString(event.summary),
          error: null,
        },
      ];
    }

    case "compaction.completed": {
      const existing = findBlockOfType(blocks, event.blockId, "compaction");
      if (existing) {
        const updated = {
          ...existing,
          status: "completed" as const,
          trigger: event.trigger ?? existing.trigger,
          preTokens: event.preTokens ?? existing.preTokens,
          postTokens: event.postTokens ?? existing.postTokens,
          durationMs: event.durationMs ?? existing.durationMs,
          summary: event.summary ?? existing.summary,
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "compaction",
          blockId: event.blockId,
          status: "completed",
          timestamp: event.timestamp,
          trigger: event.trigger ?? null,
          preTokens: nullableNumber(event.preTokens),
          postTokens: nullableNumber(event.postTokens),
          durationMs: nullableNumber(event.durationMs),
          summary: nullableString(event.summary),
          error: null,
        },
      ];
    }

    case "compaction.errored": {
      const existing = findBlockOfType(blocks, event.blockId, "compaction");
      if (existing) {
        const updated = {
          ...existing,
          status: "errored" as const,
          trigger: event.trigger ?? existing.trigger,
          preTokens: event.preTokens ?? existing.preTokens,
          error: event.error,
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "compaction",
          blockId: event.blockId,
          status: "errored",
          timestamp: event.timestamp,
          trigger: event.trigger ?? null,
          preTokens: nullableNumber(event.preTokens),
          postTokens: null,
          durationMs: null,
          summary: null,
          error: event.error,
        },
      ];
    }

    case "interview.requested": {
      const existing = findBlockOfType(blocks, event.blockId, "interview");
      if (existing) {
        const updated = {
          ...existing,
          status: "streaming" as const,
          toolName: event.toolName,
          title: event.title ?? existing.title,
          description: event.description ?? existing.description,
          questions: [...event.questions],
          metadata: event.metadata ?? existing.metadata,
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "interview",
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          toolName: event.toolName,
          title: nullableString(event.title),
          description: nullableString(event.description),
          questions: [...event.questions],
          answers: [],
          error: null,
          metadata: nullableMetadata(event.metadata),
        },
      ];
    }

    case "interview.resolved": {
      const existing = findBlockOfType(blocks, event.blockId, "interview");
      if (existing) {
        const updated = {
          ...existing,
          status: "completed" as const,
          // A resolution that carries no answers must not erase answers already
          // recorded for this block. The OpenCode adapter resolves the card with
          // the user's real answers, then the converter emits a SECOND
          // `interview.resolved` whose answers are empty (OpenCode's question
          // tool output is an unparseable English sentence). Keep the recorded
          // answers so the card never regresses to "No answer".
          answers:
            event.answers.length > 0 ? [...event.answers] : existing.answers,
          metadata: event.metadata ?? existing.metadata,
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "interview",
          blockId: event.blockId,
          status: "completed",
          timestamp: event.timestamp,
          toolName: null,
          title: null,
          description: null,
          questions: [],
          answers: [...event.answers],
          error: null,
          metadata: nullableMetadata(event.metadata),
        },
      ];
    }

    case "interview.errored": {
      const existing = findBlockOfType(blocks, event.blockId, "interview");
      if (existing) {
        const updated = {
          ...existing,
          status: "errored" as const,
          error: event.error,
          metadata: event.metadata ?? existing.metadata,
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "interview",
          blockId: event.blockId,
          status: "errored",
          timestamp: event.timestamp,
          toolName: null,
          title: null,
          description: null,
          questions: [],
          answers: [],
          error: event.error,
          metadata: nullableMetadata(event.metadata),
        },
      ];
    }

    case "file_change.started": {
      return [
        ...blocks,
        {
          type: "file_change",
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          filePath: event.filePath,
          operation: event.operation,
          diffSource: "none",
          beforeHash: null,
          afterHash: null,
          additions: 0,
          deletions: 0,
          reason: "capture_failed",
        },
      ];
    }

    case "file_change.completed": {
      const existing = findBlockOfType(blocks, event.blockId, "file_change");
      if (existing) {
        return replaceBlock(blocks, event.blockId, {
          ...existing,
          status: "completed",
          timestamp: event.timestamp,
          // `file_change.completed` may carry the owning subagent even when the
          // earlier `file_change.started` (emitted from the permission callback)
          // could not - adopt it so the finished card nests correctly.
          parentBlockId: resolveParentBlockId(event, existing),
          diffSource: event.diffSource,
          beforeHash: event.beforeHash,
          afterHash: event.afterHash,
          additions: event.additions,
          deletions: event.deletions,
          reason: event.reason,
        });
      }
      return [
        ...blocks,
        {
          type: "file_change",
          blockId: event.blockId,
          status: "completed",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          filePath: event.filePath,
          operation: event.operation,
          diffSource: event.diffSource,
          beforeHash: event.beforeHash,
          afterHash: event.afterHash,
          additions: event.additions,
          deletions: event.deletions,
          reason: event.reason,
        },
      ];
    }

    case "artifact_operation": {
      // A single terminal event - upsert one block keyed by `blockId`. A
      // re-emit (e.g. a late create-id resolution replacing an earlier emit
      // for the same action+index) overwrites in place rather than duplicating.
      const existing = findBlockOfType(
        blocks,
        event.blockId,
        "artifact_operation",
      );
      if (existing) {
        return replaceBlock(blocks, event.blockId, {
          ...existing,
          status: "completed",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, existing),
          operation: event.operation,
          kind: event.kind,
          artifactId: event.artifactId,
          title: event.title ?? null,
          beforeHash:
            event.beforeHash !== undefined
              ? event.beforeHash
              : existing.beforeHash,
          afterHash:
            event.afterHash !== undefined
              ? event.afterHash
              : existing.afterHash,
        });
      }
      return [
        ...blocks,
        {
          type: "artifact_operation",
          blockId: event.blockId,
          status: "completed",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          operation: event.operation,
          kind: event.kind,
          artifactId: event.artifactId,
          title: event.title ?? null,
          beforeHash: event.beforeHash ?? null,
          afterHash: event.afterHash ?? null,
        },
      ];
    }

    case "command.started": {
      return [
        ...blocks,
        {
          type: "command",
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          command: event.command,
          cwd: nullableString(event.cwd),
          exitCode: null,
          parentBlockId: resolveParentBlockId(event, undefined),
        },
      ];
    }

    case "command.completed": {
      const existing = findBlockOfType(blocks, event.blockId, "command");
      if (existing) {
        const updated = {
          ...existing,
          status: "completed" as const,
          exitCode: event.exitCode ?? existing.exitCode,
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, existing),
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        {
          type: "command",
          blockId: event.blockId,
          status: "completed",
          timestamp: event.timestamp,
          command: event.command,
          cwd: null,
          exitCode: nullableNumber(event.exitCode),
          parentBlockId: resolveParentBlockId(event, undefined),
        },
      ];
    }

    case "subagent.started": {
      // A sub-agent's name can be re-emitted after its block opens: Codex never
      // pushes the agent nickname, so the adapter fetches it asynchronously and
      // re-emits `subagent.started` once it resolves. Update the open block's
      // name/task in place rather than appending a duplicate card.
      const existing = findBlockOfType(blocks, event.blockId, "subagent");
      if (existing) {
        return replaceBlock(blocks, event.blockId, {
          ...existing,
          name: event.name,
          // agentType resolves with the name (both come from the async fetch);
          // preserve the prior value when a re-emit omits it.
          agentType: event.agentType ?? existing.agentType,
          task: nullableString(event.task) ?? existing.task,
          parentBlockId: resolveParentBlockId(event, existing),
          // Advance `timestamp` only while still streaming. Codex re-emits
          // `subagent.started` (async nickname fetch) which can land AFTER the
          // sub-agent already completed; bumping a terminal block's timestamp
          // would push its completion anchor forward and inflate the card's
          // derived duration. `startedAt` is preserved via `...existing`.
          timestamp:
            existing.status === "streaming"
              ? event.timestamp
              : existing.timestamp,
          // Keep the first known spawn tool id; a re-emit (e.g. Codex's async
          // nickname fetch) carries no tool id and must not clear it.
          spawnToolCallId:
            existing.spawnToolCallId ?? event.spawnToolCallId ?? null,
        });
      }
      return [
        ...blocks,
        makeSubAgentBlock({
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          startedAt: event.timestamp,
          name: event.name,
          agentType: event.agentType ?? null,
          task: nullableString(event.task),
          progressUpdates: [],
          result: null,
          spawnToolCallId: event.spawnToolCallId ?? null,
          stopped: false,
          workflowMeta: null,
        }),
      ];
    }

    case "subagent.progress": {
      const existing = findBlockOfType(blocks, event.blockId, "subagent");
      if (existing) {
        const updated = {
          ...existing,
          progressUpdates: [...existing.progressUpdates, event.update],
          parentBlockId: resolveParentBlockId(event, existing),
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        makeSubAgentBlock({
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          // First signal we have for this card; the true spawn is earlier but
          // unknown, so anchor the live timer here.
          startedAt: event.timestamp,
          name: null,
          agentType: null,
          task: null,
          progressUpdates: [event.update],
          result: null,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
        }),
      ];
    }

    case "subagent.completed": {
      const existing = findBlockOfType(blocks, event.blockId, "subagent");
      // `outcome` is defaulted "completed" on the wire (see agent-runtime.ts),
      // so an old emitter that never sets it reproduces today's shipped
      // behavior exactly. Only "failed"/"stopped" diverge from "completed".
      const status: "completed" | "errored" =
        event.outcome === "completed" ? "completed" : "errored";
      const stopped = event.outcome === "stopped";
      if (existing) {
        const updated = {
          ...existing,
          status,
          stopped,
          result: event.result ?? existing.result,
          parentBlockId: resolveParentBlockId(event, existing),
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        makeSubAgentBlock({
          blockId: event.blockId,
          status,
          stopped,
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          // No `started` was seen, so the spawn time is unknown. Leave it null
          // (rather than the completion time) so the card shows no duration
          // instead of a misleading "0s" total.
          startedAt: null,
          name: null,
          agentType: null,
          task: null,
          progressUpdates: [],
          result: nullableString(event.result),
          spawnToolCallId: null,
          workflowMeta: null,
        }),
      ];
    }

    case "workflow.started": {
      // Mirrors `subagent.started`: update the open card in place on a
      // re-emit (never clearing `parentBlockId`/`spawnToolCallId`), otherwise
      // open a fresh dual-written subagent block.
      const existing = findBlockOfType(blocks, event.blockId, "subagent");
      if (existing) {
        const meta = existing.workflowMeta ?? emptyWorkflowMeta(event.name);
        // A re-emit's `intent` is a required key but not necessarily a
        // meaningful one - only a genuine non-null value overwrites, mirroring
        // the preserve-on-omit policy every other re-emittable field here uses.
        const intent = event.intent ?? meta.intent;
        return replaceBlock(blocks, event.blockId, {
          ...existing,
          name: event.name,
          task: intent ?? existing.task,
          parentBlockId: resolveParentBlockId(event, existing),
          timestamp:
            existing.status === "streaming"
              ? event.timestamp
              : existing.timestamp,
          spawnToolCallId:
            existing.spawnToolCallId ?? event.spawnToolCallId ?? null,
          workflowMeta: {
            ...meta,
            name: event.name,
            intent,
          },
        });
      }
      return [
        ...blocks,
        makeSubAgentBlock({
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          startedAt: event.timestamp,
          name: event.name,
          agentType: null,
          task: event.intent,
          progressUpdates: [],
          result: null,
          spawnToolCallId: event.spawnToolCallId ?? null,
          stopped: false,
          workflowMeta: {
            ...emptyWorkflowMeta(event.name),
            intent: event.intent,
          },
        }),
      ];
    }

    case "workflow.progress": {
      const existing = findBlockOfType(blocks, event.blockId, "subagent");
      const progressLine =
        event.activity !== null ? event.activity.text : null;
      if (existing) {
        const meta = existing.workflowMeta ?? emptyWorkflowMeta(existing.name);
        const updated = {
          ...existing,
          progressUpdates:
            progressLine !== null
              ? [...existing.progressUpdates, progressLine]
              : existing.progressUpdates,
          parentBlockId: resolveParentBlockId(event, existing),
          timestamp: event.timestamp,
          workflowMeta: {
            ...meta,
            activity: appendWorkflowActivity(meta.activity, event.activity),
            agentsStarted: event.agentsStarted ?? meta.agentsStarted,
            agentsFinished: event.agentsFinished ?? meta.agentsFinished,
            totalTokens: event.totalTokens ?? meta.totalTokens,
          },
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      const meta = emptyWorkflowMeta(null);
      return [
        ...blocks,
        makeSubAgentBlock({
          blockId: event.blockId,
          status: "streaming",
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          // First signal we have for this card; the true spawn is earlier but
          // unknown, so anchor the live timer here.
          startedAt: event.timestamp,
          name: null,
          agentType: null,
          task: null,
          progressUpdates: progressLine !== null ? [progressLine] : [],
          result: null,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: {
            ...meta,
            activity: appendWorkflowActivity(meta.activity, event.activity),
            agentsStarted: event.agentsStarted ?? null,
            agentsFinished: event.agentsFinished ?? null,
            totalTokens: event.totalTokens ?? null,
          },
        }),
      ];
    }

    case "workflow.completed": {
      const existing = findBlockOfType(blocks, event.blockId, "subagent");
      // `outcome` is defaulted "completed", mirroring `subagent.completed`.
      const status: "completed" | "errored" =
        event.outcome === "completed" ? "completed" : "errored";
      const stopped = event.outcome === "stopped";
      if (existing) {
        const updated = {
          ...existing,
          status,
          stopped,
          result: event.result ?? existing.result,
          parentBlockId: resolveParentBlockId(event, existing),
          timestamp: event.timestamp,
        };
        return replaceBlock(blocks, event.blockId, updated);
      }
      return [
        ...blocks,
        makeSubAgentBlock({
          blockId: event.blockId,
          status,
          stopped,
          timestamp: event.timestamp,
          parentBlockId: resolveParentBlockId(event, undefined),
          // No `started` was seen, so the spawn time is unknown. Leave it null
          // (rather than the completion time) so the card shows no duration
          // instead of a misleading "0s" total.
          startedAt: null,
          name: null,
          agentType: null,
          task: null,
          progressUpdates: [],
          result: nullableString(event.result),
          spawnToolCallId: null,
          workflowMeta: emptyWorkflowMeta(null),
        }),
      ];
    }

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return blocks;
    }
  }
}
