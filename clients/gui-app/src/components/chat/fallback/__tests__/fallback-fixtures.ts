import type {
  BackgroundItem,
  ChatRunSettings,
  FallbackImpendingAction,
  FallbackWaitDisposition,
  LastFailedAttempt,
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ChatFallbackListTargetsResponse,
  FallbackModelTarget,
  FallbackProfileTarget,
  FallbackTargetSkip,
} from "@traycer/protocol/host/chat-fallback";
import type { AgentFailure } from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * Fixture builders for provider-fallback GUI tests.
 *
 * Every field a test depends on is passed in at the call site. The few
 * tuple fields that no surface under test reads (permission mode, reasoning,
 * service tier, agent mode) are filled here so each test is not a protocol
 * schema dump.
 */

export function chatRunSettings(input: {
  readonly harnessId: ChatRunSettings["harnessId"];
  readonly model: string;
  readonly profileId: string | null;
}): ChatRunSettings {
  return {
    harnessId: input.harnessId,
    model: input.model,
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: input.profileId,
  };
}

export function pendingFallback(input: {
  readonly state: PendingFallback["state"];
  readonly reason: string;
  readonly failedTuple: ChatRunSettings;
  readonly targetTuple: ChatRunSettings | null;
  readonly impendingAction: FallbackImpendingAction | null;
  readonly deadline: number | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly queuedItemsMoving: number;
  readonly siblingSwitching: number;
  readonly traversalId: string;
  readonly revision: number;
}): PendingFallback {
  return {
    traversalId: input.traversalId,
    revision: input.revision,
    state: input.state,
    reason: input.reason,
    failedTuple: input.failedTuple,
    targetTuple: input.targetTuple,
    impendingAction: input.impendingAction,
    deadline: input.deadline,
    graceRemainingMs: null,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    queuedItemsMoving: input.queuedItemsMoving,
    siblingSwitching: input.siblingSwitching,
  };
}

/**
 * A `fallbackImpendingAction` plan - what the host says it will do when the
 * current countdown ends.
 *
 * `planId` is opaque and for comparison only (see the schema doc), so tests
 * that only render a plan's fields can pass a fixed id; a test asserting on
 * plan-change announcements should vary it explicitly at the call site.
 */
export function fallbackImpendingAction(input: {
  readonly planId: string;
  readonly rung: FallbackImpendingAction["rung"];
  readonly target: ChatRunSettings | null;
  readonly targetModelFamily: string | null;
  readonly resumesAt: number | null;
  readonly pending: FallbackImpendingAction["pending"];
}): FallbackImpendingAction {
  return {
    planId: input.planId,
    rung: input.rung,
    target: input.target,
    targetModelFamily: input.targetModelFamily,
    resumesAt: input.resumesAt,
    pending: input.pending,
  };
}

export function pendingReturn(input: {
  readonly preferredTuple: ChatRunSettings;
  readonly fallbackTuple: ChatRunSettings;
  readonly queuedItemsMoving: number;
  readonly traversalId: string;
  readonly revision: number;
}): PendingReturn {
  return {
    traversalId: input.traversalId,
    revision: input.revision,
    preferredTuple: input.preferredTuple,
    fallbackTuple: input.fallbackTuple,
    queuedItemsMoving: input.queuedItemsMoving,
    offeredAt: 1_700_000_000_000,
  };
}

export function fallbackWaitBackgroundItem(input: {
  readonly providerId: string;
  readonly profileLabel: string | null;
  readonly scheduledFor: number;
  readonly title: string;
  readonly taskId: string;
}): Extract<BackgroundItem, { kind: "fallback-wait" }> {
  return {
    kind: "fallback-wait",
    taskId: input.taskId,
    title: input.title,
    blockId: input.taskId,
    parentTaskId: null,
    scheduledFor: input.scheduledFor,
    providerId: input.providerId,
    profileLabel: input.profileLabel,
  };
}

export function wakeupBackgroundItem(input: {
  readonly scheduledFor: number;
  readonly title: string;
  readonly taskId: string;
}): Extract<BackgroundItem, { kind: "wakeup" }> {
  return {
    kind: "wakeup",
    taskId: input.taskId,
    title: input.title,
    blockId: input.taskId,
    parentTaskId: null,
    scheduledFor: input.scheduledFor,
  };
}

export const FAILED_CLAUDE_TUPLE = chatRunSettings({
  harnessId: "claude",
  model: "claude-sonnet-4",
  profileId: "failed01-profile",
});

export const TARGET_CODEX_TUPLE = chatRunSettings({
  harnessId: "codex",
  model: "gpt-5",
  profileId: "target01-profile",
});

export const PREFERRED_CLAUDE_TUPLE = chatRunSettings({
  harnessId: "claude",
  model: "claude-sonnet-4",
  profileId: "prefer01-profile",
});

export const BANNED_VOCABULARY = /\b(tier|ladder|rung|grace|inherit)\b/i;

export function lastFailedAttempt(input: {
  readonly userMessageId: string;
  readonly turnId: string;
  readonly failure: AgentFailure;
  readonly eligibleRungs: ReadonlyArray<"retry" | "switch" | "wait_once">;
  readonly waitDisposition: FallbackWaitDisposition;
}): LastFailedAttempt {
  return {
    userMessageId: input.userMessageId,
    turnId: input.turnId,
    failure: input.failure,
    eligibleRungs: [...input.eligibleRungs],
    waitDisposition: input.waitDisposition,
  };
}

export function fallbackSkip(input: {
  readonly reason: string;
  readonly label: string;
}): FallbackTargetSkip {
  return { reason: input.reason, label: input.label };
}

export function fallbackProfileTarget(input: {
  readonly profileId: string | null;
  readonly label: string;
  readonly severity: string;
  readonly usedPercent: number | null;
  readonly recommended: boolean;
  readonly selectable: boolean;
  readonly skip: FallbackTargetSkip | null;
}): FallbackProfileTarget {
  return {
    profileId: input.profileId,
    label: input.label,
    severity: input.severity,
    usedPercent: input.usedPercent,
    recommended: input.recommended,
    selectable: input.selectable,
    skip: input.skip,
  };
}

export function fallbackModelTarget(input: {
  readonly groupId: string;
  readonly harnessId: string;
  readonly modelFamily: string;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly profileId: string | null;
  readonly severity: string;
  readonly usedPercent: number | null;
  readonly target: ChatRunSettings | null;
  readonly warnings: ReadonlyArray<string>;
  readonly selectable: boolean;
  readonly skip: FallbackTargetSkip | null;
}): FallbackModelTarget {
  return {
    groupId: input.groupId,
    harnessId: input.harnessId,
    modelFamily: input.modelFamily,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    profileId: input.profileId,
    severity: input.severity,
    usedPercent: input.usedPercent,
    target: input.target,
    warnings: [...input.warnings],
    selectable: input.selectable,
    skip: input.skip,
  };
}

export function listTargetsResponse(input: {
  readonly outcome: ChatFallbackListTargetsResponse["outcome"];
  readonly failedTuple: ChatRunSettings | null;
  readonly profileTargets: ReadonlyArray<FallbackProfileTarget>;
  readonly modelTargets: ReadonlyArray<FallbackModelTarget>;
  readonly modelTargetsSkip: FallbackTargetSkip | null;
}): ChatFallbackListTargetsResponse {
  return {
    outcome: input.outcome,
    failedTuple: input.failedTuple,
    profileTargets: [...input.profileTargets],
    modelTargets: [...input.modelTargets],
    modelTargetsSkip: input.modelTargetsSkip,
  };
}
