import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  AgentSender,
  AssistantTurnProfile,
  ChatSessionAnchor,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { TranscriptRowContext } from "@traycer/protocol/persistence/chat-transcript/row-context";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";

/**
 * Which ACCOUNT an assistant turn is labelled with, across a provider fallback
 * hop.
 *
 * The defect: a profile-only hop (Claude Personal -> Claude Work) re-dispatches
 * ONE user message as a second attempt, and the host then rewrites that user
 * row's `sessionAnchor` to the replacement's. The renderer used to label a
 * historical turn by walking to that anchor, gated on `harnessId` alone - and a
 * profile hop keeps the harness identical, so the ORIGINAL attempt silently
 * took the account that did not produce it. The symptom is the tooltip on the
 * first row, which is what these tests read.
 *
 * The fix records the account on the attempt's own row (`turnProfile`, stamped
 * at row creation) and keeps the walk only where it is provable. The two halves
 * are pinned separately below, because each can pass while the other is broken:
 * the snapshot half is about rows a CURRENT host wrote, the absent-snapshot
 * rule is about every row already on disk.
 */

const EPIC_ID = "epic-profile-attribution";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

const CLAUDE_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const CODEX_SENDER: AgentSender = {
  type: "agent",
  harnessId: "codex",
  agentId: "gpt-5-codex",
  displayName: "GPT-5 Codex",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const displayContext: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Agent",
    providerLabel: "Provider",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: () => null,
  contentBlocksPreview: () => "",
};

function userMessage(
  messageId: string,
  timestamp: number,
  sessionAnchor: ChatSessionAnchor | null,
): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor,
  };
}

function claudeSessionAnchor(
  profileId: string | null,
  labelSnapshot: string | null,
): ChatSessionAnchor {
  return {
    profileId,
    labelSnapshot,
    accountUuid: null,
    accentColor: null,
    harnessId: "claude",
    hostId: "host-1",
    sessionId: `session-${profileId ?? "ambient"}`,
    sessionWorkspaceSnapshot: {
      workspaceKind: "session-snapshot",
      primaryWorkspace: "/repo",
      secondaryWorkspaces: [],
    },
    claudeMessageUuid: "claude-message-1",
    turnTailUuid: null,
    createdAt: 1000,
    coveredUntilMessageId: null,
  };
}

function codexSessionAnchor(
  profileId: string | null,
  labelSnapshot: string | null,
): ChatSessionAnchor {
  return {
    profileId,
    labelSnapshot,
    accountUuid: null,
    accentColor: null,
    harnessId: "codex",
    hostId: "host-1",
    sessionId: `session-codex-${profileId ?? "ambient"}`,
    sessionWorkspaceSnapshot: {
      workspaceKind: "session-snapshot",
      primaryWorkspace: "/repo",
      secondaryWorkspaces: [],
    },
    codexTurnId: "codex-turn-1",
    codexUserMessageId: "codex-user-1",
    createdAt: 1000,
    coveredUntilMessageId: null,
  };
}

/**
 * One assistant attempt. `turnProfile` is passed as `undefined` for a row
 * written before the field existed - the shape the absent-snapshot rule is
 * about - and `null` is deliberately NOT accepted here, because the schema has
 * no such state and a test that could spell it would be testing a shape the
 * host cannot produce.
 */
function attempt(input: {
  readonly turnId: string;
  readonly timestamp: number;
  readonly sender: AgentSender;
  readonly turnProfile: AssistantTurnProfile | undefined;
}): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: `msg-${input.turnId}`,
    sender: input.sender,
    blocks: [
      {
        type: "text",
        blockId: `text-${input.turnId}`,
        status: "completed",
        timestamp: input.timestamp,
        text: "output",
        providerNotice: null,
      },
    ],
    startedAt: input.timestamp,
    timestamp: input.timestamp,
    turnId: input.turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
    ...(input.turnProfile === undefined
      ? {}
      : { turnProfile: input.turnProfile }),
  };
}

function profileLabelsWithContext(
  messages: ReadonlyArray<Message>,
  rowContext: Readonly<Record<string, TranscriptRowContext>>,
): (string | null)[] {
  const value: RenderedMessagesInput = {
    messages,
    events: [],
    rowContext,
    pendingUserMessages: [],
    liveAssistantMessage: null,
    activeTurn: null,
    runStatus: "idle",
    setupCardWindows: [],
    epicId: EPIC_ID,
    ownerId: "owner-1",
    ownerKind: "chat",
    viewTabId: "tab-1",
  };
  const { result } = renderHook(() =>
    useRenderedMessages(value, displayContext),
  );
  return result.current
    .filter((row) => row.role === "assistant")
    .map((row) => row.assistantMeta?.profileLabel ?? null);
}

/** The legacy / full-materialize line: the host serves no row context at all. */
function profileLabels(messages: ReadonlyArray<Message>): (string | null)[] {
  return profileLabelsWithContext(messages, {});
}

// The user row as it looks AFTER the hop: its anchor has been rewritten to the
// replacement attempt's. That rewrite is the whole defect - a fixture that kept
// the original anchor here would pass with the walk still in place and measure
// nothing.
const HOPPED_USER = userMessage(
  "user-hopped",
  1000,
  claudeSessionAnchor("work-profile", "Claude Work"),
);

describe("a fallback hop labels each attempt with the account that produced it", () => {
  it("profile-only hop: the ORIGINAL turn keeps Personal and the replacement gets Work", () => {
    const labels = profileLabels([
      HOPPED_USER,
      attempt({
        turnId: "turn-original",
        timestamp: 2000,
        sender: CLAUDE_SENDER,
        turnProfile: {
          profileId: "personal-profile",
          labelSnapshot: "Claude Personal",
        },
      }),
      attempt({
        turnId: "turn-replacement",
        timestamp: 3000,
        sender: CLAUDE_SENDER,
        turnProfile: {
          profileId: "work-profile",
          labelSnapshot: "Claude Work",
        },
      }),
    ]);

    // Falsification: delete the `turn.recorded` branch in
    // `profileLabelsByTurnKeyFromMessages` so both turns fall through to the
    // walk. Predicted: the first entry becomes null (the absent-snapshot rule
    // refuses a two-attempt user row), NOT "Claude Work" - the rule already
    // covers this shape, so the SNAPSHOT is what turns a refusal into the
    // right answer. Restoring the pre-fix code entirely (walk, harness gate
    // only) gives ["Claude Work", "Claude Work"], which is the shipped bug.
    expect(labels).toEqual(["Claude Personal", "Claude Work"]);
  });

  it("tier hop: the original turn keeps its label instead of losing it to the harness gate", () => {
    const labels = profileLabels([
      userMessage(
        "user-tier-hopped",
        1000,
        // A tier hop moves the harness too, so the rewritten anchor is a CODEX
        // anchor - which is why the pre-fix renderer dropped the Claude turn's
        // label rather than mislabelling it.
        codexSessionAnchor("codex-work", "Codex Work"),
      ),
      attempt({
        turnId: "turn-claude-attempt",
        timestamp: 2000,
        sender: CLAUDE_SENDER,
        turnProfile: {
          profileId: "personal-profile",
          labelSnapshot: "Claude Personal",
        },
      }),
      attempt({
        turnId: "turn-codex-attempt",
        timestamp: 3000,
        sender: CODEX_SENDER,
        turnProfile: { profileId: "codex-work", labelSnapshot: "Codex Work" },
      }),
    ]);

    expect(labels).toEqual(["Claude Personal", "Codex Work"]);
  });

  it("a recorded AMBIENT snapshot is a positive claim, not silence", () => {
    const labels = profileLabels([
      HOPPED_USER,
      attempt({
        turnId: "turn-ambient",
        timestamp: 2000,
        sender: CLAUDE_SENDER,
        turnProfile: { profileId: null, labelSnapshot: null },
      }),
      attempt({
        turnId: "turn-after-ambient",
        timestamp: 3000,
        sender: CLAUDE_SENDER,
        turnProfile: {
          profileId: "work-profile",
          labelSnapshot: "Claude Work",
        },
      }),
    ]);

    // Not null: the row states it ran on the host sign-in. Reading `null`
    // through `??` as "nothing recorded" is exactly the collapse the outer
    // optional exists to prevent, and this arm is what catches it.
    expect(labels).toEqual(["Terminal account", "Claude Work"]);
  });
});

describe("the absent-snapshot rule, in both directions", () => {
  it("a WAKE turn beside an ordinary one does not cost the ordinary one its label", () => {
    // A host-started wake turn has no user message of its own, so its records
    // land in the preceding user row's span. Treating that as a second attempt
    // blanks the account on the ORDINARY turn - across most historical agent
    // chats, none of which ever fell back. `deliveryPlacement: null` is the
    // historical shape, which is the population this protects.
    const wake: Extract<Message, { role: "assistant" }> = {
      ...attempt({
        turnId: "turn-wake",
        timestamp: 3000,
        sender: CLAUDE_SENDER,
        turnProfile: undefined,
      }),
      blocks: [
        {
          type: "autonomous_resume",
          blockId: "wake-block",
          status: "completed",
          timestamp: 3000,
          deliveryPlacement: null,
          triggers: [],
        },
      ],
    };
    const labels = profileLabels([
      userMessage(
        "user-with-wake",
        1000,
        claudeSessionAnchor("personal-profile", "Claude Personal"),
      ),
      attempt({
        turnId: "turn-before-wake",
        timestamp: 2000,
        sender: CLAUDE_SENDER,
        turnProfile: undefined,
      }),
      wake,
    ]);

    // The wake turn itself still refuses: no anchor is ever minted for it, so
    // the one in effect belongs to another turn and can name another account.
    expect(labels).toEqual(["Claude Personal", null]);
  });

  it("ONE attempt on a user row keeps its walked label", () => {
    const labels = profileLabels([
      userMessage(
        "user-single",
        1000,
        claudeSessionAnchor("personal-profile", "Claude Personal"),
      ),
      attempt({
        turnId: "turn-single",
        timestamp: 2000,
        sender: CLAUDE_SENDER,
        turnProfile: undefined,
      }),
    ]);

    // The half a blanket "never walk without a snapshot" rule would break:
    // every assistant row every existing user already has is this shape, and
    // blanking them is a visible regression in chats that never hopped.
    expect(labels).toEqual(["Claude Personal"]);
  });

  it("TWO attempts on one user row render no label rather than guessing", () => {
    const labels = profileLabels([
      HOPPED_USER,
      attempt({
        turnId: "turn-cold-original",
        timestamp: 2000,
        sender: CLAUDE_SENDER,
        turnProfile: undefined,
      }),
      attempt({
        turnId: "turn-cold-replacement",
        timestamp: 3000,
        sender: CLAUDE_SENDER,
        turnProfile: undefined,
      }),
    ]);

    // BOTH refuse, not just the later one. The attempt that gets mislabelled
    // is the FIRST - the anchor moved out from under it - so a rule that only
    // distrusted later turns would keep the wrong label and drop the right
    // one. Pinning `[null, null]` rather than `[null, "Claude Work"]` is what
    // makes that asymmetry non-reintroducible.
    expect(labels).toEqual([null, null]);
  });

  it("a snapshot on ONE of two attempts rescues only that attempt", () => {
    const labels = profileLabels([
      HOPPED_USER,
      attempt({
        turnId: "turn-legacy-original",
        timestamp: 2000,
        sender: CLAUDE_SENDER,
        turnProfile: undefined,
      }),
      // The replay shape cost-and-trust raised: a CURRENT host manually
      // replays an OLD failed attempt, so B is stamped and A never can be.
      attempt({
        turnId: "turn-fresh-replay",
        timestamp: 3000,
        sender: CLAUDE_SENDER,
        turnProfile: {
          profileId: "work-profile",
          labelSnapshot: "Claude Work",
        },
      }),
    ]);

    expect(labels).toEqual([null, "Claude Work"]);
  });

  it("a WINDOW holding only the first of two attempts still refuses, on the host's say-so", () => {
    // The case the client cannot decide for itself. The span holds the user row
    // and attempt A; attempt B fell outside it. The renderer's own walk counts
    // ONE attempt, finds the (rewritten) anchor on the user row it does hold,
    // and would label A with the replacement's account. Only the host saw both.
    const span: ReadonlyArray<Message> = [
      HOPPED_USER,
      attempt({
        turnId: "turn-windowed-original",
        timestamp: 2000,
        sender: CLAUDE_SENDER,
        turnProfile: undefined,
      }),
    ];

    // Control FIRST: the same span with the host carrying its anchor and no
    // refusal is labelled. Without this, the refusal below could equally be a
    // span that was never going to produce a label.
    expect(
      profileLabelsWithContext(span, {
        "assistant:turn-windowed-original": {
          sessionAnchor: claudeSessionAnchor("work-profile", "Claude Work"),
        },
      }),
    ).toEqual(["Claude Work"]);

    expect(
      profileLabelsWithContext(span, {
        "assistant:turn-windowed-original": { profileWalkUnprovable: true },
      }),
    ).toEqual([null]);
  });

  it("a mid-turn steer does not make one turn look like two attempts", () => {
    // A steer splits a turn's RECORDS around a nested user row, and that user
    // row resets the per-row attempt span. Both slices share one turnId, so the
    // turn must still count once - otherwise the rule would blank the label on
    // every steered turn in the product, which is not a fallback at all.
    const steered = userMessage("user-steer", 2500, null);
    const labels = profileLabels([
      userMessage(
        "user-steered-turn",
        1000,
        claudeSessionAnchor("personal-profile", "Claude Personal"),
      ),
      {
        ...attempt({
          turnId: "turn-steered",
          timestamp: 2000,
          sender: CLAUDE_SENDER,
          turnProfile: undefined,
        }),
        blocks: [
          {
            type: "text",
            blockId: "text-pre-steer",
            status: "completed",
            timestamp: 2000,
            text: "before",
            providerNotice: null,
          },
          {
            type: "steer",
            blockId: "steer-1",
            status: "completed",
            timestamp: 2500,
            queueItemId: "queue:steer-1",
            messageId: steered.messageId,
            content: CONTENT,
            mode: "safe_point",
            sender: null,
          },
          {
            type: "text",
            blockId: "text-post-steer",
            status: "completed",
            timestamp: 2600,
            text: "after",
            providerNotice: null,
          },
        ],
      },
      steered,
    ]);

    // Precondition: the turn actually SPLIT into two rows. Without it, "the
    // label survived" could just mean the fixture never exercised a steer.
    expect(labels).toHaveLength(2);
    expect(labels).toEqual(["Claude Personal", "Claude Personal"]);
  });
});
