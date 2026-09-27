import { describe, expect, it } from "vitest";
import type {
  ChatRunSettings,
  FallbackImpendingAction,
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
  DONT_WAIT_LABEL,
  FRESH_SESSION_HELPER,
  SIGN_IN_INSTEAD_LABEL,
  STOP_WAITING_LABEL,
} from "@/components/chat/fallback/fallback-copy";
import {
  countdownRefusalLabel,
  routingCountdownCountClauses,
  routingCountdownPlan,
  type RoutingCountdownPlan,
} from "@/components/chat/fallback/fallback-state";
import { fallbackResolvedIdentitySentence } from "@/components/chat/fallback/fallback-identity";
import { formatClockTime, formatResetDateTime } from "@/lib/relative-time";
import {
  createFallbackAnnouncementObserver,
  fallbackAnnouncementPlan,
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
const DAY_MS = 24 * 60 * 60_000;

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

/**
 * The pure-deriver tests' plan vocabulary, onto the card's plan. Production
 * builds plans with `fallbackAnnouncementPlan` from a frame (pinned in its own
 * block below); these tests hand one in to reach every sentence directly.
 */
type TestPlanAction = "switch" | "resume" | "wait" | "notify" | "checking";

function testCountdown(
  action: TestPlanAction,
  resumesAt: number | null,
): RoutingCountdownPlan {
  switch (action) {
    case "switch":
      return { kind: "switch", destination: TARGET_TUPLE };
    case "resume":
      return { kind: "resume" };
    case "wait":
      return { kind: "wait", resumesAt };
    case "notify":
      return { kind: "nothing" };
    case "checking":
      return { kind: "deciding" };
  }
}

function plan(input: {
  readonly planId: string;
  readonly action: TestPlanAction;
  readonly destination: string | null;
  readonly resumesAt: number | null;
}): FallbackAnnouncementPlan {
  return {
    planId: input.planId,
    countdown: testCountdown(input.action, input.resumesAt),
    destination: input.destination,
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
    receipt: null,
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
    // The card's count clause, as a sentence - and not the fresh-session
    // helper, which the card no longer shows (clutter cuts).
    expect(text).toContain("2 queued messages move with it.");
    expect(text).not.toContain(FRESH_SESSION_HELPER);
    expect(text).toContain("You have 12 seconds to cancel.");
    // The REAL button label, imported from the copy module - never a
    // hand-typed "Cancel" or "Don't Switch" that could silently drift from it.
    expect(text).toContain(`Select ${DONT_SWITCH_LABEL} to cancel.`);
    expectUnprefixed(text);
    // Negative half: the banned-vocabulary words never leak into user prose.
    expect(text).not.toMatch(/\b(tier|ladder|rung|grace|inherit)\b/i);
  });

  it("hold: a resume or a wait names the failed tuple and speaks no fresh-session helper", () => {
    const resumeText = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "hold",
        traversalId: "t1",
        revision: 1,
        deadline: NOW + 5_000,
        queuedItemsMoving: 0,
      }),
      plan: plan({
        planId: "plan-resume-1",
        action: "resume",
        destination: null,
        resumesAt: null,
      }),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    expect(resumeText).toContain(`The chat will resume on ${FAILED_IDENTITY}.`);
    expect(resumeText).not.toContain(FRESH_SESSION_HELPER);

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
      "There's nowhere to route this chat. It will stop and keep the error visible.",
    );
    // Falsification: drop the `seconds === 0` branch in `cancelOpportunityText`
    // and this becomes "You have 0 seconds to cancel." instead.
    expect(text).not.toContain("0 seconds");
    expect(text).toContain("The countdown is up.");
    // The clause must not NAME a switch here, and this assertion used to read
    // `toContain("The switch is due now.")` - the suite pinned the defect. A
    // `notify` rung stops the chat and leaves the error standing; there is no
    // switch to be due, and a screen reader is the one audience that cannot
    // see the card disagreeing.
    expect(text).not.toContain("The switch is due now.");
    expect(text).not.toContain("switch is due");
    // Still points at the button, which the grace card renders on every rung.
    expect(text).toContain(`Select ${DONT_SWITCH_LABEL} to cancel.`);
  });

  it("hold: a due-now deadline still names the switch on a switch rung, resolved destination or not", () => {
    // The other arm of the matrix, and the reason the fix is keyed on the rung
    // rather than on `notify`. Falsification: make the due-now sentence
    // unconditionally neutral and this goes red - it would trade one false
    // sentence for a vaguer one on the only rung that earned the word.
    const dueNow = (destination: string | null): string | undefined =>
      fallbackTraversalAnnouncement({
        pending: pendingFallback({
          state: "hold",
          traversalId: "t1",
          revision: 1,
          deadline: NOW,
          queuedItemsMoving: 0,
        }),
        plan: plan({
          planId: "plan-switch-1",
          action: "switch",
          destination,
          resumesAt: null,
        }),
        failedIdentity: FAILED_IDENTITY,
        targetIdentity: destination,
        now: NOW,
      })?.text;

    expect(dueNow(TARGET_IDENTITY)).toContain("The switch is due now.");
    // Unresolved destination and the claim still holds: a switch is what is
    // coming, whether or not the host can name where yet. This is why the
    // predicate is the action alone and not the `&& destination !== null`
    // pairing that gates the fresh-session line.
    expect(dueNow(null)).toContain("The switch is due now.");
    expect(dueNow(null)).not.toContain("The countdown is up.");
  });

  describe("hold: the refusal the announcer names is the one the card draws", () => {
    const holdAnnouncement = (
      pending: PendingFallback,
      planned: FallbackAnnouncementPlan,
    ): string | undefined =>
      fallbackTraversalAnnouncement({
        pending,
        plan: planned,
        failedIdentity: FAILED_IDENTITY,
        targetIdentity: TARGET_IDENTITY,
        now: NOW,
      })?.text;

    const hold = pendingFallback({
      state: "hold",
      traversalId: "t-refusal",
      revision: 1,
      deadline: NOW + 10_000,
      queuedItemsMoving: 0,
    });

    it("a wait plan is refused with Don't wait", () => {
      const text = holdAnnouncement(
        hold,
        plan({
          planId: "plan-wait-refusal",
          action: "wait",
          destination: null,
          resumesAt: NOW + 3_600_000,
        }),
      );
      expect(text).toContain(`Select ${DONT_WAIT_LABEL} to cancel.`);
      expect(text).not.toContain(DONT_SWITCH_LABEL);
    });

    it("a switch plan is still refused with Don't switch", () => {
      const text = holdAnnouncement(
        hold,
        plan({
          planId: "plan-switch-refusal",
          action: "switch",
          destination: TARGET_IDENTITY,
          resumesAt: null,
        }),
      );
      expect(text).toContain(`Select ${DONT_SWITCH_LABEL} to cancel.`);
      expect(text).not.toContain(DONT_WAIT_LABEL);
    });

    it("a signed-out traversal points at Sign in instead, whatever the plan", () => {
      const signedOut: PendingFallback = { ...hold, reason: "auth" };
      for (const action of ["switch", "wait"] as const) {
        const text = holdAnnouncement(
          signedOut,
          plan({
            planId: `plan-auth-${action}`,
            action,
            destination: action === "switch" ? TARGET_IDENTITY : null,
            resumesAt: action === "wait" ? NOW + 3_600_000 : null,
          }),
        );
        expect(text).toContain(`Select ${SIGN_IN_INSTEAD_LABEL} to cancel.`);
        expect(text).not.toContain(`Select ${DONT_WAIT_LABEL}`);
        expect(text).not.toContain(`Select ${DONT_SWITCH_LABEL}`);
      }
    });
  });

  it("hold: a due-now deadline names no switch on a resume or a wait either - the class is every non-switch plan, not just notify", () => {
    // CodeRabbit flagged `notify`. The predicate is wider: a resume attempts
    // the same tuple and a wait parks until a reset, so neither has a switch
    // to be due, and both read the same false sentence before this fix.
    const dueNowFor = (
      action: "resume" | "wait",
      resumesAt: number | null,
    ): string | undefined =>
      fallbackTraversalAnnouncement({
        pending: pendingFallback({
          state: "hold",
          traversalId: "t1",
          revision: 1,
          deadline: NOW,
          queuedItemsMoving: 0,
        }),
        plan: plan({
          planId: `plan-${action}-1`,
          action,
          destination: null,
          resumesAt,
        }),
        failedIdentity: FAILED_IDENTITY,
        targetIdentity: null,
        now: NOW,
      })?.text;

    // The refusal named is the one the card draws for THAT plan: a wait plan's
    // card refuses with "Don't wait", a resume's with "Stop waiting".
    const refusals: ReadonlyArray<readonly [string | undefined, string]> = [
      [dueNowFor("resume", null), STOP_WAITING_LABEL],
      [dueNowFor("wait", NOW + 3_600_000), DONT_WAIT_LABEL],
    ];
    for (const [text, refusal] of refusals) {
      expect(text).toContain("The countdown is up.");
      expect(text).not.toContain("switch is due");
      expect(text).toContain(`Select ${refusal} to cancel.`);
    }
    // And each still names its own rung's subject, unchanged by this fix.
    expect(dueNowFor("resume", null)).toContain(
      `The chat will resume on ${FAILED_IDENTITY}.`,
    );
    expect(dueNowFor("wait", NOW + 3_600_000)).toContain(
      `The chat will wait for ${FAILED_IDENTITY}`,
    );
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
      "There's nowhere to route this chat. It will stop and keep the error visible.",
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
    expect(stillResolving).toContain("Working out where to route this chat…");

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

    // A destination-less `switching` frame with no plan at all announces
    // nothing (see the destination-less table below) - it no longer falls
    // back to a default sentence.
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
    });
    expect(neither).toBeNull();
  });

  function pendingFallbackWithTarget(input: {
    readonly state: PendingFallback["state"];
    readonly targetTuple: ChatRunSettings | null;
  }): PendingFallback {
    return {
      traversalId: "t1",
      revision: 4,
      state: input.state,
      reason: "rate_limit",
      failedTuple: FAILED_TUPLE,
      targetTuple: input.targetTuple,
      impendingAction: null,
      deadline: null,
      graceRemainingMs: null,
      attempt: 1,
      maxAttempts: 3,
      queuedItemsMoving: 0,
      siblingSwitching: 0,
    };
  }

  // The wait rung's resume commits the FAILED tuple as `switching`'s target,
  // so there is nowhere to switch TO: "Switching this chat to Astra Codex
  // (acct-north)" announced a move that never happened.
  it("switching: announces a resume, not a switch, when the destination is the tuple that failed", () => {
    const pending = pendingFallbackWithTarget({
      state: "switching",
      targetTuple: FAILED_TUPLE,
    });
    const text = fallbackTraversalAnnouncement({
      pending,
      plan: fallbackAnnouncementPlan(pending, FAILED_IDENTITY),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: FAILED_IDENTITY,
      now: NOW,
    })?.text;
    expect(text).toBe(`Resuming this chat on ${FAILED_IDENTITY}.`);
    expect(text).not.toMatch(/Switching this chat/);
  });

  // A destination-less `switching` frame is NEVER a resolved plan in
  // production - `enterSwitchRung` re-points `impending` at the rung being
  // ENTERED, still resolving, whatever the hold had predicted. So the
  // announcer's rule is keyed on the destination alone, not on the plan's
  // action: `destination === null` announces nothing, for every plan shape.
  // "The host is preparing the provider switch." no longer exists.
  //
  // Four rows:
  //  - `checking` is the LIVE shape - a resolving plan maps to `checking` in
  //    `fallbackPlanForAnnouncement`, the same 34 ms between "This chat will
  //    wait until 12:29 am" and the waiting card that the grace card pins;
  //  - a `switch` plan with a null destination - a real destination rung
  //    that has not named one yet;
  //  - a `wait` plan - the resolved-plan defensive control, mirroring the
  //    grace card's row (c);
  //  - no plan at all.
  it("switching: returns null for a destination-less frame, under every plan shape", () => {
    const cases: ReadonlyArray<FallbackAnnouncementPlan | null> = [
      plan({
        planId: "plan-checking",
        action: "checking",
        destination: null,
        resumesAt: null,
      }),
      plan({
        planId: "plan-switch-pending",
        action: "switch",
        destination: null,
        resumesAt: null,
      }),
      plan({
        planId: "plan-wait-resolved",
        action: "wait",
        destination: null,
        resumesAt: Date.now() + 3_600_000,
      }),
      null,
    ];
    for (const testPlan of cases) {
      // Falsification: restore the pre-fix ternary text - every row here
      // goes red, reading "The host is preparing the provider switch."
      // instead of null.
      const result = fallbackTraversalAnnouncement({
        pending: pendingFallbackWithTarget({
          state: "switching",
          targetTuple: null,
        }),
        plan: testPlan,
        failedIdentity: FAILED_IDENTITY,
        targetIdentity: null,
        now: NOW,
      });
      expect(result).toBeNull();
    }
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

  // The policy's wait cap reaches seven days (`FALLBACK_POLICY_LIMITS.
  // maxWaitMinutes`), so a resume time named this far out is not always
  // inside the same day - "Resuming at 10:34 AM" for a reset days away names
  // the wrong day.
  it("waiting: names the resume time with its weekday once it is a day or more away", () => {
    const farResumesAt = NOW + 4 * DAY_MS;
    const text = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "waiting",
        traversalId: "t1",
        revision: 3,
        deadline: farResumesAt,
        queuedItemsMoving: 0,
      }),
      plan: null,
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    // Falsification: `formatWaitTime` always returning `formatClockTime` -
    // this reads the bare clock time instead of the weekday-qualified form.
    const resumesAtLabel = formatResetDateTime(farResumesAt);
    const resume = `Resuming at ${resumesAtLabel}.`;
    const cancel = `Select ${STOP_WAITING_LABEL} to cancel.`;
    expect(text).toBe(`Waiting for ${FAILED_IDENTITY}. ${resume} ${cancel}`);
  });

  it("hold: states the wait plan's resume time with its weekday once it is a day or more away", () => {
    const farResumesAt = NOW + 4 * DAY_MS;
    const text = fallbackTraversalAnnouncement({
      pending: pendingFallback({
        state: "hold",
        traversalId: "t1",
        revision: 1,
        deadline: NOW + 5_000,
        queuedItemsMoving: 0,
      }),
      plan: plan({
        planId: "plan-wait-far",
        action: "wait",
        destination: null,
        resumesAt: farResumesAt,
      }),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: null,
      now: NOW,
    })?.text;
    const resumesAtLabel = formatResetDateTime(farResumesAt);
    expect(text).toContain(`and resume at ${resumesAtLabel}.`);
    expect(text).toContain(`The chat will wait for ${FAILED_IDENTITY}`);
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

  it("semanticKey: a resume's sentence does not move when only the plan under it moves", () => {
    const resuming = {
      ...pendingFallback({
        state: "switching",
        traversalId: "t1",
        revision: 2,
        deadline: null,
        queuedItemsMoving: 0,
      }),
      targetTuple: FAILED_TUPLE,
    };
    const first = fallbackTraversalAnnouncement({
      pending: resuming,
      plan: fallbackAnnouncementPlan(resuming, FAILED_IDENTITY),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: FAILED_IDENTITY,
      now: NOW,
    });
    // The resumed attempt failed and the host entered its next rung while
    // still `switching` onto the resumed tuple (seen live).
    const nextRungFrame: PendingFallback = {
      ...resuming,
      revision: 3,
      impendingAction: {
        planId: "plan-next-rung",
        rung: "profile",
        target: TARGET_TUPLE,
        targetModelFamily: null,
        resumesAt: null,
        pending: null,
      },
    };
    const nextRung = fallbackTraversalAnnouncement({
      pending: nextRungFrame,
      plan: fallbackAnnouncementPlan(nextRungFrame, FAILED_IDENTITY),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: FAILED_IDENTITY,
      now: NOW,
    });
    expect(first?.text).toBe(`Resuming this chat on ${FAILED_IDENTITY}.`);
    expect(nextRung?.text).toBe(first?.text);
    // Falsification: key `switching` on the plan id and the unchanged
    // sentence is said a second time, after "Resumed on …".
    expect(nextRung?.semanticKey).toBe(first?.semanticKey);
  });

  /**
   * `semanticKey` carries the identities the branch actually SPOKE, not both
   * of `failedIdentity` and `targetIdentity`. Keying on an identity the text
   * never used re-enqueues a sentence that has not changed a character.
   *
   * Per (state, plan.action), not per state: `hold`/`choosing` take their
   * spoken set from `fallbackPlanText`, which names the destination on a
   * switch, the failed tuple on a resume or a wait, and nothing on
   * deciding/nothing or a null plan.
   */
  describe("semanticKey speaks only the identities the sentence named", () => {
    const OTHER_FAILED = "Opus Claude (acct-west)";
    const OTHER_TARGET = "Astra Mini Codex (acct-east)";
    const SLUG_TARGET = "claude-fable-5-1[1m]";
    const LABEL_TARGET = "Claude Fable";

    function announce(input: {
      readonly state: PendingFallback["state"];
      readonly plan: FallbackAnnouncementPlan | null;
      readonly failedIdentity: string;
      readonly targetIdentity: string | null;
      readonly targetTuple: ChatRunSettings | null;
      readonly revision: number;
    }): FallbackTraversalAnnouncement {
      const pending =
        input.targetTuple === null
          ? pendingFallback({
              state: input.state,
              traversalId: "t1",
              revision: input.revision,
              deadline: NOW + 12_000,
              queuedItemsMoving: 0,
            })
          : pendingFallbackWithTarget({
              state: input.state,
              targetTuple: input.targetTuple,
            });
      const result = fallbackTraversalAnnouncement({
        pending: { ...pending, revision: input.revision },
        plan: input.plan,
        failedIdentity: input.failedIdentity,
        targetIdentity: input.targetIdentity,
        now: NOW,
      });
      if (result === null) {
        throw new Error("expected a traversal announcement");
      }
      return result;
    }

    it("hold/choosing + switch: changing only failedIdentity leaves semanticKey (and the sentence) unchanged", () => {
      const switchPlan = plan({
        planId: "plan-switch-1",
        action: "switch",
        destination: TARGET_IDENTITY,
        resumesAt: null,
      });
      for (const state of ["hold", "choosing"] as const) {
        const namedFailed = announce({
          state,
          plan: switchPlan,
          failedIdentity: FAILED_IDENTITY,
          targetIdentity: TARGET_IDENTITY,
          targetTuple: null,
          revision: 1,
        });
        const otherFailed = announce({
          state,
          plan: switchPlan,
          failedIdentity: OTHER_FAILED,
          targetIdentity: TARGET_IDENTITY,
          targetTuple: null,
          revision: 1,
        });
        // Falsification: put `failedIdentity` into spokenIdentities for
        // every hold/choosing branch. The switch sentence names the
        // destination, so a catalogue resolving the failed tuple would
        // move the key while the live region repeated itself verbatim.
        expect(otherFailed.semanticKey).toBe(namedFailed.semanticKey);
        expect(otherFailed.text).toBe(namedFailed.text);
        expect(namedFailed.text).toContain(TARGET_IDENTITY);
        expect(namedFailed.text).not.toContain(FAILED_IDENTITY);
      }
    });

    it("hold/choosing + resume or wait: failedIdentity moves the key, targetIdentity does not", () => {
      for (const state of ["hold", "choosing"] as const) {
        for (const action of ["resume", "wait"] as const) {
          const namedPlan = plan({
            planId: `plan-${action}-1`,
            action,
            destination: null,
            resumesAt: action === "wait" ? NOW + 60_000 : null,
          });
          const base = announce({
            state,
            plan: namedPlan,
            failedIdentity: FAILED_IDENTITY,
            targetIdentity: TARGET_IDENTITY,
            targetTuple: null,
            revision: 1,
          });
          const failedMoved = announce({
            state,
            plan: namedPlan,
            failedIdentity: OTHER_FAILED,
            targetIdentity: TARGET_IDENTITY,
            targetTuple: null,
            revision: 1,
          });
          const targetMoved = announce({
            state,
            plan: namedPlan,
            failedIdentity: FAILED_IDENTITY,
            targetIdentity: OTHER_TARGET,
            targetTuple: null,
            revision: 1,
          });
          expect(failedMoved.semanticKey).not.toBe(base.semanticKey);
          expect(targetMoved.semanticKey).toBe(base.semanticKey);
          expect(base.text).toContain(FAILED_IDENTITY);
        }
      }
    });

    it("hold/choosing + checking, notify, or no plan: neither identity moves the key", () => {
      const plans: ReadonlyArray<FallbackAnnouncementPlan | null> = [
        plan({
          planId: "plan-checking-1",
          action: "checking",
          destination: null,
          resumesAt: null,
        }),
        plan({
          planId: "plan-notify-1",
          action: "notify",
          destination: null,
          resumesAt: null,
        }),
        null,
      ];
      for (const state of ["hold", "choosing"] as const) {
        for (const namedPlan of plans) {
          const base = announce({
            state,
            plan: namedPlan,
            failedIdentity: FAILED_IDENTITY,
            targetIdentity: TARGET_IDENTITY,
            targetTuple: null,
            revision: 1,
          });
          const failedMoved = announce({
            state,
            plan: namedPlan,
            failedIdentity: OTHER_FAILED,
            targetIdentity: TARGET_IDENTITY,
            targetTuple: null,
            revision: 1,
          });
          const targetMoved = announce({
            state,
            plan: namedPlan,
            failedIdentity: FAILED_IDENTITY,
            targetIdentity: OTHER_TARGET,
            targetTuple: null,
            revision: 1,
          });
          expect(failedMoved.semanticKey).toBe(base.semanticKey);
          expect(targetMoved.semanticKey).toBe(base.semanticKey);
        }
      }
    });

    it("waiting: failedIdentity moves the key, targetIdentity does not", () => {
      const waitPlan = plan({
        planId: "plan-wait-1",
        action: "wait",
        destination: null,
        resumesAt: NOW + 60_000,
      });
      const base = announce({
        state: "waiting",
        plan: waitPlan,
        failedIdentity: FAILED_IDENTITY,
        targetIdentity: TARGET_IDENTITY,
        targetTuple: null,
        revision: 1,
      });
      const failedMoved = announce({
        state: "waiting",
        plan: waitPlan,
        failedIdentity: OTHER_FAILED,
        targetIdentity: TARGET_IDENTITY,
        targetTuple: null,
        revision: 1,
      });
      const targetMoved = announce({
        state: "waiting",
        plan: waitPlan,
        failedIdentity: FAILED_IDENTITY,
        targetIdentity: OTHER_TARGET,
        targetTuple: null,
        revision: 1,
      });
      expect(failedMoved.semanticKey).not.toBe(base.semanticKey);
      expect(targetMoved.semanticKey).toBe(base.semanticKey);
      expect(base.text).toBe(targetMoved.text);
    });

    it("switching (non-resume): the resolved destination moving slug → label changes the key", () => {
      const switchPlan = plan({
        planId: "plan-switch-1",
        action: "switch",
        destination: SLUG_TARGET,
        resumesAt: null,
      });
      const slug = announce({
        state: "switching",
        plan: switchPlan,
        failedIdentity: FAILED_IDENTITY,
        targetIdentity: SLUG_TARGET,
        targetTuple: TARGET_TUPLE,
        revision: 2,
      });
      const label = announce({
        state: "switching",
        plan: switchPlan,
        failedIdentity: FAILED_IDENTITY,
        targetIdentity: LABEL_TARGET,
        targetTuple: TARGET_TUPLE,
        revision: 2,
      });
      // This is the original catalogue-correction: without the destination
      // in the key, the resolved name deduplicates against the slug one.
      expect(label.semanticKey).not.toBe(slug.semanticKey);
      expect(slug.text).toBe(`Switching this chat to ${SLUG_TARGET}.`);
      expect(label.text).toBe(`Switching this chat to ${LABEL_TARGET}.`);
    });

    it("switching (resume on the failed tuple): failedIdentity moves the key, targetIdentity does not", () => {
      const RESUME_PLAN = plan({
        planId: "plan-resume-1",
        action: "resume",
        destination: null,
        resumesAt: null,
      });
      const base = announce({
        state: "switching",
        plan: RESUME_PLAN,
        failedIdentity: FAILED_IDENTITY,
        targetIdentity: FAILED_IDENTITY,
        targetTuple: FAILED_TUPLE,
        revision: 4,
      });
      const failedMoved = announce({
        state: "switching",
        plan: RESUME_PLAN,
        failedIdentity: OTHER_FAILED,
        targetIdentity: FAILED_IDENTITY,
        targetTuple: FAILED_TUPLE,
        revision: 4,
      });
      const targetMoved = announce({
        state: "switching",
        plan: RESUME_PLAN,
        failedIdentity: FAILED_IDENTITY,
        targetIdentity: OTHER_TARGET,
        targetTuple: FAILED_TUPLE,
        revision: 4,
      });
      expect(base.text).toBe(`Resuming this chat on ${FAILED_IDENTITY}.`);
      expect(failedMoved.semanticKey).not.toBe(base.semanticKey);
      expect(targetMoved.semanticKey).toBe(base.semanticKey);
    });
  });
});

/**
 * The announcer reads a frame the way the countdown card does - through
 * `routingCountdownPlan`, `routingCountdownCountClauses` and
 * `countdownRefusalLabel` - so it can never name a plan, a count or a button
 * the card is not showing. Every case here starts from a real frame and goes
 * through `fallbackAnnouncementPlan`, the one builder production uses.
 */
describe("fallbackAnnouncementPlan: the announcer reads the frame the card reads", () => {
  function impending(input: {
    readonly planId: string;
    readonly rung: FallbackImpendingAction["rung"];
    readonly target: ChatRunSettings | null;
    readonly resumesAt: number | null;
  }): FallbackImpendingAction {
    return {
      planId: input.planId,
      rung: input.rung,
      target: input.target,
      targetModelFamily: null,
      resumesAt: input.resumesAt,
      pending: null,
    };
  }

  function frame(input: {
    readonly state: PendingFallback["state"];
    readonly targetTuple: ChatRunSettings | null;
    readonly impendingAction: FallbackImpendingAction | null;
    readonly deadline: number | null;
    readonly queuedItemsMoving: number;
    readonly siblingSwitching: number;
  }): PendingFallback {
    return {
      ...pendingFallback({
        state: input.state,
        traversalId: "t-frame",
        revision: 9,
        deadline: input.deadline,
        queuedItemsMoving: input.queuedItemsMoving,
      }),
      targetTuple: input.targetTuple,
      impendingAction: input.impendingAction,
      siblingSwitching: input.siblingSwitching,
    };
  }

  function announceFrame(
    pending: PendingFallback,
    destination: string | null,
    now: number,
  ): FallbackTraversalAnnouncement | null {
    return fallbackTraversalAnnouncement({
      pending,
      plan: fallbackAnnouncementPlan(pending, destination),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: destination,
      now,
    });
  }

  const RESUME_SENTENCE = `The chat will resume on ${FAILED_IDENTITY}.`;

  // The live D8 frame: a profile rung whose target is the account that
  // failed. The card said "Resuming in 12s"; the announcer said "The chat will
  // switch to" that same account.
  it("a profile rung whose target is the failed tuple announces a resume, never a switch - hold and switching", () => {
    const resumeAction = impending({
      planId: "plan-profile-onto-failed",
      rung: "profile",
      target: FAILED_TUPLE,
      resumesAt: null,
    });
    const hold = announceFrame(
      frame({
        state: "hold",
        targetTuple: null,
        impendingAction: resumeAction,
        deadline: NOW + 12_000,
        queuedItemsMoving: 2,
        siblingSwitching: 0,
      }),
      FAILED_IDENTITY,
      NOW,
    )?.text;
    // No queue clause: a resume moves no queue, and the card's cost line says
    // none either.
    expect(hold).toBe(
      `${RESUME_SENTENCE} You have 12 seconds to cancel. Select ${STOP_WAITING_LABEL} to cancel.`,
    );
    const switching = announceFrame(
      frame({
        state: "switching",
        targetTuple: FAILED_TUPLE,
        impendingAction: resumeAction,
        deadline: null,
        queuedItemsMoving: 2,
        siblingSwitching: 0,
      }),
      FAILED_IDENTITY,
      NOW,
    )?.text;
    expect(switching).toBe(`Resuming this chat on ${FAILED_IDENTITY}.`);
    for (const text of [hold, switching]) {
      expect(text).not.toMatch(/switch(ing)?( this chat)? to/i);
    }
  });

  it("a frame with no impending step and the failed tuple as its target announces the same resume", () => {
    const hold = announceFrame(
      frame({
        state: "hold",
        targetTuple: FAILED_TUPLE,
        impendingAction: null,
        deadline: NOW + 12_000,
        queuedItemsMoving: 0,
        siblingSwitching: 0,
      }),
      FAILED_IDENTITY,
      NOW,
    )?.text;
    expect(hold).toBe(
      `${RESUME_SENTENCE} You have 12 seconds to cancel. Select ${STOP_WAITING_LABEL} to cancel.`,
    );
    const switching = announceFrame(
      frame({
        state: "switching",
        targetTuple: FAILED_TUPLE,
        impendingAction: null,
        deadline: null,
        queuedItemsMoving: 0,
        siblingSwitching: 0,
      }),
      FAILED_IDENTITY,
      NOW,
    )?.text;
    expect(switching).toBe(`Resuming this chat on ${FAILED_IDENTITY}.`);
  });

  it("a real profile switch still announces a switch, with the card's count clauses as sentences", () => {
    const switchAction = impending({
      planId: "plan-profile-switch",
      rung: "profile",
      target: TARGET_TUPLE,
      resumesAt: null,
    });
    const holdFrame = frame({
      state: "hold",
      targetTuple: null,
      impendingAction: switchAction,
      deadline: NOW + 12_000,
      queuedItemsMoving: 2,
      siblingSwitching: 1,
    });
    const hold = announceFrame(holdFrame, TARGET_IDENTITY, NOW)?.text;
    expect(hold).toBe(
      `The chat will switch to ${TARGET_IDENTITY}. ` +
        "2 queued messages move with it. " +
        "1 other chat in this task is also switching. " +
        `You have 12 seconds to cancel. Select ${DONT_SWITCH_LABEL} to cancel.`,
    );
    // The same clauses the card joins into its cost line - one list.
    for (const clause of routingCountdownCountClauses(
      holdFrame,
      routingCountdownPlan(holdFrame),
    )) {
      expect(hold?.toLowerCase()).toContain(clause.toLowerCase());
    }
    expect(hold).not.toContain(FRESH_SESSION_HELPER);
    expect(hold).not.toMatch(/next message/i);
    const switching = announceFrame(
      frame({
        state: "switching",
        targetTuple: TARGET_TUPLE,
        impendingAction: switchAction,
        deadline: null,
        queuedItemsMoving: 2,
        siblingSwitching: 1,
      }),
      TARGET_IDENTITY,
      NOW,
    )?.text;
    expect(switching).toBe(`Switching this chat to ${TARGET_IDENTITY}.`);
  });

  it("a wait's queue waits with it rather than moving", () => {
    const text = announceFrame(
      frame({
        state: "hold",
        targetTuple: null,
        impendingAction: impending({
          planId: "plan-wait",
          rung: "wait",
          target: null,
          resumesAt: NOW + 3_600_000,
        }),
        deadline: NOW + 12_000,
        queuedItemsMoving: 1,
        siblingSwitching: 0,
      }),
      null,
      NOW,
    )?.text;
    expect(text).toContain("1 queued message waits with it.");
    expect(text).not.toContain("move with it");
  });

  // One case per label the card can draw, each asserted against the literal
  // AND the card's own function over the same frame.
  describe("the refusal named is the card's countdownRefusalLabel", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly pending: PendingFallback;
      readonly destination: string | null;
      readonly label: string;
    }> = [
      {
        name: "a switch: Don't switch",
        pending: frame({
          state: "hold",
          targetTuple: null,
          impendingAction: impending({
            planId: "plan-label-switch",
            rung: "profile",
            target: TARGET_TUPLE,
            resumesAt: null,
          }),
          deadline: NOW + 10_000,
          queuedItemsMoving: 0,
          siblingSwitching: 0,
        }),
        destination: TARGET_IDENTITY,
        label: DONT_SWITCH_LABEL,
      },
      {
        name: "a wait: Don't wait",
        pending: frame({
          state: "hold",
          targetTuple: null,
          impendingAction: impending({
            planId: "plan-label-wait",
            rung: "wait",
            target: null,
            resumesAt: NOW + 3_600_000,
          }),
          deadline: NOW + 10_000,
          queuedItemsMoving: 0,
          siblingSwitching: 0,
        }),
        destination: null,
        label: DONT_WAIT_LABEL,
      },
      {
        name: "a resume: Stop waiting",
        pending: frame({
          state: "hold",
          targetTuple: FAILED_TUPLE,
          impendingAction: null,
          deadline: NOW + 10_000,
          queuedItemsMoving: 0,
          siblingSwitching: 0,
        }),
        destination: FAILED_IDENTITY,
        label: STOP_WAITING_LABEL,
      },
      {
        name: "a sign-out: Sign in instead",
        pending: {
          ...frame({
            state: "hold",
            targetTuple: null,
            impendingAction: impending({
              planId: "plan-label-auth",
              rung: "profile",
              target: TARGET_TUPLE,
              resumesAt: null,
            }),
            deadline: NOW + 10_000,
            queuedItemsMoving: 0,
            siblingSwitching: 0,
          }),
          reason: "auth",
        },
        destination: TARGET_IDENTITY,
        label: SIGN_IN_INSTEAD_LABEL,
      },
    ];
    for (const testCase of cases) {
      it(testCase.name, () => {
        const text = announceFrame(
          testCase.pending,
          testCase.destination,
          NOW,
        )?.text;
        expect(
          countdownRefusalLabel(
            testCase.pending,
            routingCountdownPlan(testCase.pending),
          ),
        ).toBe(testCase.label);
        expect(text).toContain(`Select ${testCase.label} to cancel.`);
        // Exactly one "Select … to cancel." - no second, stale literal.
        expect(text?.match(/Select .+? to cancel\./g)).toHaveLength(1);
      });
    }
  });

  it("speaks the seconds to the card's deadline once per plan, not on every tick", () => {
    for (const impendingAction of [
      impending({
        planId: "plan-ticks",
        rung: "profile",
        target: TARGET_TUPLE,
        resumesAt: null,
      }),
      // A frame with no host plan id is keyed by what the card reads.
      null,
    ]) {
      const pending = frame({
        state: "hold",
        targetTuple: impendingAction === null ? TARGET_TUPLE : null,
        impendingAction,
        deadline: NOW + 12_000,
        queuedItemsMoving: 0,
        siblingSwitching: 0,
      });
      const first = announceFrame(pending, TARGET_IDENTITY, NOW);
      const tick = announceFrame(pending, TARGET_IDENTITY, NOW + 3_000);
      expect(first?.text).toContain("You have 12 seconds to cancel.");
      expect(tick?.text).toContain("You have 9 seconds to cancel.");
      expect(tick?.semanticKey).toBe(first?.semanticKey);
    }
  });
});

describe("fallbackReturnAnnouncement", () => {
  it("is null with no pending offer", () => {
    expect(
      fallbackReturnAnnouncement(undefined, PREFERRED_IDENTITY),
    ).toBeNull();
  });

  it("speaks the card's headline and its queue clause - nothing the card no longer shows", () => {
    const announcement = fallbackReturnAnnouncement(
      pendingReturn({ traversalId: "t1", revision: 1, queuedItemsMoving: 3 }),
      PREFERRED_IDENTITY,
    );
    expect(announcement?.text).toBe(
      `Switch back to ${PREFERRED_IDENTITY}? Switching back moves 3 queued messages back.`,
    );
    // The cut sentences: the fresh-session helper is the picker footer's, and
    // "applies to your next message" is gone from every card.
    expect(announcement?.text).not.toContain(FRESH_SESSION_HELPER);
    expect(announcement?.text).not.toMatch(/next message/i);
    expect(announcement?.text).not.toContain("  ");
    expectUnprefixed(announcement?.text ?? "");
  });

  it("omits the queue sentence entirely at zero, rather than stating a zero count", () => {
    const announcement = fallbackReturnAnnouncement(
      pendingReturn({ traversalId: "t1", revision: 1, queuedItemsMoving: 0 }),
      PREFERRED_IDENTITY,
    );
    expect(announcement?.text).toBe(`Switch back to ${PREFERRED_IDENTITY}?`);
    expect(announcement?.text).not.toContain("0 queued");
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
    expect(notices[0]?.text).toBe("Switched providers");
  });

  it("speaks a routing notice by its title alone - never the raw route message or a detail row (seen live after every hop)", () => {
    // The shapes the host wrote in the live drive: a divider whose message is
    // the raw route, and detail rows naming slugs.
    const messages: ReadonlyArray<ChatMessage> = [
      assistantMessage({
        id: "m1",
        segments: [
          providerNoticeSegment({
            id: "seg-applied",
            noticeKind: "fallback_applied",
            status: "completed",
            parentId: null,
            title: "Switched to Sonnet 5 · Low on Surya after a rate limit",
            message: "claude/sonnet (Surya 2) → claude/sonnet (Surya)",
            details: [
              { label: "To", value: "claude/sonnet (Surya)" },
              { label: "Failed on", value: "claude/sonnet (Surya 2)" },
              { label: "Tried", value: "none" },
            ],
          }),
          providerNoticeSegment({
            id: "seg-wait-resumed",
            noticeKind: "fallback_wait_resumed",
            status: "completed",
            parentId: null,
            title: "Resumed on Surya 2 after the limit reset",
            message: null,
            details: [{ label: "Provider", value: "claude/sonnet (Surya 2)" }],
          }),
        ],
      }),
    ];
    const notices = fallbackNoticeAnnouncements(messages);
    expect(notices.map((notice) => notice.text)).toEqual([
      "Switched to Sonnet 5 · Low on Surya after a rate limit",
      "Resumed on Surya 2 after the limit reset",
    ]);
    for (const notice of notices) {
      expect(notice.text).not.toContain("claude/");
      expect(notice.text).not.toContain("→");
      expect(notice.text).not.toMatch(/\b(To|Failed on|Tried|Provider):/);
    }
  });

  it("a switched notice and a staying-put notice of the SAME kind are told apart by their titles - no detail row decides it", () => {
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
    expect(switched.text).toBe("Switched providers");
    expect(stayed.text).toBe("Staying on the current provider");
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
    expect(returned.text).toBe("Switched back");
    expect(returnBlocked.text).toBe("Stayed on the current provider");
    // Falsification: remove the `fallback_returned`/`fallback_return_blocked`
    // arms from the allowlist switch and THIS assertion must go red.
    expect(notices.some((notice) => notice.key === "notice:seg-reroute")).toBe(
      false,
    );
  });
});

// D215: confirmed host outcome metadata reaches the announcer independent of
// transcript row hydration. `fallbackOutcomeAnnouncement` is the pure adapter
// for that path; it speaks the same TITLE-only sentence as
// `fallbackNoticeAnnouncements` (`fallbackNoticeText`), not a parallel
// formatter that could drift out of sync with it.
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

  it("keys by blockId (not assistantMessageId), maps assistantMessageId to messageId, and speaks the title alone", () => {
    const raw = outcomeFixture({
      blockId: "block-outcome-1",
      assistantMessageId: "m-assistant-1",
      kind: "applied",
      title: "Switched providers",
      message: "Your message will resend automatically.",
      details: [{ label: "To", value: TARGET_IDENTITY }],
      sequence: 1,
    });
    const outcome = fallbackOutcomeAnnouncement(raw);
    expect(outcome).not.toBeNull();
    expect(outcome?.key).toBe("notice:block-outcome-1");
    expect(outcome?.messageId).toBe("m-assistant-1");
    expect(outcome?.text).toBe("Switched providers");
    // Falsification: key by assistantMessageId instead of blockId - two
    // outcomes on the SAME message (e.g. a retry replacing the first) would
    // collide into one consumedNotices entry instead of being independently
    // dedupable.
    expect(outcome?.key).not.toBe("notice:m-assistant-1");
  });

  it("an exhausted outcome is spoken as its title - not its message or the 'Failed on' / 'Tried' rows the live drive heard", () => {
    const raw = outcomeFixture({
      blockId: "block-outcome-2",
      assistantMessageId: "m-assistant-2",
      kind: "settled",
      title: "Routing couldn't recover this turn",
      message: "The rate limit on Claude Code · Surya 2 stands.",
      details: [
        { label: "Failed on", value: "claude/sonnet (Surya 2)" },
        { label: "Tried", value: "none" },
      ],
      sequence: 1,
    });
    expect(fallbackOutcomeAnnouncement(raw)?.text).toBe(
      "Routing couldn't recover this turn",
    );
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

  it("willAbsorb predicts exactly whether the NEXT observe speaks a direct outcome", () => {
    // `willAbsorb` exists so a producer holding an event back can find out
    // whether handing it over now would DELIVER it or bin it - an absorbing
    // observe records the key and pushes nothing, so a deferred outcome passed
    // into one is consumed and lost. The value of that answer is entirely in
    // its agreeing with what `observe` then does, so this asserts the
    // agreement rather than restating the predicate: the expectation is read
    // off `observe`'s own behaviour. Change the absorb rule in one place and
    // this goes red.
    const observer = createFallbackAnnouncementObserver();
    let sequence = 0;
    const step = (
      overrides: Partial<FallbackAnnouncementsInput>,
      because: string,
    ): void => {
      sequence += 1;
      // A fresh key each step, or the seen-set would mute a later step for a
      // reason that has nothing to do with absorption.
      const next = input({
        ...overrides,
        manualOutcome: { key: `m${sequence}`, text: `switched ${sequence}` },
      });
      // Asked with the same inputs, immediately before the call it describes.
      // `observe` mutates both of the things absorption turns on, so this is
      // the only order in which the answer means anything.
      const predicted = observer.willAbsorb({
        ready: next.ready,
        baselineEpoch: next.baselineEpoch,
      });
      expect(observer.observe(next).length > 0, because).toBe(!predicted);
    };

    // One observer's lifetime, walking every cause of absorption and the
    // speaking case between them.
    step({ baselineEpoch: 1 }, "first observation ever: nothing was ready yet");
    step({ baselineEpoch: 1 }, "primed and ready: speaks");
    step({ baselineEpoch: 1, ready: false }, "not ready");
    step(
      { baselineEpoch: 1 },
      "FIRST ready observation after a gap - still absorbing, because " +
        "`wasReady` is assigned at the END of the previous observe",
    );
    step({ baselineEpoch: 1 }, "ready twice running: speaks");
    step({ baselineEpoch: 2 }, "new baseline epoch: changed provenance");
    step({ baselineEpoch: 2 }, "settled on the new epoch: speaks");
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

  it("waiting: a targetIdentity-only catalogue resolution does not enqueue a second announcement", () => {
    const waitPlan = plan({
      planId: "plan-wait-1",
      action: "wait",
      destination: null,
      resumesAt: NOW + 60_000,
    });
    const waiting = (targetIdentity: string, revision: number) => {
      const result = fallbackTraversalAnnouncement({
        pending: pendingFallback({
          state: "waiting",
          traversalId: "t1",
          revision,
          deadline: NOW + 5_000,
          queuedItemsMoving: 0,
        }),
        plan: waitPlan,
        failedIdentity: FAILED_IDENTITY,
        targetIdentity,
        now: NOW,
      });
      if (result === null) {
        throw new Error("expected a waiting announcement");
      }
      return result;
    };
    const observer = createFallbackAnnouncementObserver();
    // Absorb a different state so the first waiting observation is live.
    observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("hold", 1, "p1") }),
    );
    const first = observer.observe(
      input({
        baselineEpoch: 1,
        traversal: waiting("claude-fable-5-1[1m]", 2),
      }),
    );
    expect(first).toHaveLength(1);

    // Same sentence, different unused targetIdentity, later revision.
    // Falsification: put `targetIdentity` in waiting's semanticKey and this
    // re-announces character-for-character.
    const second = observer.observe(
      input({
        baselineEpoch: 1,
        traversal: waiting("Claude Fable", 3),
      }),
    );
    expect(second).toEqual([]);
  });

  it("hold + switch: a failedIdentity-only catalogue resolution does not enqueue a second announcement", () => {
    const switchPlan = plan({
      planId: "plan-switch-1",
      action: "switch",
      destination: TARGET_IDENTITY,
      resumesAt: null,
    });
    const holdSwitch = (failedIdentity: string, revision: number) => {
      const result = fallbackTraversalAnnouncement({
        pending: pendingFallback({
          state: "hold",
          traversalId: "t1",
          revision,
          deadline: NOW + 12_000,
          queuedItemsMoving: 0,
        }),
        plan: switchPlan,
        failedIdentity,
        targetIdentity: TARGET_IDENTITY,
        now: NOW,
      });
      if (result === null) {
        throw new Error("expected a hold announcement");
      }
      return result;
    };
    const observer = createFallbackAnnouncementObserver();
    observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("choosing", 1, "p1") }),
    );
    const first = observer.observe(
      input({
        baselineEpoch: 1,
        traversal: holdSwitch(FAILED_IDENTITY, 2),
      }),
    );
    expect(first).toHaveLength(1);

    // The switch sentence names the destination, not the failed tuple.
    // Falsification: put `failedIdentity` into hold/choosing spoken
    // identities unconditionally, and this re-announces the same sentence.
    const failedResolved = observer.observe(
      input({
        baselineEpoch: 1,
        traversal: holdSwitch("Claude Fable (acct-north)", 3),
      }),
    );
    expect(failedResolved).toEqual([]);
  });

  it("switching: a destination resolving slug → label DOES re-announce", () => {
    const switchPlan = plan({
      planId: "plan-switch-1",
      action: "switch",
      destination: "claude-fable-5-1[1m]",
      resumesAt: null,
    });
    const switching = (targetIdentity: string, revision: number) => {
      const result = fallbackTraversalAnnouncement({
        pending: pendingFallback({
          state: "switching",
          traversalId: "t1",
          revision,
          deadline: null,
          queuedItemsMoving: 0,
        }),
        plan: switchPlan,
        failedIdentity: FAILED_IDENTITY,
        targetIdentity,
        now: NOW,
      });
      if (result === null) {
        throw new Error("expected a switching announcement");
      }
      return result;
    };
    const observer = createFallbackAnnouncementObserver();
    observer.observe(
      input({ baselineEpoch: 1, traversal: traversal("hold", 1, "p1") }),
    );
    const slug = observer.observe(
      input({
        baselineEpoch: 1,
        traversal: switching("claude-fable-5-1[1m]", 2),
      }),
    );
    expect(slug).toHaveLength(1);
    expect(slug[0]?.text).toBe("Switching this chat to claude-fable-5-1[1m].");

    const labelled = observer.observe(
      input({
        baselineEpoch: 1,
        traversal: switching("Claude Fable", 3),
      }),
    );
    expect(labelled).toHaveLength(1);
    expect(labelled[0]?.text).toBe("Switching this chat to Claude Fable.");
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

/**
 * The host ruling on a hold's lifecycle, pinned at the seam the wire leaves us
 * with: there is no `phase` field, so the phases are read off the DTO frames.
 * Frames go through the real adapter (`fallbackAnnouncementPlan` +
 * `fallbackTraversalAnnouncement`) and on into the real observer.
 */
describe("the fallback hold lifecycle across host frames", () => {
  const TRAVERSAL = "t-lifecycle";

  function action(input: {
    readonly planId: string;
    readonly rung: FallbackImpendingAction["rung"];
    readonly target: ChatRunSettings | null;
    readonly resumesAt: number | null;
    readonly pending: FallbackImpendingAction["pending"];
  }): FallbackImpendingAction {
    return {
      planId: input.planId,
      rung: input.rung,
      target: input.target,
      targetModelFamily: null,
      resumesAt: input.resumesAt,
      pending: input.pending,
    };
  }

  function frame(input: {
    readonly state: PendingFallback["state"];
    readonly revision: number;
    readonly targetTuple: ChatRunSettings | null;
    readonly impendingAction: FallbackImpendingAction | null;
    readonly deadline: number | null;
    readonly siblingSwitching: number;
  }): PendingFallback {
    return {
      ...pendingFallback({
        state: input.state,
        traversalId: TRAVERSAL,
        revision: input.revision,
        deadline: input.deadline,
        queuedItemsMoving: 0,
      }),
      targetTuple: input.targetTuple,
      impendingAction: input.impendingAction,
      siblingSwitching: input.siblingSwitching,
    };
  }

  /**
   * The ONE identity production computes per frame: the real
   * `fallbackResolvedIdentitySentence`, which reads the destination through
   * `pendingFallbackDestinationTuple` (targetTuple first, then the impending
   * action's target). Not re-derived here.
   */
  function identityOfFrame(pending: PendingFallback): string | null {
    return fallbackResolvedIdentitySentence(
      { kind: "fallback", pending },
      (profileId) => profileId ?? "Terminal account",
      (_harnessId, model) => model,
    );
  }

  /** The destination sentence a tuple renders as, via the same real function. */
  function identityOfTuple(tuple: ChatRunSettings): string {
    const sentence = identityOfFrame(
      frame({
        state: "switching",
        revision: 1,
        targetTuple: tuple,
        impendingAction: null,
        deadline: null,
        siblingSwitching: 0,
      }),
    );
    if (sentence === null) throw new Error("a committed tuple names itself");
    return sentence;
  }

  const A_IDENTITY = identityOfTuple(TARGET_TUPLE);
  const B_IDENTITY = identityOfTuple(PREFERRED_TUPLE);
  const C_TUPLE: ChatRunSettings = {
    ...TARGET_TUPLE,
    model: "gpt-6-astra-nano",
  };
  const C_IDENTITY = identityOfTuple(C_TUPLE);

  function announced(
    pending: PendingFallback,
    now: number,
  ): FallbackTraversalAnnouncement | null {
    const identity = identityOfFrame(pending);
    return fallbackTraversalAnnouncement({
      pending,
      plan: fallbackAnnouncementPlan(pending, identity),
      failedIdentity: FAILED_IDENTITY,
      targetIdentity: identity,
      now,
    });
  }

  function observerInput(
    traversal: FallbackTraversalAnnouncement | null,
  ): FallbackAnnouncementsInput {
    return {
      ready: true,
      baselineEpoch: 1,
      hydrationSequence: 0,
      coldRewrittenMessageIds: new Set(),
      residentMessageIds: new Set(),
      traversal,
      returnOffer: null,
      liveOutcome: null,
      notices: [],
      manualOutcome: null,
      unattendedOutcome: null,
    };
  }

  /** An observer already past its absorbing baseline, so every frame speaks. */
  function primedObserver(): {
    readonly feed: (pending: PendingFallback, now: number) => string[];
  } {
    const observer = createFallbackAnnouncementObserver();
    observer.observe(observerInput(null));
    observer.observe(observerInput(null));
    return {
      feed: (pending, now) =>
        observer
          .observe(observerInput(announced(pending, now)))
          .map((entry) => entry.text),
    };
  }

  const SWITCH_A = action({
    planId: "plan-A",
    rung: "profile",
    target: TARGET_TUPLE,
    resumesAt: null,
    pending: null,
  });

  function holdA(deadline: number, revision: number): PendingFallback {
    return frame({
      state: "hold",
      revision,
      targetTuple: null,
      impendingAction: SWITCH_A,
      deadline,
      siblingSwitching: 0,
    });
  }

  it("a re-opened hold is announced once, as a new plan", () => {
    const d1 = NOW + 12_000;
    const d2 = NOW + 20_000;
    const switchB = action({
      planId: "plan-B",
      rung: "profile",
      target: PREFERRED_TUPLE,
      resumesAt: null,
      pending: null,
    });
    const reopened = (
      revision: number,
      siblingSwitching: number,
    ): PendingFallback =>
      frame({
        state: "hold",
        revision,
        targetTuple: null,
        impendingAction: switchB,
        deadline: d2,
        siblingSwitching,
      });
    const { feed } = primedObserver();
    const spoken: string[] = [];
    spoken.push(...feed(holdA(d1, 1), NOW));
    spoken.push(...feed(reopened(2, 0), d2 - 5_000));
    // Only a tick, a sibling count or a revision moved: nothing new.
    spoken.push(...feed(reopened(2, 0), d2 - 4_000));
    spoken.push(...feed(reopened(3, 0), d2 - 3_000));
    spoken.push(...feed(reopened(4, 1), d2 - 2_000));

    expect(spoken).toEqual([
      `The chat will switch to ${A_IDENTITY}. You have 12 seconds to cancel. Select ${DONT_SWITCH_LABEL} to cancel.`,
      `The chat will switch to ${B_IDENTITY}. You have 5 seconds to cancel. Select ${DONT_SWITCH_LABEL} to cancel.`,
    ]);
  });

  it("the honoured switching frames do not re-announce the plan", () => {
    const { feed } = primedObserver();
    const switching = (
      revision: number,
      targetTuple: ChatRunSettings | null,
    ): PendingFallback =>
      frame({
        state: "switching",
        revision,
        targetTuple,
        impendingAction: SWITCH_A,
        deadline: null,
        siblingSwitching: 0,
      });

    expect(feed(holdA(NOW + 12_000, 1), NOW)).toEqual([
      `The chat will switch to ${A_IDENTITY}. You have 12 seconds to cancel. Select ${DONT_SWITCH_LABEL} to cancel.`,
    ]);
    expect(feed(switching(2, null), NOW + 12_000)).toEqual([
      `Switching this chat to ${A_IDENTITY}.`,
    ]);
    expect(feed(switching(3, TARGET_TUPLE), NOW + 12_500)).toEqual([]);
  });

  it("a hold re-opened as a wait is announced once", () => {
    const resumesAt = NOW + 3_600_000;
    const { feed } = primedObserver();
    const first = feed(holdA(NOW + 12_000, 1), NOW);
    expect(first).toHaveLength(1);
    const reopened = frame({
      state: "hold",
      revision: 2,
      targetTuple: null,
      impendingAction: action({
        planId: "plan-wait",
        rung: "wait",
        target: null,
        resumesAt,
        pending: null,
      }),
      deadline: NOW + 20_000,
      siblingSwitching: 0,
    });
    const second = feed(reopened, NOW + 15_000);
    expect(second).toHaveLength(1);
    expect(second[0]).toContain(
      `The chat will wait for ${FAILED_IDENTITY} and resume at ${formatClockTime(resumesAt)}.`,
    );
    expect(second[0]).toContain(`Select ${DONT_WAIT_LABEL} to cancel.`);
  });

  it("an older host's Deciding frame at expiry announces nothing until a target is named", () => {
    const { feed } = primedObserver();
    expect(feed(holdA(NOW + 12_000, 1), NOW)).toHaveLength(1);
    const resolving = action({
      planId: "plan-resolving",
      rung: "profile",
      target: null,
      resumesAt: null,
      pending: "resolving",
    });
    expect(
      feed(
        frame({
          state: "switching",
          revision: 2,
          targetTuple: null,
          impendingAction: resolving,
          deadline: null,
          siblingSwitching: 0,
        }),
        NOW + 12_000,
      ),
    ).toEqual([]);
    expect(
      feed(
        frame({
          state: "switching",
          revision: 3,
          targetTuple: PREFERRED_TUPLE,
          impendingAction: null,
          deadline: null,
          siblingSwitching: 0,
        }),
        NOW + 12_500,
      ),
    ).toEqual([`Switching this chat to ${B_IDENTITY}.`]);
  });

  it("a second change commits with no hold frame", () => {
    const switchB = action({
      planId: "plan-B",
      rung: "profile",
      target: PREFERRED_TUPLE,
      resumesAt: null,
      pending: null,
    });
    const switchC = action({
      planId: "plan-C",
      rung: "profile",
      target: C_TUPLE,
      resumesAt: null,
      pending: null,
    });
    const { feed } = primedObserver();
    const spoken: string[] = [];
    spoken.push(...feed(holdA(NOW + 12_000, 1), NOW));
    spoken.push(
      ...feed(
        frame({
          state: "hold",
          revision: 2,
          targetTuple: null,
          impendingAction: switchB,
          deadline: NOW + 20_000,
          siblingSwitching: 0,
        }),
        NOW + 15_000,
      ),
    );
    spoken.push(
      ...feed(
        frame({
          state: "switching",
          revision: 3,
          targetTuple: null,
          impendingAction: switchC,
          deadline: null,
          siblingSwitching: 0,
        }),
        NOW + 20_000,
      ),
    );

    expect(spoken).toEqual([
      `The chat will switch to ${A_IDENTITY}. You have 12 seconds to cancel. Select ${DONT_SWITCH_LABEL} to cancel.`,
      `The chat will switch to ${B_IDENTITY}. You have 5 seconds to cancel. Select ${DONT_SWITCH_LABEL} to cancel.`,
      `Switching this chat to ${C_IDENTITY}.`,
    ]);
    expect(
      spoken.some(
        (text) => text.includes("seconds") && text.includes(C_IDENTITY),
      ),
    ).toBe(false);
  });
});
