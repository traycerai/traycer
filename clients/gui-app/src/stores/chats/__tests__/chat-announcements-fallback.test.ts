import { describe, expect, it } from "vitest";
import type {
  ChatRunSettings,
  LastFallbackOutcome,
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ProviderNoticeDetail,
  ProviderNoticeKind,
} from "@traycer/protocol/persistence/epic/content-blocks";
import type {
  ChatMessage,
  ProviderNoticeSegment,
} from "@/stores/composer/chat-store";
import {
  DONT_SWITCH_LABEL,
  FRESH_SESSION_HELPER,
  STOP_WAITING_LABEL,
} from "@/components/chat/fallback/fallback-copy";
import { formatClockTime } from "@/lib/relative-time";
import {
  createFallbackAnnouncementObserver,
  fallbackNoticeAnnouncements,
  fallbackOutcomeAnnouncement,
  fallbackReturnAnnouncement,
  fallbackTraversalAnnouncement,
  type FallbackAnnouncement,
  type FallbackAnnouncementPlan,
  type FallbackAnnouncementsInput,
  type FallbackNoticeAnnouncement,
  type FallbackTraversalAnnouncement,
} from "@/stores/chats/chat-announcements";

/**
 * F22 pure-deriver pins for `chat-announcements.ts`'s fallback exports.
 *
 * These test the ADAPTER's frozen sentences and the OBSERVER's provenance
 * rules, entirely independent of React, the store, and the eventual
 * `ChatMessages` live region - which is why every expected string is composed
 * here from the same copy CONSTANTS the source imports, never read back from
 * the source's own output. Fallback announcement text is never task-title
 * prefixed by the UI - unlike regular turn-completion text, which goes
 * through a different formatting path - so every string below is asserted
 * exactly as the adapter/observer hand it out, with no prefix expected.
 */

const NOW = Date.parse("2026-06-01T12:00:00.000Z");

// Two tuples on the SAME provider/model FAMILY ("gpt-6-astra") but different
// exact model slugs, and a third tuple on a DIFFERENT provider reusing the
// FIRST tuple's account label - so any test that would pass by matching on a
// model-family prefix or a bare label string, instead of the full tuple,
// fails loudly.
const FAILED_TUPLE: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-6-astra",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: "acct-north",
};
const TARGET_TUPLE: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-6-astra-mini",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: "acct-south",
};
// Duplicate account LABEL ("acct-north") as `FAILED_TUPLE`, but a different
// provider (claude, not codex) and a different model family entirely.
const PREFERRED_TUPLE: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-opus-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: "acct-north",
};

const FAILED_IDENTITY = "Astra Codex (acct-north)";
const TARGET_IDENTITY = "Astra Mini Codex (acct-south)";
const PREFERRED_IDENTITY = "Opus Claude (acct-north)";

function plan(input: {
  readonly planId: string;
  readonly action: FallbackAnnouncementPlan["action"];
  readonly destination: string | null;
  readonly resumesAt: number | null;
}): FallbackAnnouncementPlan {
  return {
    planId: input.planId,
    action: input.action,
    destination: input.destination,
    resumesAt: input.resumesAt,
  };
}

function pendingFallback(input: {
  readonly state: PendingFallback["state"];
  readonly traversalId: string;
  readonly revision: number;
  readonly deadline: number | null;
  readonly queuedItemsMoving: number;
}): PendingFallback {
  return {
    traversalId: input.traversalId,
    revision: input.revision,
    state: input.state,
    reason: "rate_limit",
    failedTuple: FAILED_TUPLE,
    targetTuple: TARGET_TUPLE,
    // Not read by `fallbackTraversalAnnouncement` itself (the adapter takes a
    // separately-built `plan`) - required-and-nullable on the DTO, so an
    // explicit `null` here, never an omission.
    impendingAction: null,
    deadline: input.deadline,
    graceRemainingMs: null,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: input.queuedItemsMoving,
    siblingSwitching: 0,
  };
}

function pendingReturn(input: {
  readonly traversalId: string;
  readonly revision: number;
  readonly queuedItemsMoving: number;
}): PendingReturn {
  return {
    traversalId: input.traversalId,
    revision: input.revision,
    preferredTuple: PREFERRED_TUPLE,
    fallbackTuple: TARGET_TUPLE,
    queuedItemsMoving: input.queuedItemsMoving,
    offeredAt: NOW,
  };
}

/** Built FULL rather than cast into shape - see transcript-list-rows.test.ts. */
function providerNoticeSegment(input: {
  readonly id: string;
  readonly noticeKind: ProviderNoticeKind;
  readonly status: ProviderNoticeSegment["status"];
  readonly parentId: string | null;
  readonly title: string;
  readonly message: string | null;
  readonly details: ReadonlyArray<ProviderNoticeDetail>;
}): ProviderNoticeSegment {
  return {
    id: input.id,
    kind: "provider_notice",
    status: input.status,
    noticeKind: input.noticeKind,
    tone: "info",
    title: input.title,
    message: input.message,
    details: input.details,
    parentId: input.parentId,
  };
}

function assistantMessage(input: {
  readonly id: string;
  readonly segments: ReadonlyArray<ProviderNoticeSegment>;
}): ChatMessage {
  return {
    id: input.id,
    role: "assistant",
    content: "",
    segments: input.segments,
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: NOW,
    completedAt: NOW,
    stopped: null,
    persistentMessageId: input.id,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

/** No leading `"<task title>: "` (or similar) artifact - the UI layer's job, not the observer's. */
function expectUnprefixed(text: string): void {
  expect(text).not.toMatch(/^[^:]{1,60}:\s/);
}

describe("fallbackTraversalAnnouncement", () => {
  it("is null for a retrying or absent traversal - the transient row already announces its own attempts", () => {
    expect(
      fallbackTraversalAnnouncement({
        pending: pendingFallback({
          state: "retrying",
          traversalId: "t1",
          revision: 1,
          deadline: null,
          queuedItemsMoving: 0,
        }),
        plan: null,
        failedIdentity: FAILED_IDENTITY,
        targetIdentity: null,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      fallbackTraversalAnnouncement({
        pending: undefined,
        plan: null,
        failedIdentity: FAILED_IDENTITY,
        targetIdentity: null,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("hold: states the action, the exact cancel duration, and the REAL 'Don't switch' button label - never a raw countdown noun", () => {
    const result = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "hold",
        traversalId: "t1",
        revision: 1,
        deadline: NOW + 12_000,
        queuedItemsMoving: 2,
      }),
      plan: plan({
        planId: "plan-switch-1",
        action: "switch",
        destination: TARGET_IDENTITY,
        resumesAt: null,
      }),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    });
    expect(result).not.toBeNull();
    const text = result?.text ?? "";
    expect(text).toContain(`The chat will switch to ${TARGET_IDENTITY}.`);
    expect(text).toContain(FRESH_SESSION_HELPER);
    expect(text).toContain(
      "2 queued messages will run on the new settings too.",
    );
    expect(text).toContain("You have 12 seconds to cancel.");
    // The REAL button label, imported from the copy module - never a
    // hand-typed "Cancel" or "Don't Switch" that could silently drift from it.
    expect(text).toContain(`Select ${DONT_SWITCH_LABEL} to cancel.`);
    expectUnprefixed(text);
    // Negative half: the banned-vocabulary words never leak into user prose.
    expect(text).not.toMatch(/\b(tier|ladder|rung|grace|inherit)\b/i);
  });

  it("hold: a retry/wait/notify plan omits the fresh-session helper - only a switch destination carries that consequence", () => {
    const retryText = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "hold",
        traversalId: "t1",
        revision: 1,
        deadline: NOW + 5_000,
        queuedItemsMoving: 0,
      }),
      plan: plan({
        planId: "plan-retry-1",
        action: "retry",
        destination: null,
        resumesAt: null,
      }),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    expect(retryText).toContain(`The chat will retry on ${FAILED_IDENTITY}.`);
    // Falsification: drop the `plan?.action === "switch"` guard around the
    // fresh-session clause and this goes red for every action, not only switch.
    expect(retryText).not.toContain(FRESH_SESSION_HELPER);

    const waitText = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "hold",
        traversalId: "t1",
        revision: 1,
        deadline: NOW + 5_000,
        queuedItemsMoving: 0,
      }),
      plan: plan({
        planId: "plan-wait-1",
        action: "wait",
        destination: null,
        resumesAt: NOW + 3_600_000,
      }),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    // Wait-plan hold text names the FAILED provider and the real resume time.
    expect(waitText).toContain(
      `The chat will wait for ${FAILED_IDENTITY} and resume at ${formatClockTime(NOW + 3_600_000)}.`,
    );
    expect(waitText).not.toContain(FRESH_SESSION_HELPER);
  });

  it("hold: a due-now deadline states that plainly instead of inventing a positive second count", () => {
    const text = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "hold",
        traversalId: "t1",
        revision: 1,
        deadline: NOW,
        queuedItemsMoving: 0,
      }),
      plan: plan({
        planId: "plan-notify-1",
        action: "notify",
        destination: null,
        resumesAt: null,
      }),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    expect(text).toContain(
      "No fallback destination is available. The chat will stop and keep the error visible.",
    );
    expect(text).toContain("The fallback is due now.");
    // Falsification: drop the `seconds === 0` branch in `cancelOpportunityText`
    // and this becomes "You have 0 seconds to cancel." instead.
    expect(text).not.toContain("0 seconds");
  });

  it("hold: a null plan (host found no takeable rung) states exhaustion truthfully, distinct from a genuinely still-resolving 'checking' plan and from an unresolved switch destination", () => {
    // `impendingAction: null` on the real F5 DTO means exhaustion, not
    // "still resolving" - `plan === null` here must read the same way.
    const exhausted = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "hold",
        traversalId: "t1",
        revision: 1,
        deadline: NOW + 5_000,
        queuedItemsMoving: 0,
      }),
      plan: null,
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    expect(exhausted).toContain(
      "No fallback destination is available. The chat will stop and keep the error visible.",
    );
    // Falsification: revert `fallbackPlanText(null)` to "The host is
    // checking the next fallback action." - an exhausted traversal would
    // then read as if the host were still working on it.
    expect(exhausted).not.toContain("checking");

    // A RESOLVED plan whose action is itself "checking" (host mid-resolve,
    // e.g. `resolving`/`awaiting_reset_check`) is the genuinely distinct case.
    const stillResolving = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "hold",
        traversalId: "t1",
        revision: 1,
        deadline: NOW + 5_000,
        queuedItemsMoving: 0,
      }),
      plan: plan({
        planId: "plan-checking-1",
        action: "checking",
        destination: null,
        resumesAt: null,
      }),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    expect(stillResolving).toContain(
      "The host is checking the next fallback action.",
    );

    // And a RESOLVED switch plan whose destination is not yet chosen is a
    // third, separate sentence - none of these three may collide.
    const unresolvedDestination = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "hold",
        traversalId: "t1",
        revision: 1,
        deadline: NOW + 5_000,
        queuedItemsMoving: 0,
      }),
      plan: plan({
        planId: "plan-switch-unresolved",
        action: "switch",
        destination: null,
        resumesAt: null,
      }),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    expect(unresolvedDestination).toContain(
      "The host is checking the next destination.",
    );
    expect(unresolvedDestination).not.toBe(stillResolving);
    expect(unresolvedDestination).not.toBe(exhausted);
    expect(stillResolving).not.toBe(exhausted);
  });

  it("switching: names the resolved target identity, preferring it over the plan's own destination", () => {
    const withTarget = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "switching",
        traversalId: "t1",
        revision: 2,
        deadline: null,
        queuedItemsMoving: 0,
      }),
      plan: plan({
        planId: "plan-switch-1",
        action: "switch",
        destination: "some other label the plan carries",
        resumesAt: null,
      }),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: TARGET_IDENTITY,
      now: NOW,
    })?.text;
    expect(withTarget).toBe(`Switching this chat to ${TARGET_IDENTITY}.`);

    const planOnly = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "switching",
        traversalId: "t1",
        revision: 2,
        deadline: null,
        queuedItemsMoving: 0,
      }),
      plan: plan({
        planId: "plan-switch-1",
        action: "switch",
        destination: TARGET_IDENTITY,
        resumesAt: null,
      }),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    expect(planOnly).toBe(`Switching this chat to ${TARGET_IDENTITY}.`);

    const neither = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "switching",
        traversalId: "t1",
        revision: 2,
        deadline: null,
        queuedItemsMoving: 0,
      }),
      plan: null,
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    expect(neither).toBe("The host is preparing the provider switch.");
  });

  it("waiting: names the failed provider and the real resume time, or a fallback line with no time when there is none", () => {
    const withDeadline = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "waiting",
        traversalId: "t1",
        revision: 3,
        deadline: NOW + 7_200_000,
        queuedItemsMoving: 0,
      }),
      plan: null,
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    expect(withDeadline).toBe(
      `Waiting for ${FAILED_IDENTITY}. Resuming at ${formatClockTime(NOW + 7_200_000)}. Select ${STOP_WAITING_LABEL} to cancel.`,
    );

    const withoutDeadline = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "waiting",
        traversalId: "t1",
        revision: 3,
        deadline: null,
        queuedItemsMoving: 0,
      }),
      plan: null,
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    expect(withoutDeadline).toBe(
      `Waiting for ${FAILED_IDENTITY}. The host will resume when the verified reset is ready. Select ${STOP_WAITING_LABEL} to cancel.`,
    );
    // Negative half: never the switching card's action words on a wait.
    expect(withoutDeadline).not.toContain("switch");
  });

  it("semanticKey: differs by state and by planId, but is identical across two calls with the same state/plan even if `now` moves", () => {
    const base = {
      pending: pendingFallback({
        state: "hold" as const,
        traversalId: "t1",
        revision: 1,
        deadline: NOW + 30_000,
        queuedItemsMoving: 0,
      }),
      plan: plan({
        planId: "plan-a",
        action: "wait" as const,
        destination: null,
        resumesAt: NOW + 60_000,
      }),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
    };
    const first = fallbackTraversalAnnouncement({ ...base, now: NOW });
    const laterTick = fallbackTraversalAnnouncement({
      ...base,
      now: NOW + 5_000,
    });
    expect(first?.semanticKey).toBe(laterTick?.semanticKey);
    // A DIFFERENT plan (planId changed) is a different semantic key even
    // though the state is unchanged.
    const differentPlan = fallbackTraversalAnnouncement({
      ...base,
      plan: plan({
        planId: "plan-b",
        action: "wait",
        destination: null,
        resumesAt: NOW + 60_000,
      }),
      now: NOW,
    });
    expect(differentPlan?.semanticKey).not.toBe(first?.semanticKey);
    // A DIFFERENT state (same plan) is also a different semantic key.
    const differentState = fallbackTraversalAnnouncement({
      ...base,
      pending: pendingFallback({
        state: "choosing",
        traversalId: "t1",
        revision: 2,
        deadline: null,
        queuedItemsMoving: 0,
      }),
      now: NOW,
    });
    expect(differentState?.semanticKey).not.toBe(first?.semanticKey);
  });
});

describe("fallbackReturnAnnouncement", () => {
  it("is null with no pending offer", () => {
    expect(
      fallbackReturnAnnouncement(undefined, PREFERRED_IDENTITY),
    ).toBeNull();
  });

  it("names the preferred identity, states the switch-back consequence, the queue clause, and the fresh-session helper - in that order", () => {
    const announcement = fallbackReturnAnnouncement(
      pendingReturn({ traversalId: "t1", revision: 1, queuedItemsMoving: 3 }),
      PREFERRED_IDENTITY,
    );
    // The queue clause is folded INTO the "Switching back applies..."
    // sentence (no leading-space artifact, no double space): composed here
    // from the same three copy pieces the source joins, not read back from
    // the source's own output.
    expect(announcement?.text).toBe(
      `${PREFERRED_IDENTITY} is available again. You can switch back or stay on the current provider. ` +
        `Switching back applies to your next message and moves 3 queued messages back. ` +
        FRESH_SESSION_HELPER,
    );
    // Falsification: swap `parts.join(" ")`'s clause composition back to a
    // bare `queuedMessagesReturningText(count)` appended as its own part
    // (its leading space stacks with the join separator) - this exact string
    // goes red with a double space before "and moves".
    expect(announcement?.text).toContain(PREFERRED_IDENTITY);
    expect(announcement?.text).toContain("3 queued messages");
    expect(announcement?.text).not.toContain("  "); // no double space anywhere
    expectUnprefixed(announcement?.text ?? "");
  });

  it("omits the queued-messages clause entirely at zero, rather than rendering a zero count, but still states the switch-back consequence and fresh-session helper", () => {
    const announcement = fallbackReturnAnnouncement(
      pendingReturn({ traversalId: "t1", revision: 1, queuedItemsMoving: 0 }),
      PREFERRED_IDENTITY,
    );
    expect(announcement?.text).toBe(
      `${PREFERRED_IDENTITY} is available again. You can switch back or stay on the current provider. ` +
        `Switching back applies to your next message. ` +
        FRESH_SESSION_HELPER,
    );
    // Falsification: drop the `returning ?? ""` fallback in
    // `fallbackReturnAnnouncement` and this contains "moves 0 queued messages".
    expect(announcement?.text).not.toContain("0 queued");
    expect(announcement?.text).not.toContain("  ");
  });
});

describe("fallbackNoticeAnnouncements", () => {
  it("speaks only completed, top-level fallback notices - non-fallback kinds and nested subagent notices stay silent", () => {
    const messages: ReadonlyArray<ChatMessage> = [
      assistantMessage({
        id: "m1",
        segments: [
          providerNoticeSegment({
            id: "seg-fallback",
            noticeKind: "fallback_applied",
            status: "completed",
            parentId: null,
            title: "Switched providers",
            message: null,
            details: [{ label: "To", value: TARGET_IDENTITY }],
          }),
          // Non-fallback kind - a harness reroute, not a fallback outcome.
          providerNoticeSegment({
            id: "seg-reroute",
            noticeKind: "model_rerouted",
            status: "completed",
            parentId: null,
            title: "Model rerouted",
            message: null,
            details: [],
          }),
          // Nested under a subagent - not the top-level chat's own outcome.
          providerNoticeSegment({
            id: "seg-nested",
            noticeKind: "fallback_applied",
            status: "completed",
            parentId: "subagent-1",
            title: "Switched providers",
            message: null,
            details: [{ label: "To", value: TARGET_IDENTITY }],
          }),
          // Still streaming - not yet a settled outcome.
          providerNoticeSegment({
            id: "seg-streaming",
            noticeKind: "fallback_settled",
            status: "streaming",
            parentId: null,
            title: "Fallback settled",
            message: null,
            details: [],
          }),
        ],
      }),
    ];
    const notices = fallbackNoticeAnnouncements(messages);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.key).toBe("notice:seg-fallback");
    expect(notices[0]?.text).toContain(`To: ${TARGET_IDENTITY}`);
  });

  it("a switched-provider notice and a staying-put notice of the SAME kind must never be confused - only one ever says 'To'", () => {
    const messages: ReadonlyArray<ChatMessage> = [
      assistantMessage({
        id: "m1",
        segments: [
          providerNoticeSegment({
            id: "seg-switched",
            noticeKind: "fallback_applied",
            status: "completed",
            parentId: null,
            title: "Switched providers",
            message: null,
            details: [{ label: "To", value: TARGET_IDENTITY }],
          }),
          providerNoticeSegment({
            id: "seg-stayed",
            noticeKind: "fallback_applied",
            status: "completed",
            parentId: null,
            title: "Staying on the current provider",
            message: null,
            details: [{ label: "Staying on", value: FAILED_IDENTITY }],
          }),
        ],
      }),
    ];
    const notices = fallbackNoticeAnnouncements(messages);
    // Asserted BEFORE direct-index access: an empty/short result must fail
    // loudly here, not silently compare `undefined` against a string two
    // lines down.
    expect(notices).toHaveLength(2);
    const [switched, stayed] = notices;
    expect(switched.text).toBe(`Switched providers. To: ${TARGET_IDENTITY}`);
    expect(stayed.text).toBe(
      `Staying on the current provider. Staying on: ${FAILED_IDENTITY}`,
    );
    // Falsification: fabricate a "To" clause on the staying-put row (e.g. by
    // always rendering `plan.destination` instead of only the details the
    // host actually sent) - this must never claim a switch happened.
    expect(stayed.text).not.toContain("To:");
    expect(switched.text).not.toContain("Staying on:");
  });

  it("includes the host's 'Provider' and 'Now on' detail labels - fallback_wait_resumed's only identity, and a configured-superseded settle's destination", () => {
    const messages: ReadonlyArray<ChatMessage> = [
      assistantMessage({
        id: "m1",
        segments: [
          providerNoticeSegment({
            id: "seg-wait-resumed",
            noticeKind: "fallback_wait_resumed",
            status: "completed",
            parentId: null,
            title: "Resumed on the original provider",
            message: null,
            // "Provider" is `fallback_wait_resumed`'s ONLY identity detail -
            // it never carries a "To"/"Staying on" destination.
            details: [{ label: "Provider", value: FAILED_IDENTITY }],
          }),
          providerNoticeSegment({
            id: "seg-settled",
            noticeKind: "fallback_settled",
            status: "completed",
            parentId: null,
            title: "Fallback settled",
            message: null,
            // A configured-superseded settle names where the chat ended up
            // via "Now on" - a label distinct from the applied notice's "To".
            details: [{ label: "Now on", value: TARGET_IDENTITY }],
          }),
        ],
      }),
    ];
    const notices = fallbackNoticeAnnouncements(messages);
    expect(notices).toHaveLength(2);
    const [waitResumed, settled] = notices;
    expect(waitResumed.text).toBe(
      `Resumed on the original provider. Provider: ${FAILED_IDENTITY}`,
    );
    expect(settled.text).toBe(`Fallback settled. Now on: ${TARGET_IDENTITY}`);
    // Falsification: revert the label switch to the OLD allowlist (drop
    // "Provider"/"Now on") - both texts collapse to their bare titles with no
    // destination at all, exactly the regression this pin catches.
    expect(waitResumed.text).toContain(FAILED_IDENTITY);
    expect(settled.text).toContain(TARGET_IDENTITY);
  });

  it("speaks a fallback_returned and a fallback_return_blocked notice - the return's two endings - while a model_rerouted notice of the same shape stays silent", () => {
    const messages: ReadonlyArray<ChatMessage> = [
      assistantMessage({
        id: "m1",
        segments: [
          providerNoticeSegment({
            id: "seg-returned",
            noticeKind: "fallback_returned",
            status: "completed",
            parentId: null,
            title: "Switched back",
            message: null,
            details: [{ label: "To", value: PREFERRED_IDENTITY }],
          }),
          providerNoticeSegment({
            id: "seg-return-blocked",
            noticeKind: "fallback_return_blocked",
            status: "completed",
            parentId: null,
            title: "Stayed on the current provider",
            message: null,
            details: [{ label: "Staying on", value: TARGET_IDENTITY }],
          }),
          // Falsification: drop the `noticeKind !==` checks for these two
          // kinds from `fallbackNoticeAnnouncements` and this notice (a
          // DIFFERENT kind, same segment shape) would prove nothing either
          // way - it must stay silent regardless.
          providerNoticeSegment({
            id: "seg-reroute",
            noticeKind: "model_rerouted",
            status: "completed",
            parentId: null,
            title: "Model rerouted",
            message: null,
            details: [{ label: "To", value: TARGET_IDENTITY }],
          }),
        ],
      }),
    ];
    const notices = fallbackNoticeAnnouncements(messages);
    expect(notices).toHaveLength(2);
    const [returned, returnBlocked] = notices;
    expect(returned.text).toBe(`Switched back. To: ${PREFERRED_IDENTITY}`);
    expect(returnBlocked.text).toBe(
      `Stayed on the current provider. Staying on: ${TARGET_IDENTITY}`,
    );
    // Falsification: remove the `fallback_returned`/`fallback_return_blocked`
    // arms from the allowlist switch and THIS assertion must go red.
    expect(notices.some((notice) => notice.key === "notice:seg-reroute")).toBe(
      false,
    );
  });
});

// D215: confirmed host outcome metadata reaches the announcer independent of
// transcript row hydration. `fallbackOutcomeAnnouncement` is the pure adapter
// for that path; it is asserted to reuse the SAME title/message/detail-label
// formatter as `fallbackNoticeAnnouncements` (`fallbackNoticeText`), not a
// parallel one that could drift out of sync with it.
//
// Fixtures are typed as the REAL wire DTO (`LastFallbackOutcome`, protocol's
// `subscribe.ts`), which `fallbackOutcomeAnnouncement` takes directly.
//
// NOTE: the wire field is `sequence` (a per-slot write counter, starting at
// 1 and resetting on a new traversal arm), NOT `revision` - `revision` stays
// the name for `PendingFallback`/`PendingReturn`'s TRAVERSAL revision, a
// different field on a different type. Do not confuse the two.
function outcomeFixture(
  overrides: Partial<LastFallbackOutcome>,
): LastFallbackOutcome {
  const base: LastFallbackOutcome = {
    blockId: "block-default",
    assistantMessageId: "m-default",
    kind: "applied",
    title: "Switched providers",
    message: null,
    details: [],
    sequence: 1,
  };
  return { ...base, ...overrides };
}

describe("fallbackOutcomeAnnouncement", () => {
  it("is null when there is no confirmed host outcome yet", () => {
    expect(fallbackOutcomeAnnouncement(undefined)).toBeNull();
  });

  it("keys by blockId (not assistantMessageId), maps assistantMessageId to messageId, and formats text with the shared title/message/allowlisted-detail formatter", () => {
    const raw = outcomeFixture({
      blockId: "block-outcome-1",
      assistantMessageId: "m-assistant-1",
      kind: "applied",
      title: "Switched providers",
      message: "Your message will resend automatically.",
      details: [
        { label: "To", value: TARGET_IDENTITY },
        // An unrecognized label must be dropped, exactly as the transcript
        // notice formatter drops one - this is the shared-formatter claim;
        // a parallel, less-strict formatter would let this through.
        { label: "Internal-only", value: "should-not-appear" },
      ],
      sequence: 1,
    });
    const outcome = fallbackOutcomeAnnouncement(raw);
    expect(outcome).not.toBeNull();
    expect(outcome?.key).toBe("notice:block-outcome-1");
    expect(outcome?.messageId).toBe("m-assistant-1");
    expect(outcome?.text).toBe(
      `Switched providers. Your message will resend automatically. To: ${TARGET_IDENTITY}`,
    );
    // Falsification: key by assistantMessageId instead of blockId - two
    // outcomes on the SAME message (e.g. a retry replacing the first) would
    // collide into one consumedNotices entry instead of being independently
    // dedupable.
    expect(outcome?.key).not.toBe("notice:m-assistant-1");
    expect(outcome?.text).not.toContain("should-not-appear");
  });

  it("omits the message clause entirely when message is null, rather than leaving an empty clause/extra separator in its place", () => {
    const raw = outcomeFixture({
      blockId: "block-outcome-2",
      assistantMessageId: "m-assistant-2",
      kind: "settled",
      title: "Fallback settled",
      message: null,
      details: [{ label: "Now on", value: TARGET_IDENTITY }],
      sequence: 1,
    });
    const outcome = fallbackOutcomeAnnouncement(raw);
    // The EXACT string is the falsifier here, deliberately, not a substring
    // check: dropping the `message !== null` guard and pushing `null`
    // straight into `parts` (joined with ". ") does not render the literal
    // text "null" - it renders an extra ". " separator around an empty
    // clause ("Fallback settled. . Now on: ..."), which only an exact-match
    // assertion catches.
    expect(outcome?.text).toBe(`Fallback settled. Now on: ${TARGET_IDENTITY}`);
  });

  it("joins consecutive already-punctuated parts with a single space, never doubling the punctuation (title AND message both end in '.')", () => {
    const raw = outcomeFixture({
      blockId: "block-outcome-3",
      assistantMessageId: "m-assistant-3",
      kind: "applied",
      title: "Provider unavailable.",
      message: "Retrying now.",
      details: [{ label: "Tried", value: TARGET_IDENTITY }],
      sequence: 1,
    });
    const outcome = fallbackOutcomeAnnouncement(raw);
    expect(outcome?.text).toBe(
      `Provider unavailable. Retrying now. Tried: ${TARGET_IDENTITY}`,
    );
    // Falsification: a formatter that always joins with ". " regardless of
    // whether the accumulated text already ends in `.`/`!`/`?` would render
    // "Provider unavailable.. Retrying now.. Tried: ..." here - the doubled
    // period is exactly what this fixture (title AND message both
    // pre-punctuated) is shaped to catch. A single already-punctuated part
    // (as in the test above) cannot distinguish the two joiners; this one
    // can, because it is IN one of these already-punctuated joins.
    expect(outcome?.text).not.toContain("..");
  });
});

describe("createFallbackAnnouncementObserver", () => {
  function input(
    overrides: Partial<FallbackAnnouncementsInput>,
  ): FallbackAnnouncementsInput {
    // Constructed fresh on every call (fresh `Set`/array instances included)
    // so two calls never share mutable state.
    const base: FallbackAnnouncementsInput = {
      ready: true,
      baselineEpoch: 0,
      hydrationSequence: 0,
      coldRewrittenMessageIds: new Set(),
      residentMessageIds: new Set(),
      traversal: null,
      returnOffer: null,
      // Host outcome metadata (D215), independent of transcript hydration.
      // Defaulted to null here; the dedicated liveOutcome tests below
      // override it explicitly.
      liveOutcome: null,
      notices: [],
      manualOutcome: null,
      // MF11: an outcome whose initiating surface had already gone. Its own
      // seen-set, subject to the same `absorb` rule as manualOutcome -
      // defaulted here; the dedicated tests below override it explicitly.
      unattendedOutcome: null,
    };
    return { ...base, ...overrides };
  }

  function traversal(
    state: PendingFallback["state"],
    revision: number,
    planId: string,
  ): FallbackTraversalAnnouncement {
    return {
      traversalId: "t1",
      revision,
      semanticKey: JSON.stringify([state, planId, null]),
      text: `text for ${state}@${revision}/${planId}`,
    };
  }

  it("absorbs the first observation, a re-established baseline (reconnect), and a not-yet-ready frame - all silently", () => {
    const observer = createFallbackAnnouncementObserver();

    // First observation ever: absorbed regardless of what's in it.
    expect(
      observer.observe(
        input({ baselineEpoch: 1, traversal: traversal("hold", 1, "p1") }),
      ),
    ).toEqual([]);

    // Not-yet-ready: absorbed even with an unchanged epoch and a new state.
    expect(
      observer.observe(
        input({
          baselineEpoch: 1,
          ready: false,
          traversal: traversal("choosing", 2, "p1"),
        }),
      ),
    ).toEqual([]);

    // Reconnect: a NEW baselineEpoch changes provenance for THIS call -
    // absorbed even though the traversal state changed again. (Consumed
    // keys/high-water marks are NOT cleared by this - see the dedicated
    // reconnect-persistence tests below.)
    expect(
      observer.observe(
        input({ baselineEpoch: 2, traversal: traversal("switching", 3, "p1") }),
      ),
    ).toEqual([]);
  });

  it("a silent rebaseline does not permanently mute subsequent LIVE transitions", () => {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("hold", 1, "p1") }),
    );
    // A second rebaseline (e.g. a reconnect) - still absorbed.
    observer.observe(
      input({ baselineEpoch: 2, traversal: traversal("hold", 1, "p1") }),
    );
    // Same epoch as the last call, ready, and a genuinely NEW live state.
    // Falsification: latch `absorb` true forever after any rebaseline instead
    // of recomputing it per call, and this stays empty.
    const events = observer.observe(
      input({ baselineEpoch: 2, traversal: traversal("choosing", 2, "p1") }),
    );
    expect(events).toHaveLength(1);
  });

  it("speaks once per live hold -> choosing -> switching transition, and once more for a planId replacement on the same state", () => {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("hold", 1, "p1") }),
    ); // absorbed baseline

    const hold = observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("hold", 2, "p1") }),
    );
    expect(hold).toHaveLength(0); // same semanticKey as the absorbed baseline: no news

    const choosing = observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("choosing", 3, "p1") }),
    );
    expect(choosing).toHaveLength(1);
    expect(choosing[0]?.text).toBe("text for choosing@3/p1");

    const switching = observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("switching", 4, "p1") }),
    );
    expect(switching).toHaveLength(1);

    // Same STATE ("switching"), but the host replaced the plan (planId p1 ->
    // p2): a different destination is news even without a state change.
    const replacedPlan = observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("switching", 5, "p2") }),
    );
    expect(replacedPlan).toHaveLength(1);
  });

  it("stays silent on a revision-only bump with the same semantic key, even when the traversal's own text changed (a countdown tick)", () => {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("hold", 1, "p1") }),
    );
    const first = observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("choosing", 2, "p1") }),
    );
    expect(first).toHaveLength(1);

    // Revision bumps again (bookkeeping only), same state/plan, but the text
    // differs as if a display countdown had ticked - must NOT re-announce.
    const revisionBump: FallbackTraversalAnnouncement = {
      traversalId: "t1",
      revision: 3,
      semanticKey: JSON.stringify(["choosing", "p1", null]),
      text: "a different sentence, as if a countdown label had changed",
    };
    // Falsification: dedupe on `text` instead of `semanticKey`, and this
    // second call announces again because the sentence differs.
    expect(
      observer.observe(input({ baselineEpoch: 1, traversal: revisionBump })),
    ).toEqual([]);
  });

  it("ignores a lower-revision replay outright, without disturbing the current generation's own dedupe", () => {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("hold", 1, "p1") }),
    );
    const advanced = observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("switching", 5, "p1") }),
    );
    expect(advanced).toHaveLength(1);

    // A replayed OLDER frame with a semantically different (choosing) state
    // must be dropped before it ever reaches the dedupe/emit logic.
    const replay = observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("choosing", 3, "p1") }),
    );
    expect(replay).toEqual([]);

    // The current generation (revision 5, switching) is still what is on
    // file - re-observing it verbatim is a no-op, not a fresh announcement.
    const sameAgain = observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("switching", 5, "p1") }),
    );
    expect(sameAgain).toEqual([]);
  });

  it("a return to hold from choosing at a NEW revision is a resumed opportunity, even with the identical plan as the original hold", () => {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("hold", 1, "p1") }),
    ); // absorbed

    const choosing = observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("choosing", 2, "p1") }),
    );
    expect(choosing).toHaveLength(1);

    // Same planId ("p1") as the very first (absorbed) hold - a naive
    // "have I ever emitted this exact semanticKey" set would wrongly
    // suppress this. Falsification: dedupe against an EVER-SEEN set of
    // semantic keys instead of only the traversal's LATEST recorded one.
    const resumedHold = observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("hold", 3, "p1") }),
    );
    expect(resumedHold).toHaveLength(1);
    expect(resumedHold[0]?.text).toBe("text for hold@3/p1");
  });

  it("pending clears alone (a traversal going away) gives zero success events", () => {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("hold", 1, "p1") }),
    ); // absorbed
    observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("switching", 2, "p1") }),
    ); // live, announced

    // The traversal disappears (host cleared `pendingFallback`) with nothing
    // else changed.
    const cleared = observer.observe(
      input({ baselineEpoch: 1, traversal: null }),
    );
    expect(cleared).toEqual([]);
  });

  it("keys notices by BLOCK id, surviving a row id change (live row -> its persisted row under a new id)", () => {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(input({ baselineEpoch: 1 })); // absorbed baseline

    const notice: FallbackNoticeAnnouncement = {
      key: "notice:seg-1",
      messageId: "live-row-id",
      text: "Switched providers. To: destination",
    };
    const first = observer.observe(
      input({ baselineEpoch: 1, notices: [notice] }),
    );
    expect(first).toEqual([{ key: "notice:seg-1", text: notice.text }]);

    // The SAME block, now attached to its persisted row under a DIFFERENT
    // message id (the row projection replaces the live id).
    const rehomed: FallbackNoticeAnnouncement = {
      ...notice,
      messageId: "persisted-row-id",
    };
    // Falsification: key `consumedNotices` by `messageId` instead of the
    // notice's own `key`, and this re-announces after every row-id swap.
    expect(
      observer.observe(input({ baselineEpoch: 1, notices: [rehomed] })),
    ).toEqual([]);
  });

  it("history arriving with a hydrationSequence change is silent, except a newly-observed notice on a cold-rewritten message - and that exemption is spent only once", () => {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(input({ baselineEpoch: 1, hydrationSequence: 0 })); // absorbed baseline

    const ordinaryHistoryNotice: FallbackNoticeAnnouncement = {
      key: "notice:seg-ordinary",
      messageId: "row-ordinary",
      text: "ordinary history notice",
    };
    // A notice first observed across a hydration bump, NOT in the cold-write
    // exemption set: permanently silent (the reader was never told, by
    // design - the persisted body carries it at the next real hydration).
    expect(
      observer.observe(
        input({
          baselineEpoch: 1,
          hydrationSequence: 1,
          notices: [ordinaryHistoryNotice],
        }),
      ),
    ).toEqual([]);
    // Hydrating again with the same notice still present: still silent.
    expect(
      observer.observe(
        input({
          baselineEpoch: 1,
          hydrationSequence: 2,
          notices: [ordinaryHistoryNotice],
        }),
      ),
    ).toEqual([]);

    const coldRewriteNotice: FallbackNoticeAnnouncement = {
      key: "notice:seg-cold",
      messageId: "row-cold",
      text: "cold-rewritten completion notice",
    };
    // First hydration where this row is exempted: announced.
    const exempted = observer.observe(
      input({
        baselineEpoch: 1,
        hydrationSequence: 3,
        coldRewrittenMessageIds: new Set(["row-cold"]),
        notices: [coldRewriteNotice],
      }),
    );
    expect(exempted).toEqual([
      { key: "notice:seg-cold", text: coldRewriteNotice.text },
    ]);
    // This exercises `input.notices` again, gated by BOTH sets - `seen`
    // (`seenNoticeBodies`, already true here from the first delivery) alone
    // would block a re-announcement even if `consumedNotices` were never
    // updated, so "stop tracking `consumedNotices`" alone is not this test's
    // real falsifier. What this pins is that re-hydrating past the SAME
    // already-delivered row must not re-announce it a second time, however
    // many gates end up responsible for that silence.
    expect(
      observer.observe(
        input({
          baselineEpoch: 1,
          hydrationSequence: 4,
          coldRewrittenMessageIds: new Set(["row-cold"]),
          notices: [coldRewriteNotice],
        }),
      ),
    ).toEqual([]);
  });

  it("a new notice on an ALREADY-resident row stays live even when the same commit also bumps hydrationSequence - only a newly-seated history row is absorbed", () => {
    const observer = createFallbackAnnouncementObserver();
    // The row exists from the start - an ordinary transcript row that later
    // grows a fallback notice - tracked via `residentMessageIds` even while
    // it carries no notice yet.
    observer.observe(
      input({
        baselineEpoch: 1,
        hydrationSequence: 0,
        residentMessageIds: new Set(["row-resident"]),
      }),
    ); // absorbed baseline

    const lateNotice: FallbackNoticeAnnouncement = {
      key: "notice:seg-late",
      messageId: "row-resident",
      text: "a notice that landed on an already-resident row",
    };
    // A SECOND notice, on a row that is genuinely newly-seated by THIS same
    // commit's hydrationSequence bump ("row-new-history" is absent from the
    // prior commit's residentMessageIds, present only in this one) - it must
    // stay absorbed, unlike lateNotice above.
    const newHistoryNotice: FallbackNoticeAnnouncement = {
      key: "notice:seg-new-history",
      messageId: "row-new-history",
      text: "a notice on a row hydrated by this same commit",
    };
    // The SAME commit also bumps hydrationSequence (a range load lands
    // alongside this live update) - the row was ALREADY resident in the
    // PRIOR commit, so it must not read as freshly-seated history.
    const events = observer.observe(
      input({
        baselineEpoch: 1,
        hydrationSequence: 1,
        residentMessageIds: new Set(["row-resident", "row-new-history"]),
        notices: [lateNotice, newHistoryNotice],
      }),
    );
    // Falsification: check the NEW commit's `residentMessageIds` instead of
    // the PRIOR commit's. Checking `row-resident` alone cannot catch this -
    // it is present in BOTH sets, so the substitution would not change its
    // classification. `row-new-history` is what makes the substitution
    // observable: it is present ONLY in the current set, so a check against
    // the current set would wrongly read it as "already resident" too and
    // speak `newHistoryNotice` alongside `lateNotice`, when only the latter
    // should ever be heard.
    expect(events).toEqual([{ key: "notice:seg-late", text: lateNotice.text }]);
  });

  it("a previously-spoken notice stays silent across a reconnect even if the new baseline evicts its row; a genuinely new block after reconnect still speaks", () => {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(input({ baselineEpoch: 1 })); // absorbed baseline

    const spokenBefore: FallbackNoticeAnnouncement = {
      key: "notice:seg-spoken",
      messageId: "row-spoken",
      text: "settled before reconnect",
    };
    const spoken = observer.observe(
      input({ baselineEpoch: 1, notices: [spokenBefore] }),
    );
    expect(spoken).toEqual([
      { key: "notice:seg-spoken", text: spokenBefore.text },
    ]);

    // Reconnect: a NEW baselineEpoch, and the fresh snapshot happens to OMIT
    // the row that carried the already-spoken notice (an evicted window) -
    // absorbed regardless of what is or isn't present.
    observer.observe(input({ baselineEpoch: 2 }));

    // The SAME block reappears later on the LIVE path (the row scrolls back
    // in, unchanged) - it must stay silent: the consumed key survives the
    // reconnect. This exercises `input.notices`, which is gated by BOTH
    // `seenNoticeBodies` and `consumedNotices` (`if (seen ||
    // consumedNotices.has(...)) continue;`) - clearing `consumedNotices`
    // alone on a baselineEpoch change would NOT redden this specific
    // assertion, since `seenNoticeBodies` (never cleared here) still blocks
    // it on its own. The real falsifier is clearing BOTH sets on a
    // baselineEpoch change (the old, pre-split single-Set behavior); the
    // `consumedNotices`-alone case is instead covered by the liveOutcome
    // reconnect test above, whose path has no `seenNoticeBodies` gate at all.
    const repeated = observer.observe(
      input({ baselineEpoch: 2, notices: [spokenBefore] }),
    );
    expect(repeated).toEqual([]);

    // A GENUINELY new block after the reconnect still speaks normally.
    const newAfterReconnect: FallbackNoticeAnnouncement = {
      key: "notice:seg-after-reconnect",
      messageId: "row-after",
      text: "a new notice after reconnect",
    };
    const spokenAgain = observer.observe(
      input({ baselineEpoch: 2, notices: [newAfterReconnect] }),
    );
    expect(spokenAgain).toEqual([
      { key: "notice:seg-after-reconnect", text: newAfterReconnect.text },
    ]);
  });

  it("traversal revision high-water marks and manual-outcome keys also survive a reconnect", () => {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("hold", 1, "p1") }),
    ); // absorbed baseline
    const live = observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("switching", 5, "p1") }),
    );
    expect(live).toHaveLength(1);

    const outcome: FallbackAnnouncement = {
      key: "manual:seq-1",
      text: "outcome text",
    };
    const spokenOutcome = observer.observe(
      input({ baselineEpoch: 1, manualOutcome: outcome }),
    );
    expect(spokenOutcome).toEqual([outcome]);

    // Reconnect.
    observer.observe(input({ baselineEpoch: 2 }));

    // Falsification: reset `traversals`/`seenManualOutcomes` on every
    // baselineEpoch change (the old behavior) and BOTH assertions below flip
    // - the replay below would be treated as a fresh revision-5 traversal
    // (nothing to compare against) and the outcome key would speak again.
    const replayAfterReconnect = observer.observe(
      input({ baselineEpoch: 2, traversal: traversal("choosing", 3, "p1") }),
    );
    expect(replayAfterReconnect).toEqual([]); // revision 3 < high-water mark 5

    const outcomeReplay = observer.observe(
      input({ baselineEpoch: 2, manualOutcome: outcome }),
    );
    expect(outcomeReplay).toEqual([]);
  });

  it("manual outcome: two confirmed identical switches at different sequences both speak; identical sequence replay does not; baseline-cached outcome stays silent", () => {
    const observer = createFallbackAnnouncementObserver();
    const outcomeText = "Switched to Astra Mini Codex (acct-south).";

    // A manual outcome present during the (absorbed) baseline is recorded as
    // seen but never spoken.
    const cachedDuringBaseline: FallbackAnnouncement = {
      key: "manual:seq-0",
      text: outcomeText,
    };
    expect(
      observer.observe(
        input({ baselineEpoch: 1, manualOutcome: cachedDuringBaseline }),
      ),
    ).toEqual([]);
    // Replaying that SAME baseline-cached key once ready changes nothing -
    // it was already marked seen, absorbed or not.
    expect(
      observer.observe(
        input({ baselineEpoch: 1, manualOutcome: cachedDuringBaseline }),
      ),
    ).toEqual([]);

    const firstConfirmed: FallbackAnnouncement = {
      key: "manual:seq-1",
      text: outcomeText,
    };
    const spoken1 = observer.observe(
      input({ baselineEpoch: 1, manualOutcome: firstConfirmed }),
    );
    expect(spoken1).toEqual([firstConfirmed]);

    // Identical sequence replayed (same key): silent.
    expect(
      observer.observe(
        input({ baselineEpoch: 1, manualOutcome: firstConfirmed }),
      ),
    ).toEqual([]);

    // A SECOND confirmed switch, textually IDENTICAL but a new sequence key:
    // speaks again. Falsification: dedupe manual outcomes on `text` instead
    // of `key`, and this second, genuinely new switch stays silent.
    const secondConfirmed: FallbackAnnouncement = {
      key: "manual:seq-2",
      text: outcomeText,
    };
    const spoken2 = observer.observe(
      input({ baselineEpoch: 1, manualOutcome: secondConfirmed }),
    );
    expect(spoken2).toEqual([secondConfirmed]);
  });

  describe("unattendedOutcome (MF11: an outcome whose initiating surface had already gone)", () => {
    it("is emitted once and the SAME key replayed afterward is silent", () => {
      const observer = createFallbackAnnouncementObserver();
      observer.observe(input({ baselineEpoch: 1 })); // absorbed baseline

      const outcome: FallbackAnnouncement = {
        key: "unattended:seq-1",
        text: "That destination isn't available right now.",
      };
      const spoken = observer.observe(
        input({ baselineEpoch: 1, unattendedOutcome: outcome }),
      );
      expect(spoken).toEqual([outcome]);

      // Falsification: dedupe unattended outcomes on `text` instead of a
      // dedicated `seenUnattendedOutcomes` key set (or share `manualOutcome`'s
      // set - see the sibling test below) and this replay would speak again.
      const replay = observer.observe(
        input({ baselineEpoch: 1, unattendedOutcome: outcome }),
      );
      expect(replay).toEqual([]);
    });

    it("absorbs an unattendedOutcome present during the first observation, while not-ready, and across a changed baselineEpoch - mirroring manualOutcome", () => {
      const observer = createFallbackAnnouncementObserver();
      const outcome: FallbackAnnouncement = {
        key: "unattended:seq-baseline",
        text: "This chat already resumed.",
      };

      // First observation ever: absorbed regardless of what's in it.
      expect(
        observer.observe(
          input({ baselineEpoch: 1, unattendedOutcome: outcome }),
        ),
      ).toEqual([]);
      // Replaying that SAME baseline-cached key once ready changes nothing.
      expect(
        observer.observe(
          input({ baselineEpoch: 1, unattendedOutcome: outcome }),
        ),
      ).toEqual([]);

      const notReady: FallbackAnnouncement = {
        key: "unattended:seq-not-ready",
        text: "Couldn't switch this chat.",
      };
      // Not-yet-ready: absorbed even though the key is genuinely new.
      expect(
        observer.observe(
          input({
            baselineEpoch: 1,
            ready: false,
            unattendedOutcome: notReady,
          }),
        ),
      ).toEqual([]);
      // Falsification: skip marking `notReady`'s key as seen in the `absorb`
      // branch - a later ready observation of the SAME key would then speak
      // it, when it must instead have been consumed by the not-ready frame.
      expect(
        observer.observe(
          input({ baselineEpoch: 1, unattendedOutcome: notReady }),
        ),
      ).toEqual([]);

      // A changed baselineEpoch (reconnect) also absorbs a genuinely new key.
      const afterReconnect: FallbackAnnouncement = {
        key: "unattended:seq-reconnect",
        text: "The menu is out of date — reopen it to choose.",
      };
      expect(
        observer.observe(
          input({ baselineEpoch: 2, unattendedOutcome: afterReconnect }),
        ),
      ).toEqual([]);
    });

    it("a manualOutcome AND an unattendedOutcome present in the SAME observation both come out - two independent slots, not one shared one", () => {
      const observer = createFallbackAnnouncementObserver();
      observer.observe(input({ baselineEpoch: 1 })); // absorbed baseline

      const manual: FallbackAnnouncement = {
        key: "manual:seq-both-1",
        text: "Switched this chat to Astra Mini Codex (acct-south).",
      };
      const unattended: FallbackAnnouncement = {
        key: "unattended:seq-both-1",
        text: "That's already been decided for this chat.",
      };
      // Falsification: route unattendedOutcome through the manualOutcome slot
      // (reuse `outcome`/`seenManualOutcomes` for both) - one of the two would
      // be silently dropped here since a single slot can hold only one value
      // per observation.
      const events = observer.observe(
        input({
          baselineEpoch: 1,
          manualOutcome: manual,
          unattendedOutcome: unattended,
        }),
      );
      expect(events).toEqual([manual, unattended]);
    });
  });

  it("combines a traversal transition and a notice in the same frame into a speech-like ordered sequence", () => {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("hold", 1, "p1") }),
    );

    const notice: FallbackNoticeAnnouncement = {
      key: "notice:seg-settle",
      messageId: "row-settle",
      text: "Fallback settled. Detail: no candidates left",
    };
    const events = observer.observe(
      input({
        baselineEpoch: 1,
        traversal: traversal("switching", 2, "p1"),
        notices: [notice],
      }),
    );
    expect(events).toHaveLength(2);
    // Traversal transitions are observed before notices in `observe`, so a
    // consumer building a speech transcript sees them in that order.
    expect(events[0]?.text).toBe("text for switching@2/p1");
    expect(events[1]).toEqual({ key: "notice:seg-settle", text: notice.text });
  });

  it("the return-offer channel is independent of the fallback-traversal channel and both can speak in the same frame", () => {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(input({ baselineEpoch: 1 })); // absorbed baseline, nothing pending

    const returnOffer: FallbackTraversalAnnouncement = {
      traversalId: "t-return",
      revision: 1,
      semanticKey: JSON.stringify([100, "offer-key"]),
      text: `${PREFERRED_IDENTITY} is available again. You can switch back or stay on the current provider.`,
    };
    const events = observer.observe(
      input({
        baselineEpoch: 1,
        returnOffer,
        traversal: traversal("waiting", 1, "p1"),
      }),
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.text)).toEqual([
      "text for waiting@1/p1",
      returnOffer.text,
    ]);
  });

  // D215 liveOutcome: confirmed host metadata, delivered independent of
  // transcript row hydration.
  describe("liveOutcome (D215 confirmed host outcome metadata)", () => {
    it("delivers a liveOutcome even when its underlying row is NOT resident in the transcript - host metadata bypasses the hydration-residency gate that regular notices are subject to", () => {
      const observer = createFallbackAnnouncementObserver();
      observer.observe(input({ baselineEpoch: 1 })); // absorb first frame

      const outcome: FallbackNoticeAnnouncement = {
        key: "notice:block-live-1",
        messageId: "m-not-resident",
        text: "Switched providers. To: X",
      };
      const announcements = observer.observe(
        input({
          baselineEpoch: 1,
          // Bumped so `hydrating` reads true on THIS call - the notice-path
          // residency gate (`hydrating && !priorResidentMessageIds.has(...)
          // && !coldRewrittenMessageIds.has(...)`) only ever fires while
          // hydrating; leaving this unchanged from `input()`'s baseline
          // would make the falsifier below inert, since routing liveOutcome
          // through that gate would be indistinguishable from not doing so.
          hydrationSequence: 1,
          liveOutcome: outcome,
          // Deliberately excludes "m-not-resident", and it is absent from
          // `coldRewrittenMessageIds` too: unlike a `fallbackNoticeAnnouncements`
          // entry (gated on `priorResidentMessageIds`/`coldRewrittenMessageIds`
          // while `hydrating`), a liveOutcome carries no such gate at all.
          residentMessageIds: new Set(),
        }),
      );
      expect(announcements).toEqual([{ key: outcome.key, text: outcome.text }]);
      // Falsification: route liveOutcome through the same residency check as
      // `input.notices` - with `hydrating` genuinely true here and
      // "m-not-resident" absent from both resident sets, that gate would
      // fire and this goes silent instead.
    });

    it("shares the consumedNotices key-space with fallbackNoticeAnnouncements entries - a liveOutcome and a later transcript notice carrying the SAME key never double-announce", () => {
      const observer = createFallbackAnnouncementObserver();
      observer.observe(input({ baselineEpoch: 1 }));

      const shared: FallbackNoticeAnnouncement = {
        key: "notice:block-shared",
        messageId: "m-shared",
        text: "shared outcome text",
      };
      const first = observer.observe(
        input({ baselineEpoch: 1, liveOutcome: shared }),
      );
      expect(first).toEqual([{ key: shared.key, text: shared.text }]);

      // The SAME key now arrives as a regular transcript notice too (its row
      // finally hydrated) - it must stay silent, proving `consumedNotices` is
      // one shared set rather than a parallel `seenLiveOutcomes`.
      const second = observer.observe(
        input({
          baselineEpoch: 1,
          residentMessageIds: new Set(["m-shared"]),
          notices: [shared],
        }),
      );
      expect(second).toEqual([]);
      // Falsification: give liveOutcome a separate `consumedNotices` Set from
      // the one `input.notices` writes to - the second call re-announces the
      // identical text.
    });

    it("a liveOutcome already spoken stays silent across a reconnect (baselineEpoch change), matching the persistent-provenance rule notices already follow", () => {
      const observer = createFallbackAnnouncementObserver();
      observer.observe(input({ baselineEpoch: 1 }));

      const outcome: FallbackNoticeAnnouncement = {
        key: "notice:block-reconnect",
        messageId: "m-reconnect",
        text: "outcome text",
      };
      const spoken = observer.observe(
        input({ baselineEpoch: 1, liveOutcome: outcome }),
      );
      expect(spoken).toEqual([{ key: outcome.key, text: outcome.text }]);

      // Reconnect: new baselineEpoch, and this frame carries NO outcome at
      // all (deliberately - if the rebaseline frame redelivered the SAME
      // outcome, its own `liveOutcome` handling would immediately re-add
      // the key to `consumedNotices` regardless of whether the rebaseline
      // cleared it moments earlier, making the falsifier below inert no
      // matter what the code does on a baselineEpoch change).
      expect(observer.observe(input({ baselineEpoch: 2 }))).toEqual([]);
      // THEN the SAME old metadata replays on a later, already-ready frame
      // on the new baseline (not itself a rebaseline) - this isolates
      // `consumedNotices` as the only thing that can be responsible for
      // staying silent.
      expect(
        observer.observe(input({ baselineEpoch: 2, liveOutcome: outcome })),
      ).toEqual([]);
      // Falsification: clear `consumedNotices` on a baselineEpoch change -
      // with the rebaseline frame above carrying no outcome to re-add the
      // key, this last call would find it unconsumed and re-announce it.
    });

    it("two DIFFERENT liveOutcome keys are independent deliveries - the observer never compares revisions across outcome block ids, unlike traversal transitions", () => {
      const observer = createFallbackAnnouncementObserver();
      observer.observe(input({ baselineEpoch: 1 }));

      const first: FallbackNoticeAnnouncement = {
        key: "notice:block-a",
        messageId: "m-a",
        text: "text A",
      };
      const second: FallbackNoticeAnnouncement = {
        key: "notice:block-b",
        messageId: "m-b",
        text: "text B",
      };
      expect(
        observer.observe(input({ baselineEpoch: 1, liveOutcome: first })),
      ).toEqual([{ key: first.key, text: first.text }]);
      // A DIFFERENT block's outcome, delivered on a later call - `notice:`
      // keys are opaque strings to the observer; there is no revision field
      // on FallbackNoticeAnnouncement for it to compare against the first.
      expect(
        observer.observe(input({ baselineEpoch: 1, liveOutcome: second })),
      ).toEqual([{ key: second.key, text: second.text }]);
    });

    // History-only body observation (`seenNoticeBodies`) is now separate from
    // consumed-delivery identity (`consumedNotices`): a body the
    // hydration-residency gate silently drops still marks itself "seen" (so a
    // later rerender of the SAME gated body never re-evaluates it) without
    // marking itself "consumed" (so a later liveOutcome for the same key can
    // still speak it once).
    describe("history-only body observation vs. consumed delivery (seenNoticeBodies vs. consumedNotices)", () => {
      it("(a) a READY frame silently gates a hydrating body via the residency check, then a liveOutcome for the SAME key speaks once", () => {
        const observer = createFallbackAnnouncementObserver();
        observer.observe(input({ baselineEpoch: 1 })); // absorb first frame

        const shared: FallbackNoticeAnnouncement = {
          key: "notice:block-hist-then-meta",
          messageId: "m-hist-then-meta",
          text: "outcome text",
        };
        // A READY frame whose hydration cycle advanced but whose row is
        // neither previously resident nor cold-rewritten - the residency
        // gate silently drops it. `seenNoticeBodies` now has the key;
        // `consumedNotices` does NOT.
        const gated = observer.observe(
          input({
            baselineEpoch: 1,
            hydrationSequence: 1,
            residentMessageIds: new Set(),
            coldRewrittenMessageIds: new Set(),
            notices: [shared],
          }),
        );
        expect(gated).toEqual([]);

        // The SAME key now arrives as confirmed host metadata - must speak,
        // because it was never actually CONSUMED, only silently seen.
        const spoken = observer.observe(
          input({
            baselineEpoch: 1,
            hydrationSequence: 1,
            liveOutcome: shared,
          }),
        );
        expect(spoken).toEqual([{ key: shared.key, text: shared.text }]);
        // Falsification: fold the residency-gated `continue` into
        // `consumedNotices.add(key)` (the pre-split single-Set behavior) -
        // the liveOutcome call would find the key already consumed and go
        // silent instead.
      });

      it("(a2) a body gated (seen, never consumed) survives a REBASELINE that redelivers it, and a metadata replay for the SAME key afterward stays silent throughout - `ready` stays true the whole time", () => {
        const observer = createFallbackAnnouncementObserver();
        observer.observe(input({ baselineEpoch: 1 })); // absorb first frame

        const shared: FallbackNoticeAnnouncement = {
          key: "notice:block-rebaseline-seen",
          messageId: "m-rebaseline-seen",
          text: "outcome text",
        };
        // A READY frame gates this body via the residency check - seen,
        // never consumed (same setup as (a) above).
        const gated = observer.observe(
          input({
            baselineEpoch: 1,
            hydrationSequence: 1,
            residentMessageIds: new Set(),
            coldRewrittenMessageIds: new Set(),
            notices: [shared],
          }),
        );
        expect(gated).toEqual([]);

        // A REBASELINE (epoch 2, still `ready`) redelivers the SAME body -
        // the `absorb` branch (`if (absorb) { consumedNotices.add(...);
        // continue; }`) runs unconditionally on every notice it sees,
        // regardless of whether `seenNoticeBodies` already had it.
        const rebaselined = observer.observe(
          input({ baselineEpoch: 2, notices: [shared] }),
        );
        expect(rebaselined).toEqual([]);

        // Confirmed host metadata for the SAME key arrives afterward, on
        // the now-current baseline (not itself a rebaseline, still ready) -
        // stays silent: the rebaseline frame already consumed it.
        const spoken = observer.observe(
          input({ baselineEpoch: 2, liveOutcome: shared }),
        );
        expect(spoken).toEqual([]);
        // Falsification: reorder the notices loop so a `seen` early return
        // runs BEFORE the `absorb` branch, instead of `absorb` running
        // unconditionally ahead of any `seen`/`consumedNotices` check - the
        // rebaseline call above would then skip consuming the
        // ALREADY-SEEN body entirely (short-circuited by `seen` first),
        // and this final metadata call would find it unconsumed and speak
        // it.
      });

      it("(b) a baseline/not-ready frame absorbs a body, then a liveOutcome for the SAME key stays silent - a pre-baseline block is absorbed forever, never replayed", () => {
        const observer = createFallbackAnnouncementObserver();
        // First observation ever: this whole frame is `absorb`.
        const absorbed = observer.observe(
          input({
            baselineEpoch: 1,
            notices: [
              {
                key: "notice:block-baseline",
                messageId: "m-baseline",
                text: "outcome text",
              },
            ],
          }),
        );
        expect(absorbed).toEqual([]);

        // Live now, same key arrives as confirmed host metadata - must stay
        // silent: the absorb branch adds the key to `consumedNotices`
        // unconditionally, so this is not a fresh delivery.
        const stillSilent = observer.observe(
          input({
            baselineEpoch: 1,
            liveOutcome: {
              key: "notice:block-baseline",
              messageId: "m-baseline",
              text: "outcome text",
            },
          }),
        );
        expect(stillSilent).toEqual([]);
        // Falsification: skip `consumedNotices.add(notice.key)` in the
        // `absorb` branch (relying on `seenNoticeBodies` alone) - the
        // liveOutcome call would find the key unconsumed and speak it,
        // replaying a pre-baseline block after the fact.
      });

      it("(c) a body actually spoken through the notices path, then a liveOutcome for the SAME key stays silent - and the reverse order (metadata first, hydrated body after) already stays silent too", () => {
        const observer = createFallbackAnnouncementObserver();
        observer.observe(input({ baselineEpoch: 1 }));

        const shared: FallbackNoticeAnnouncement = {
          key: "notice:block-body-then-meta",
          messageId: "m-body-then-meta",
          text: "outcome text",
        };
        // Delivered as a resident, live notice - actually spoken.
        const spokenAsBody = observer.observe(
          input({
            baselineEpoch: 1,
            residentMessageIds: new Set(["m-body-then-meta"]),
            notices: [shared],
          }),
        );
        expect(spokenAsBody).toEqual([{ key: shared.key, text: shared.text }]);

        // Confirmed metadata for the SAME key arrives afterward - silent.
        const silentAsMetadata = observer.observe(
          input({ baselineEpoch: 1, liveOutcome: shared }),
        );
        expect(silentAsMetadata).toEqual([]);
        // Falsification: this is the negative-order pair to the shared-key
        // test above (metadata-first, then hydrated body) - both orderings
        // must land on `consumedNotices` and speak exactly once combined.
      });

      it("keeps a body-only rerender quiet after its FIRST silent (gated) observation, even without ever being consumed", () => {
        const observer = createFallbackAnnouncementObserver();
        observer.observe(input({ baselineEpoch: 1 }));

        const gatedNotice: FallbackNoticeAnnouncement = {
          key: "notice:block-repeat-gated",
          messageId: "m-repeat-gated",
          text: "outcome text",
        };
        const firstGate = observer.observe(
          input({
            baselineEpoch: 1,
            hydrationSequence: 1,
            residentMessageIds: new Set(),
            coldRewrittenMessageIds: new Set(),
            notices: [gatedNotice],
          }),
        );
        expect(firstGate).toEqual([]);

        // An unrelated parent rerender re-delivers the IDENTICAL body on a
        // later frame. `hydrationSequence` is deliberately kept at the SAME
        // value (1, not 2) - `hydrating` therefore recomputes FALSE on this
        // call, so the residency gate (`hydrating && !prior.has(...) &&
        // !cold.has(...)`) plays no part in the silence here at all. Only
        // `seenNoticeBodies` (set on the first observation) can be
        // responsible for staying quiet - a bump to `hydrationSequence: 2`
        // here would re-trigger the residency gate independently and make
        // the falsifier below inert: dropping `seenNoticeBodies` would then
        // STAY GREEN (the residency gate alone would already suppress the
        // second call), not redden.
        const secondGate = observer.observe(
          input({
            baselineEpoch: 1,
            hydrationSequence: 1,
            residentMessageIds: new Set(),
            coldRewrittenMessageIds: new Set(),
            notices: [gatedNotice],
          }),
        );
        expect(secondGate).toEqual([]);
        // Falsification: gate on `consumedNotices` alone (no
        // `seenNoticeBodies` check) for a body that was never consumed -
        // with `hydrating` false here, the residency gate cannot save this
        // assertion, so the second call would fall straight through to
        // re-announcing the identical body.
      });
    });
  });
});
