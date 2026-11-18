import { describe, expect, it } from "vitest";
import type { LastFailedAttempt } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";
import type { ProfileRateLimitSwitchPrompt } from "@/components/chat/composer/use-profile-rate-limit-switch-prompt";
import { composerRateLimitAdvisory } from "@/components/chat/fallback/fallback-return-low-usage";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import type { FailedTurnRefusal } from "@/components/chat/fallback/failed-turn-actions";
import type { RefusalRemainingActions } from "@/components/chat/fallback/fallback-copy";
import {
  settledRoutingCardOffersSwitch,
  type ComposerBannerAccount,
} from "@/components/chat/fallback/use-settled-routing-card-offers-switch";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  lastFailedAttempt,
  pendingFallback,
  providerProfile,
} from "./fallback-fixtures";

const TURN_ID = "turn-limited";
const OLDER_TURN_ID = "turn-older";

/** The account the composer's banner speaks about: the failed tuple's own. */
const ACCOUNT: ComposerBannerAccount = {
  harnessId: FAILED_CLAUDE_TUPLE.harnessId,
  profileId: FAILED_CLAUDE_TUPLE.profileId,
};

type Slice = Parameters<typeof settledRoutingCardOffersSwitch>[0];

/** A minimal chat record: the switch seeds from `chat.settings` when the attempt names no tuple. */
function chatWithSettings(
  settings: ChatRunSettings | null,
): NonNullable<ChatSessionState["chat"]> {
  return {
    id: "chat-1",
    parentId: null,
    userId: "owner-1",
    hostId: "host-1",
    title: "Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    settings,
    activeSessionChain: null,
    claudePendingWakes: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
}

function refusalOn(
  turnId: string,
  remaining: RefusalRemainingActions,
): FailedTurnRefusal {
  return { turnId, copy: { text: "Nope.", remaining } };
}

function attempt(
  overrides: Partial<{
    eligibleRungs: LastFailedAttempt["eligibleRungs"];
    failedTuple: LastFailedAttempt["failedTuple"];
  }>,
): LastFailedAttempt {
  return lastFailedAttempt({
    userMessageId: "user-1",
    turnId: TURN_ID,
    failure: { reason: "rate_limit" },
    eligibleRungs: overrides.eligibleRungs ?? ["switch"],
    waitDisposition: "no_verified_reset",
    switchDisposition: "eligible",
    failedTuple:
      overrides.failedTuple === undefined
        ? FAILED_CLAUDE_TUPLE
        : overrides.failedTuple,
  });
}

interface NoticeBlock {
  readonly blockId: string;
  readonly parentBlockId: string | null;
  /** `undefined` leaves the key off, as a host that predates it does. */
  readonly receipt:
    | { readonly causeLabel: string; readonly steps: ReadonlyArray<never> }
    | null
    | undefined;
}

const RECEIPT = { causeLabel: "Rate limit reached", steps: [] };

/** A top-level fallback notice carrying a receipt - the settled card's own. */
function receiptNotice(blockId: string): NoticeBlock {
  return { blockId, parentBlockId: null, receipt: RECEIPT };
}

function assistantMessage(input: {
  readonly messageId: string;
  readonly turnId: string;
  readonly notices: ReadonlyArray<NoticeBlock>;
}): Message {
  return messageSchema.parse({
    role: "assistant",
    messageId: input.messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: null,
    },
    blocks: [
      {
        blockId: `${input.messageId}:text`,
        status: "completed",
        timestamp: 1,
        type: "text",
        text: "Working on it.",
        providerNotice: null,
      },
      ...input.notices.map((notice) => ({
        blockId: notice.blockId,
        parentBlockId: notice.parentBlockId,
        status: "completed",
        timestamp: 2,
        type: "text",
        text: "Routing stopped.",
        providerNotice: {
          harnessId: "claude",
          noticeKind: "fallback_settled",
          tone: "info",
          title: "Routing stopped",
          message: null,
          details: [],
          metadata: null,
          ...(notice.receipt === undefined ? {} : { receipt: notice.receipt }),
        },
      })),
    ],
    timestamp: 3,
    turnId: input.turnId,
    usage: null,
  });
}

function turnWithReceipt(): ReadonlyArray<Message> {
  return [
    assistantMessage({
      messageId: "a-limited",
      turnId: TURN_ID,
      notices: [receiptNotice("notice-1")],
    }),
  ];
}

/** The all-true baseline: every case below flips exactly one term of it. */
function baseline(): Slice {
  return {
    lastFailedAttempt: attempt({
      eligibleRungs: ["switch"],
      failedTuple: FAILED_CLAUDE_TUPLE,
    }),
    pendingFallback: undefined,
    access: { role: "owner", ownerUserId: "owner-1", canAct: true },
    messages: turnWithReceipt(),
    chat: chatWithSettings(FAILED_CLAUDE_TUPLE),
  };
}

function offersSwitch(slice: Slice): boolean {
  return settledRoutingCardOffersSwitch(slice, null, ACCOUNT);
}

describe("settledRoutingCardOffersSwitch", () => {
  it("is true for the baseline: an attempt with rungs, no live card, an owner, the account's own tuple, and a receipt on the turn", () => {
    expect(offersSwitch(baseline())).toBe(true);
  });

  it("is true with no failed tuple (its replay envelope is gone), for any account", () => {
    const slice: Slice = {
      ...baseline(),
      lastFailedAttempt: attempt({
        eligibleRungs: ["switch"],
        failedTuple: null,
      }),
    };
    expect(offersSwitch(slice)).toBe(true);
    expect(
      settledRoutingCardOffersSwitch(slice, null, {
        harnessId: "codex",
        profileId: "other",
      }),
    ).toBe(true);
  });

  it("is true while access is not yet known (null), as the card's own gate reads it", () => {
    expect(offersSwitch({ ...baseline(), access: null })).toBe(true);
  });

  it("is false with no failed attempt", () => {
    expect(offersSwitch({ ...baseline(), lastFailedAttempt: undefined })).toBe(
      false,
    );
  });

  it("is false when the attempt admits no rung, or a list without switch", () => {
    expect(
      offersSwitch({
        ...baseline(),
        lastFailedAttempt: attempt({
          eligibleRungs: [],
          failedTuple: FAILED_CLAUDE_TUPLE,
        }),
      }),
    ).toBe(false);
  });

  it("is false for eligibleRungs that omit switch, whatever else is admitted", () => {
    for (const eligibleRungs of [
      ["retry", "wait_once"],
      ["retry"],
      ["wait_once"],
    ] as const) {
      expect(
        offersSwitch({
          ...baseline(),
          lastFailedAttempt: attempt({
            eligibleRungs: [...eligibleRungs],
            failedTuple: FAILED_CLAUDE_TUPLE,
          }),
        }),
      ).toBe(false);
    }
  });

  it("is false while a visible countdown is live", () => {
    const countdown = pendingFallback({
      state: "hold",
      reason: "rate_limit",
      failedTuple: FAILED_CLAUDE_TUPLE,
      targetTuple: TARGET_CODEX_TUPLE,
      impendingAction: null,
      deadline: 1_700_000_012_000,
      attempt: 1,
      maxAttempts: 3,
      queuedItemsMoving: 0,
      siblingSwitching: 0,
      traversalId: "traversal-1",
      revision: 1,
    });
    expect(offersSwitch({ ...baseline(), pendingFallback: countdown })).toBe(
      false,
    );
  });

  it("is false for a viewer, whose card carries no actions", () => {
    expect(
      offersSwitch({
        ...baseline(),
        access: { role: "viewer", ownerUserId: "owner-1", canAct: false },
      }),
    ).toBe(false);
  });

  it("is false for a different profile than the failed tuple's", () => {
    expect(
      settledRoutingCardOffersSwitch(baseline(), null, {
        ...ACCOUNT,
        profileId: "another-profile",
      }),
    ).toBe(false);
    // A null profile is the Terminal account, which is not this profile either.
    expect(
      settledRoutingCardOffersSwitch(baseline(), null, {
        ...ACCOUNT,
        profileId: null,
      }),
    ).toBe(false);
  });

  it("is false for a different harness than the failed tuple's", () => {
    expect(
      settledRoutingCardOffersSwitch(baseline(), null, {
        ...ACCOUNT,
        harnessId: "codex",
      }),
    ).toBe(false);
  });

  it("is false when the turn has no receipt notice (routing off, so the banner stays)", () => {
    expect(
      offersSwitch({
        ...baseline(),
        messages: [
          assistantMessage({
            messageId: "a-limited",
            turnId: TURN_ID,
            notices: [],
          }),
        ],
      }),
    ).toBe(false);
    expect(offersSwitch({ ...baseline(), messages: [] })).toBe(false);
  });

  it("is false when the receipt notice is nested under another block", () => {
    expect(
      offersSwitch({
        ...baseline(),
        messages: [
          assistantMessage({
            messageId: "a-limited",
            turnId: TURN_ID,
            notices: [
              {
                blockId: "notice-nested",
                parentBlockId: "subagent-1",
                receipt: RECEIPT,
              },
            ],
          }),
        ],
      }),
    ).toBe(false);
  });

  it("is false when the receipt is on an older turn only", () => {
    expect(
      offersSwitch({
        ...baseline(),
        messages: [
          assistantMessage({
            messageId: "a-older",
            turnId: OLDER_TURN_ID,
            notices: [receiptNotice("notice-older")],
          }),
          assistantMessage({
            messageId: "a-limited",
            turnId: TURN_ID,
            notices: [],
          }),
        ],
      }),
    ).toBe(false);
  });

  it("is false when the receipt is null or absent", () => {
    for (const receipt of [null, undefined] as const) {
      expect(
        offersSwitch({
          ...baseline(),
          messages: [
            assistantMessage({
              messageId: "a-limited",
              turnId: TURN_ID,
              notices: [{ blockId: "notice-1", parentBlockId: null, receipt }],
            }),
          ],
        }),
      ).toBe(false);
    }
  });

  it("finds the receipt on any assistant message of the attempt's turn (a steer splits the notice from the error)", () => {
    // A steer that splits the turn: notice on the first message, error on the
    // second; both carry the turn id, and routing did settle that turn.
    expect(
      offersSwitch({
        ...baseline(),
        messages: [
          assistantMessage({
            messageId: "a-first",
            turnId: TURN_ID,
            notices: [receiptNotice("notice-1")],
          }),
          assistantMessage({
            messageId: "a-second",
            turnId: TURN_ID,
            notices: [],
          }),
        ],
      }),
    ).toBe(true);
  });
});

describe("the card's own refusal and seed", () => {
  it("is false when a refusal on THIS attempt's turn leaves no action", () => {
    expect(
      settledRoutingCardOffersSwitch(
        baseline(),
        refusalOn(TURN_ID, "none"),
        ACCOUNT,
      ),
    ).toBe(false);
  });

  it.each(["switch", "retry_and_switch", "all"] as const)(
    "is true when a refusal on THIS attempt's turn leaves %s",
    (remaining) => {
      expect(
        settledRoutingCardOffersSwitch(
          baseline(),
          refusalOn(TURN_ID, remaining),
          ACCOUNT,
        ),
      ).toBe(true);
    },
  );

  it("ignores a refusal recorded for ANOTHER turn", () => {
    expect(
      settledRoutingCardOffersSwitch(
        baseline(),
        refusalOn(OLDER_TURN_ID, "none"),
        ACCOUNT,
      ),
    ).toBe(true);
  });

  it("is false with no failed tuple and no chat to seed the switch from", () => {
    expect(
      offersSwitch({
        ...baseline(),
        lastFailedAttempt: attempt({
          eligibleRungs: ["switch"],
          failedTuple: null,
        }),
        chat: null,
      }),
    ).toBe(false);
  });

  it("is true with no failed tuple when the chat's own settings seed the switch", () => {
    expect(
      offersSwitch({
        ...baseline(),
        lastFailedAttempt: attempt({
          eligibleRungs: ["switch"],
          failedTuple: null,
        }),
        chat: chatWithSettings(FAILED_CLAUDE_TUPLE),
      }),
    ).toBe(true);
  });
});

describe("the composer banner is withheld exactly while the settled card offers its switch", () => {
  const current: ProviderProfile = providerProfile({
    profileId: "failed01-profile",
    kind: "managed",
    label: "failed01",
    authenticated: true,
  });
  const prompt: ProfileRateLimitSwitchPrompt = {
    kind: "visible",
    warningKey: "warning-key",
    providerId: "claude-code",
    severity: "hard_limit",
    limitedFamilies: [],
    current,
    profiles: [current],
    destinations: [],
    primaryTarget: null,
    probeTarget: null,
    dismiss: () => undefined,
  };

  // The composer computes `composerRateLimitAdvisory(prompt, signedOut ||
  // settledCardOffersSwitch)`; the composer has no render harness in this
  // suite tree, so the predicate feeding that expression is the pin.
  it("returns no advisory (so no banner) with a settled card, and one without", () => {
    const withCard = offersSwitch(baseline());
    const withoutCard = offersSwitch({ ...baseline(), messages: [] });

    expect(composerRateLimitAdvisory(prompt, withCard)).toBeNull();
    expect(composerRateLimitAdvisory(prompt, withoutCard)).not.toBeNull();
    expect(composerRateLimitAdvisory(prompt, true)).toBeNull();
  });
});

// After an A -> B hop fails, what the host names as `failedTuple` depends on
// its build. The producer's shape either way: `lastFailedAttempt.turnId` is B's
// replacement turn, and the receipt notice is on that turn's assistant message.
describe("the account a hop leaves the failed tuple on", () => {
  const REPLACEMENT_TURN_ID = "turn-replacement-on-b";
  const ACCOUNT_B: ComposerBannerAccount = {
    harnessId: TARGET_CODEX_TUPLE.harnessId,
    profileId: TARGET_CODEX_TUPLE.profileId,
  };

  /** B's replacement turn failed: its latest turn carries the settled receipt. */
  function hopFailedOnB(failedTuple: LastFailedAttempt["failedTuple"]): Slice {
    return {
      lastFailedAttempt: lastFailedAttempt({
        userMessageId: "user-1",
        turnId: REPLACEMENT_TURN_ID,
        failure: { reason: "rate_limit" },
        eligibleRungs: ["retry", "switch"],
        waitDisposition: "no_verified_reset",
        switchDisposition: "eligible",
        failedTuple,
      }),
      pendingFallback: undefined,
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
      messages: [
        assistantMessage({
          messageId: "a-replacement",
          turnId: REPLACEMENT_TURN_ID,
          notices: [receiptNotice("notice-on-b")],
        }),
      ],
      chat: chatWithSettings(TARGET_CODEX_TUPLE),
    };
  }

  it("new host: failedTuple is the LAST attempt's account after a hop, so the composer on B has its banner suppressed", () => {
    expect(
      settledRoutingCardOffersSwitch(
        hopFailedOnB(TARGET_CODEX_TUPLE),
        null,
        ACCOUNT_B,
      ),
    ).toBe(true);
  });

  // Accepted behaviour against a host that predates the fix: it still names the
  // ORIGINAL account A, so a composer on B is not the failed tuple's account and
  // the banner shows beside the card.
  it("older host: failedTuple stays the ORIGINAL account A after a hop, so the composer on B shows its banner beside the card", () => {
    expect(
      settledRoutingCardOffersSwitch(
        hopFailedOnB(FAILED_CLAUDE_TUPLE),
        null,
        ACCOUNT_B,
      ),
    ).toBe(false);
  });
});
