import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { ChatSubscribeClientFrame } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  chatSubscribeV14,
  chatSubscribeV15,
  chatSubscribeV16,
  chatSubscribeV17,
  chatSubscribeSnapshotServerFrameShallowSchemaV16,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { InterviewAnswer } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  INTERVIEW_SETTLEMENT_METADATA_KEY,
  normalizeInterviewBlocksInShallowSnapshot,
  projectChatClientFrameForVersion,
  projectChatServerFrameForVersion,
  supportsInterviewSettlementActions,
  type ProjectedChatSubscribeServerFrame,
} from "../chat-frame-compat";

const OWNER = {
  hasBinaryPayload: false as const,
  epicId: "epic-1",
  chatId: "chat-1",
  clientActionId: "action-1",
};

const SELECTION: InterviewAnswer["selection"] = {
  questionIndex: 0,
  optionIndices: [0],
  optionLabels: ["date-fns"],
  customText: null,
};

const ENHANCED_ANSWER: InterviewAnswer = {
  questionId: "q1",
  question: "Which library?",
  values: ["date-fns"],
  notes: null,
  selection: SELECTION,
};

function interviewAnswerFrame(): ChatSubscribeClientFrame {
  return {
    kind: "interviewAnswer",
    ...OWNER,
    blockId: "iv-1",
    answers: [ENHANCED_ANSWER],
  };
}

function interviewErrorFrame(): ChatSubscribeClientFrame {
  return {
    kind: "interviewError",
    ...OWNER,
    blockId: "iv-1",
    reason: "Not now",
    settlement: {
      outcome: "skipped",
      draftAnswers: [ENHANCED_ANSWER],
    },
  };
}

function resumeQueueFrame(): ChatSubscribeClientFrame {
  return {
    kind: "resumeQueue",
    ...OWNER,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAnswers(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error("expected answers array");
  }
  return value.map((answer, index) => {
    if (!isRecord(answer)) {
      throw new Error(`expected answer object at ${index}`);
    }
    return answer;
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected object for ${label}`);
  }
  return value;
}

function legacyLines(): ReadonlyArray<SchemaVersion | null> {
  return [
    { major: 1, minor: 6 },
    { major: 1, minor: 5 },
    { major: 1, minor: 4 },
    null,
  ];
}

describe("supportsInterviewSettlementActions", () => {
  it("is true only on 1.7 and later", () => {
    expect(supportsInterviewSettlementActions({ major: 1, minor: 7 })).toBe(
      true,
    );
    expect(supportsInterviewSettlementActions({ major: 1, minor: 6 })).toBe(
      false,
    );
    expect(supportsInterviewSettlementActions(null)).toBe(false);
  });
});

describe("projectChatClientFrameForVersion", () => {
  it("is identity on {1,7}", () => {
    const answer = interviewAnswerFrame();
    const error = interviewErrorFrame();
    const resume = resumeQueueFrame();
    expect(
      projectChatClientFrameForVersion(answer, { major: 1, minor: 7 }),
    ).toBe(answer);
    expect(
      projectChatClientFrameForVersion(error, { major: 1, minor: 7 }),
    ).toBe(error);
    expect(
      projectChatClientFrameForVersion(resume, { major: 1, minor: 7 }),
    ).toBe(resume);
  });

  it("removes the selection key from interviewAnswer answers on every pre-1.7 line", () => {
    const frame = interviewAnswerFrame();
    for (const version of legacyLines()) {
      const projected = projectChatClientFrameForVersion(frame, version);
      expect(projected.kind).toBe("interviewAnswer");
      const answers = recordAnswers(projected.answers);
      expect(answers).toHaveLength(1);
      expect(Object.hasOwn(answers[0], "selection")).toBe(false);
      expect(answers[0].values).toEqual(["date-fns"]);
      expect(chatSubscribeV16.clientFrameSchema.parse(projected).kind).toBe(
        "interviewAnswer",
      );
      expect(chatSubscribeV15.clientFrameSchema.parse(projected).kind).toBe(
        "interviewAnswer",
      );
      expect(chatSubscribeV14.clientFrameSchema.parse(projected).kind).toBe(
        "interviewAnswer",
      );
    }
  });

  it("removes the settlement key from interviewError on every pre-1.7 line", () => {
    const frame = interviewErrorFrame();
    for (const version of legacyLines()) {
      const projected = projectChatClientFrameForVersion(frame, version);
      expect(projected.kind).toBe("interviewError");
      expect(Object.hasOwn(projected, "settlement")).toBe(false);
      expect(projected.reason).toBe("Not now");
      expect(chatSubscribeV16.clientFrameSchema.parse(projected).kind).toBe(
        "interviewError",
      );
      expect(chatSubscribeV15.clientFrameSchema.parse(projected).kind).toBe(
        "interviewError",
      );
      expect(chatSubscribeV14.clientFrameSchema.parse(projected).kind).toBe(
        "interviewError",
      );
    }
  });

  it("leaves every other action kind referentially identical", () => {
    const frames: ChatSubscribeClientFrame[] = [
      resumeQueueFrame(),
      {
        kind: "pauseQueue",
        ...OWNER,
      },
      {
        kind: "stopBackgroundSession",
        ...OWNER,
      },
      {
        kind: "approvalDecision",
        ...OWNER,
        approvalId: "appr-1",
        decision: { approved: true },
      },
    ];
    for (const frame of frames) {
      for (const version of legacyLines()) {
        expect(projectChatClientFrameForVersion(frame, version)).toBe(frame);
      }
      expect(
        projectChatClientFrameForVersion(frame, { major: 1, minor: 7 }),
      ).toBe(frame);
    }
  });
});

/**
 * A production-shaped durable chat event. The deep `1.7` parse validates these
 * fully (unlike the shallow path's `z.custom`), so a stub with three keys is
 * rejected before the assertion under test is ever reached.
 */
function chatEventFixture(
  eventId: string,
  timestamp: number,
): Record<string, unknown> {
  return {
    eventId,
    type: "send.accepted",
    timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: null,
  };
}

/**
 * A production-shaped durable chat event of a chosen type. The projector is
 * typed against `event.type` and `event.metadata`; a stub missing the rest of
 * `chatEventSchema` would fail the frozen deep parse before the assertion
 * under test is reached.
 */
function chatEventWith(
  eventId: string,
  timestamp: number,
  type: string,
  metadata: unknown,
): Record<string, unknown> {
  return {
    ...chatEventFixture(eventId, timestamp),
    type,
    blockId: "iv-1",
    metadata,
  };
}

function eventAppendedFrame(
  event: Record<string, unknown>,
): ProjectedChatSubscribeServerFrame {
  return asProjectedServerFrame({
    kind: "eventAppended",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    event,
  });
}

function eventFromProjected(
  frame: ProjectedChatSubscribeServerFrame,
): Record<string, unknown> {
  return asRecord(asRecord(frame, "projected").event, "event");
}

function snapshotEvents(frame: Record<string, unknown>): unknown[] {
  const snapshot = asRecord(frame.snapshot, "snapshot");
  const chat = asRecord(snapshot.chat, "chat");
  if (!Array.isArray(chat.events)) {
    throw new Error("expected events");
  }
  return chat.events;
}

function resolvedAnswersMetadata(): Record<string, unknown> {
  return {
    answers: [
      {
        questionId: "q1",
        question: "Which library?",
        values: ["date-fns"],
        notes: null,
        selection: SELECTION,
      },
    ],
  };
}

function nestedSettlementFacts(): Record<string, unknown> {
  return {
    settlementId: "gui-1",
    outcome: "answered",
    source: "gui",
    reason: "settlement reason, not the event reason",
    answers: [
      {
        questionId: "q1",
        question: "Which library?",
        values: ["date-fns"],
        notes: null,
        selection: SELECTION,
      },
    ],
  };
}

function agentSender(): Record<string, unknown> {
  return {
    type: "agent",
    harnessId: "codex",
    agentId: "agent-1",
    displayName: "Coder",
    reply: { expectsReply: false },
    inReplyTo: null,
  };
}

function textBlock(blockId: string): Record<string, unknown> {
  return {
    blockId,
    status: "completed",
    timestamp: 10,
    parentBlockId: null,
    type: "text",
    text: "hello",
  };
}

function legacyInterviewBlock(blockId: string): Record<string, unknown> {
  // Pre-1.7 shape: no outcome/drafts/settlement/diagnostics/delivery, and
  // answers carry no selection. The normalizer's job is to supply those
  // defaults in place without touching any other block.
  return {
    blockId,
    status: "completed",
    timestamp: 20,
    parentBlockId: null,
    type: "interview",
    toolName: "AskUserQuestion",
    title: "Library",
    description: "Pick one",
    questions: [
      {
        questionId: "q1",
        question: "Which library?",
        header: "Library",
        options: [{ label: "date-fns", description: null, preview: null }],
        multiSelect: false,
      },
    ],
    answers: [
      {
        questionId: "q1",
        question: "Which library?",
        values: ["date-fns"],
        notes: null,
      },
    ],
    error: null,
    metadata: null,
  };
}

function assistantMessage(
  messageId: string,
  blocks: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    role: "assistant",
    messageId,
    sender: agentSender(),
    blocks,
    startedAt: 10,
    timestamp: 20,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  };
}

function v16SnapshotEnvelope(
  messages: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: {
      chat: {
        id: "chat-1",
        parentId: null,
        userId: "owner-1",
        hostId: "test-host",
        title: "Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        sessionRef: null,
        messages,
        events: [],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      backgroundItems: [],
      managedCommands: [],
      heldUpdates: [],
    },
  };
}

function interviewFields(block: Record<string, unknown>): {
  readonly outcome: unknown;
  readonly draftAnswers: unknown;
  readonly settlement: unknown;
  readonly diagnostics: unknown;
  readonly delivery: unknown;
  readonly settlementExtensions: unknown;
  readonly answers: ReadonlyArray<{
    readonly values: unknown;
    readonly selection: unknown;
  }>;
} {
  const answers = recordAnswers(block.answers).map((answer) => ({
    values: answer.values,
    selection: Object.hasOwn(answer, "selection")
      ? answer.selection
      : undefined,
  }));
  return {
    outcome: block.outcome,
    draftAnswers: block.draftAnswers,
    settlement: block.settlement,
    diagnostics: block.diagnostics,
    delivery: block.delivery,
    settlementExtensions: block.settlementExtensions,
    answers,
  };
}

function extractInterviewBlocks(
  messages: ReadonlyArray<unknown>,
): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const message of messages) {
    const record = asRecord(message, "message");
    if (record.role !== "assistant") continue;
    if (!Array.isArray(record.blocks)) continue;
    for (const block of record.blocks) {
      const blockRecord = asRecord(block, "block");
      if (blockRecord.type === "interview") found.push(blockRecord);
    }
  }
  return found;
}

describe("chatSubscribeSnapshotServerFrameShallowSchemaV16", () => {
  it("accepts a 1.6 full-chat snapshot and leaves chat.messages / chat.events structural", () => {
    const text = textBlock("text-1");
    const interview = legacyInterviewBlock("iv-1");
    const payload = v16SnapshotEnvelope([
      assistantMessage("assistant-1", [text, interview]),
    ]);
    const parsed =
      chatSubscribeSnapshotServerFrameShallowSchemaV16.parse(payload);
    expect(parsed.kind).toBe("snapshot");
    // Structural: the interview still lacks 1.7 keys, proving the schema
    // did not walk the histories. The normalizer — not this schema — supplies
    // those defaults.
    const messages = parsed.snapshot.chat.messages;
    expect(messages).toHaveLength(1);
    const interviewAfter = extractInterviewBlocks(messages)[0];
    expect(Object.hasOwn(interviewAfter, "outcome")).toBe(false);
    expect(Object.hasOwn(interviewAfter, "draftAnswers")).toBe(false);
    expect(parsed.snapshot.chat.events).toEqual([]);
  });
});

describe("normalizeInterviewBlocksInShallowSnapshot", () => {
  it("neutralizes every interview settlement field in place and leaves non-interview blocks referentially unchanged", () => {
    const text = textBlock("text-1");
    const interview = legacyInterviewBlock("iv-1");
    const populatedInterview: Record<string, unknown> = {
      ...legacyInterviewBlock("iv-2"),
      outcome: "answered",
      draftAnswers: [],
      settlement: { settlementId: "s1", source: "gui" },
      diagnostics: [],
      delivery: {
        deliveryId: "d1",
        status: "delivered",
        retryable: false,
      },
      answers: [
        {
          questionId: "q1",
          question: "Which library?",
          values: ["date-fns"],
          notes: null,
          selection: SELECTION,
        },
      ],
    };
    const message = assistantMessage("assistant-1", [
      text,
      interview,
      populatedInterview,
    ]);
    const messages: unknown[] = [message];
    const originalText = asRecord(message, "message").blocks;
    if (!Array.isArray(originalText)) {
      throw new Error("expected blocks array");
    }
    const textRef = originalText[0];
    const populatedRef = originalText[2];

    normalizeInterviewBlocksInShallowSnapshot(messages);

    expect(originalText[0]).toBe(textRef);
    expect(originalText[2]).toBe(populatedRef);

    // A legal 1.6 frame CANNOT carry these fields, so a populated one did not
    // come from a conforming 1.6 host - and the shallow path never validated
    // it. Trusting it would let a mislabeled or hostile peer smuggle an
    // unvalidated settlement authority and a "delivered" claim straight into
    // history. Neutralized, not preserved.
    expect(populatedInterview.outcome).toBeNull();
    expect(populatedInterview.settlement).toBeNull();
    expect(populatedInterview.delivery).toBeNull();
    expect(populatedInterview.diagnostics).toEqual([]);
    expect(populatedInterview.draftAnswers).toEqual([]);
    expect(populatedInterview.settlementExtensions).toEqual({});
    expect(recordAnswers(populatedInterview.answers)[0].selection).toBeNull();
    // The answer's own content is untouched - only the unvalidatable
    // provenance is dropped.
    expect(recordAnswers(populatedInterview.answers)[0].values).toEqual([
      "date-fns",
    ]);

    expect(interview.outcome).toBeNull();
    expect(interview.draftAnswers).toEqual([]);
    expect(interview.settlement).toBeNull();
    expect(interview.diagnostics).toEqual([]);
    expect(interview.delivery).toBeNull();
    expect(interview.settlementExtensions).toEqual({});
    const answers = recordAnswers(interview.answers);
    expect(answers[0].selection).toBeNull();
    expect(answers[0].values).toEqual(["date-fns"]);
  });

  it("overwrites malformed enhanced values rather than filling around them", () => {
    // The shallow path never validated these, so a number/string/array in a
    // settlement field is not "present truth" - it is hostile or buggy input
    // and must be neutralized. `values` is the answer the provider sees and
    // stays untouched.
    const malformed: Record<string, unknown> = {
      ...legacyInterviewBlock("iv-malformed"),
      outcome: 42,
      settlement: "nope",
      delivery: [],
      diagnostics: "x",
      draftAnswers: {},
    };
    const messages: unknown[] = [assistantMessage("assistant-1", [malformed])];
    normalizeInterviewBlocksInShallowSnapshot(messages);
    expect(malformed.outcome).toBeNull();
    expect(malformed.settlement).toBeNull();
    expect(malformed.delivery).toBeNull();
    expect(malformed.diagnostics).toEqual([]);
    expect(malformed.draftAnswers).toEqual([]);
    expect(malformed.settlementExtensions).toEqual({});
    expect(recordAnswers(malformed.answers)[0].values).toEqual(["date-fns"]);
  });

  it("overwrites future-shaped but plausible settlement values", () => {
    // A newer writer adding `cancelled` / `queued` must not smuggle those
    // through a 1.6 shallow snapshot: on this line they are absent.
    const future: Record<string, unknown> = {
      ...legacyInterviewBlock("iv-future"),
      outcome: "cancelled",
      delivery: {
        deliveryId: "d1",
        status: "queued",
        retryable: false,
      },
      settlementExtensions: { escalation: { level: 2 } },
    };
    normalizeInterviewBlocksInShallowSnapshot([
      assistantMessage("assistant-1", [future]),
    ]);
    expect(future.outcome).toBeNull();
    expect(future.delivery).toBeNull();
    expect(future.settlement).toBeNull();
    expect(future.settlementExtensions).toEqual({});
  });
});

describe("1.6 shallow snapshot + normalizer vs deep 1.7 parse", () => {
  const LARGE_MESSAGE_COUNT = 2500;

  function buildLargeSnapshot(): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];
    for (let index = 0; index < LARGE_MESSAGE_COUNT; index += 1) {
      if (index % 50 === 0) {
        messages.push(
          assistantMessage(`assistant-${index}`, [
            textBlock(`text-${index}`),
            legacyInterviewBlock(`iv-${index}`),
          ]),
        );
      } else {
        messages.push(
          assistantMessage(`assistant-${index}`, [textBlock(`text-${index}`)]),
        );
      }
    }
    return v16SnapshotEnvelope(messages);
  }

  it("produces the same interview-block shape as a deep 1.7 parse, and is materially faster", () => {
    const payload = buildLargeSnapshot();

    const shallowCopy = structuredClone(payload);
    const shallowParsed =
      chatSubscribeSnapshotServerFrameShallowSchemaV16.parse(shallowCopy);
    normalizeInterviewBlocksInShallowSnapshot(
      shallowParsed.snapshot.chat.messages,
    );
    const shallowInterviews = extractInterviewBlocks(
      shallowParsed.snapshot.chat.messages,
    ).map(interviewFields);

    const deepParsed = chatSubscribeV17.serverFrameSchema.parse(
      structuredClone(payload),
    );
    if (deepParsed.kind !== "snapshot") {
      throw new Error("expected snapshot");
    }
    const deepInterviews = extractInterviewBlocks(
      deepParsed.snapshot.chat.messages,
    ).map(interviewFields);

    expect(shallowInterviews.length).toBeGreaterThan(0);
    expect(shallowInterviews).toEqual(deepInterviews);

    // THE STRUCTURAL PROOF that the shallow path did not deep-walk the
    // histories - a deterministic replacement for the timing assertion this
    // test used to make.
    //
    // A deep zod parse REBUILDS every object it validates, so the messages it
    // returns are new references. The shallow schema validates the two history
    // arrays with `z.custom`, which passes the value through untouched, so its
    // messages are the SAME objects as the input's. Identity is therefore an
    // exact witness for "no deep walk happened", and unlike a wall-clock ratio
    // it cannot flake on a loaded CI runner.
    //
    // It is also a strictly stronger regression gate: swapping the shallow
    // schema for the deep one fails this immediately and unambiguously,
    // whereas a timing floor only fails once the machine is quiet enough to
    // measure the difference.
    const identityInput = structuredClone(payload);
    const identitySnapshot = identityInput.snapshot;
    if (!isRecord(identitySnapshot)) throw new Error("expected snapshot");
    const identityChat = identitySnapshot.chat;
    if (!isRecord(identityChat)) throw new Error("expected chat");
    const inputMessages = identityChat.messages;
    if (!Array.isArray(inputMessages)) throw new Error("expected messages");
    const inputEvents: Record<string, unknown>[] = [
      chatEventFixture("e1", 1),
      chatEventFixture("e2", 2),
    ];
    identityChat.events = inputEvents;

    const identityParsed =
      chatSubscribeSnapshotServerFrameShallowSchemaV16.parse(identityInput);
    expect(identityParsed.snapshot.chat.messages).toHaveLength(
      inputMessages.length,
    );
    identityParsed.snapshot.chat.messages.forEach((message, index) => {
      expect(message).toBe(inputMessages[index]);
    });
    // Same witness for `chat.events`: the shallow schema's `z.custom` pass
    // through. A deep parse would rebuild these objects.
    expect(identityParsed.snapshot.chat.events).toHaveLength(
      inputEvents.length,
    );
    identityParsed.snapshot.chat.events.forEach((event, index) => {
      expect(event).toBe(inputEvents[index]);
    });

    // The contrast that makes the assertions above meaningful rather than
    // vacuous: the deep parse does NOT preserve identity.
    //
    // The references MUST come from the very object handed to the deep parse.
    // Comparing against `inputMessages` - which belongs to a different clone -
    // would pass no matter what the deep parser did, because two clones never
    // share references. That is a test that can only ever succeed, which is
    // worse than no test: it reports the contrast as verified while checking
    // nothing.
    const deepInput = structuredClone(payload);
    const deepSnapshot = deepInput.snapshot;
    if (!isRecord(deepSnapshot)) throw new Error("expected snapshot");
    const deepChat = deepSnapshot.chat;
    if (!isRecord(deepChat)) throw new Error("expected chat");
    // The base payload carries no events, and `expect(undefined).not.toBe(
    // undefined)` is the same vacuity this block exists to remove - so give
    // the deep input the SAME event fixtures the identity half used.
    const deepInputEvents: Record<string, unknown>[] = [
      chatEventFixture("e1", 1),
      chatEventFixture("e2", 2),
    ];
    deepChat.events = deepInputEvents;
    const deepInputMessages = deepChat.messages;
    if (!Array.isArray(deepInputMessages)) {
      throw new Error("expected messages");
    }
    expect(deepInputMessages.length).toBeGreaterThan(0);
    expect(deepInputEvents.length).toBeGreaterThan(0);

    const deepRebuilt = chatSubscribeV17.serverFrameSchema.parse(deepInput);
    if (deepRebuilt.kind !== "snapshot") throw new Error("expected snapshot");
    expect(deepRebuilt.snapshot.chat.messages[0]).not.toBe(
      deepInputMessages[0],
    );
    expect(deepRebuilt.snapshot.chat.events[0]).not.toBe(deepInputEvents[0]);
  }, 60_000);
});

const STRIPPED_INTERVIEW_BLOCK_KEYS = [
  "outcome",
  "draftAnswers",
  "settlement",
  "diagnostics",
  "delivery",
  "settlementExtensions",
] as const;

function populatedInterviewBlock(blockId: string): Record<string, unknown> {
  return {
    ...legacyInterviewBlock(blockId),
    outcome: "answered",
    draftAnswers: [
      {
        questionId: "q1",
        question: "Which library?",
        values: ["lodash"],
        notes: "saved, not sent",
        selection: SELECTION,
      },
    ],
    settlement: { settlementId: "gui-1", source: "gui" },
    diagnostics: [
      {
        diagnosticId: "diag-1",
        code: "runtime.interview_errored",
        source: "runtime",
      },
    ],
    delivery: {
      deliveryId: "del-1",
      status: "delivered",
      retryable: false,
    },
    settlementExtensions: { escalation: { level: 2 } },
    answers: [
      {
        questionId: "q1",
        question: "Which library?",
        values: ["date-fns"],
        notes: null,
        selection: SELECTION,
      },
    ],
  };
}

function userMessage(): Record<string, unknown> {
  return {
    role: "user",
    messageId: "user-1",
    sender: { type: "user", userId: "user-1" },
    message: {
      kind: "user",
      content: { type: "doc", content: [] },
    },
    timestamp: 5,
    sessionAnchor: null,
  };
}

function asProjectedServerFrame(
  value: Record<string, unknown>,
): ProjectedChatSubscribeServerFrame {
  if (typeof value.kind !== "string") {
    throw new Error("expected frame kind");
  }
  if (value.hasBinaryPayload !== false) {
    throw new Error("expected text frame");
  }
  return {
    ...value,
    kind: value.kind,
    hasBinaryPayload: false,
  };
}

function expectInterviewBlockStripped(block: Record<string, unknown>): void {
  for (const key of STRIPPED_INTERVIEW_BLOCK_KEYS) {
    expect(Object.hasOwn(block, key)).toBe(false);
  }
  const answers = recordAnswers(block.answers);
  expect(answers.length).toBeGreaterThan(0);
  expect(Object.hasOwn(answers[0], "selection")).toBe(false);
  expect(answers[0].values).toEqual(["date-fns"]);
}

function firstAnswerRecord(value: unknown): Record<string, unknown> {
  const answers = recordAnswers(value);
  if (answers.length === 0) {
    throw new Error("expected answers");
  }
  return answers[0];
}

function snapshotInterviewFromFrame(
  frame: Record<string, unknown>,
): Record<string, unknown> {
  const snapshot = asRecord(frame.snapshot, "snapshot");
  const chat = asRecord(snapshot.chat, "chat");
  if (!Array.isArray(chat.messages)) {
    throw new Error("expected messages");
  }
  const interviews = extractInterviewBlocks(chat.messages);
  if (interviews.length === 0) {
    throw new Error("expected interview block");
  }
  return interviews[0];
}

function frozenServerContracts(): ReadonlyArray<{
  readonly name: string;
  readonly parse: (value: unknown) => Record<string, unknown>;
}> {
  return [
    {
      name: "1.6",
      parse: (value: unknown) =>
        asRecord(chatSubscribeV16.serverFrameSchema.parse(value), "v16"),
    },
    {
      name: "1.5",
      parse: (value: unknown) =>
        asRecord(chatSubscribeV15.serverFrameSchema.parse(value), "v15"),
    },
    {
      name: "1.4",
      parse: (value: unknown) =>
        asRecord(chatSubscribeV14.serverFrameSchema.parse(value), "v14"),
    },
  ];
}

describe("projectChatServerFrameForVersion", () => {
  const live: SchemaVersion = { major: 1, minor: 7 };

  it("is identity on {1,7}", () => {
    const text = textBlock("text-1");
    const interview = populatedInterviewBlock("iv-1");
    const snapshot = asProjectedServerFrame(
      v16SnapshotEnvelope([assistantMessage("assistant-1", [text, interview])]),
    );
    const answered = asProjectedServerFrame({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "iv-1",
      answers: [ENHANCED_ANSWER],
      resolvedAt: 20,
      settlementId: "gui-1",
      settlementSource: "gui",
      delivery: {
        deliveryId: "del-1",
        status: "delivered",
        retryable: false,
      },
    });
    expect(projectChatServerFrameForVersion(snapshot, live)).toBe(snapshot);
    expect(projectChatServerFrameForVersion(answered, live)).toBe(answered);
  });

  it("strips nested snapshot interview settlement fields and keeps other blocks/messages identical", () => {
    const text = textBlock("text-1");
    const interview = populatedInterviewBlock("iv-1");
    const user = userMessage();
    const assistant = assistantMessage("assistant-1", [text, interview]);
    const frame = asProjectedServerFrame(
      v16SnapshotEnvelope([user, assistant]),
    );

    for (const version of legacyLines()) {
      const projected = projectChatServerFrameForVersion(frame, version);
      expect(projected).not.toBe(frame);
      expect(projected.kind).toBe("snapshot");
      const projectedRecord = asRecord(projected, "projected");
      const snapshot = asRecord(projectedRecord.snapshot, "snapshot");
      const chat = asRecord(snapshot.chat, "chat");
      if (!Array.isArray(chat.messages)) {
        throw new Error("expected messages");
      }
      expect(chat.messages[0]).toBe(user);
      const projectedAssistant = asRecord(chat.messages[1], "assistant");
      if (!Array.isArray(projectedAssistant.blocks)) {
        throw new Error("expected blocks");
      }
      expect(projectedAssistant.blocks[0]).toBe(text);
      const projectedInterview = asRecord(
        projectedAssistant.blocks[1],
        "interview",
      );
      expectInterviewBlockStripped(projectedInterview);
      expect(projectedInterview).not.toBe(interview);

      for (const contract of frozenServerContracts()) {
        const parsed = contract.parse(projected);
        const parsedInterview = snapshotInterviewFromFrame(parsed);
        expect(parsedInterview).toEqual(projectedInterview);
        expectInterviewBlockStripped(parsedInterview);
      }
    }
  });

  it("strips interview settlement fields on messageAccepted and keeps non-interview messages identical", () => {
    const text = textBlock("text-1");
    const interview = populatedInterviewBlock("iv-1");
    const assistant = assistantMessage("assistant-1", [text, interview]);
    const frame = asProjectedServerFrame({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      message: assistant,
    });
    const userFrame = asProjectedServerFrame({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      message: userMessage(),
    });

    for (const version of legacyLines()) {
      const projected = projectChatServerFrameForVersion(frame, version);
      expect(projected).not.toBe(frame);
      const projectedMessage = asRecord(
        asRecord(projected, "projected").message,
        "message",
      );
      if (!Array.isArray(projectedMessage.blocks)) {
        throw new Error("expected blocks");
      }
      expect(projectedMessage.blocks[0]).toBe(text);
      expectInterviewBlockStripped(
        asRecord(projectedMessage.blocks[1], "interview"),
      );

      expect(projectChatServerFrameForVersion(userFrame, version)).toBe(
        userFrame,
      );

      // messageAccepted's frozen schema is a user message, so an
      // assistant-bearing frame is not a legal 1.4–1.6 payload. The
      // projector still strips interview settlement if one arrives; the
      // parse-equals-projected proof for this kind is the user-message
      // identity below (no settlement keys to drop).
      for (const contract of frozenServerContracts()) {
        const parsedUser = contract.parse(userFrame);
        expect(parsedUser.kind).toBe("messageAccepted");
      }
    }
  });

  it("strips selection from blockDelta(interview.resolved) and leaves other event types identical", () => {
    const resolved = asProjectedServerFrame({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      event: {
        type: "interview.resolved",
        blockId: "iv-1",
        timestamp: 20,
        answers: [ENHANCED_ANSWER],
      },
    });
    const textDelta = asProjectedServerFrame({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      event: {
        type: "text.delta",
        blockId: "t1",
        timestamp: 1,
        delta: "hello",
      },
    });

    for (const version of legacyLines()) {
      const projected = projectChatServerFrameForVersion(resolved, version);
      expect(projected).not.toBe(resolved);
      const event = asRecord(asRecord(projected, "projected").event, "event");
      expect(event.type).toBe("interview.resolved");
      expect(Object.hasOwn(firstAnswerRecord(event.answers), "selection")).toBe(
        false,
      );
      expect(firstAnswerRecord(event.answers).values).toEqual(["date-fns"]);

      expect(projectChatServerFrameForVersion(textDelta, version)).toBe(
        textDelta,
      );

      for (const contract of frozenServerContracts()) {
        const parsed = contract.parse(projected);
        const parsedEvent = asRecord(parsed.event, "parsed event");
        expect(
          Object.hasOwn(firstAnswerRecord(parsedEvent.answers), "selection"),
        ).toBe(false);
        expect(firstAnswerRecord(parsedEvent.answers)).toEqual(
          firstAnswerRecord(event.answers),
        );
      }
    }
  });

  it("strips delivery and answer selection from interviewAnswered", () => {
    const frame = asProjectedServerFrame({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "iv-1",
      answers: [ENHANCED_ANSWER],
      resolvedAt: 20,
      delivery: {
        deliveryId: "del-1",
        status: "delivered",
        retryable: false,
      },
    });

    for (const version of legacyLines()) {
      const projected = projectChatServerFrameForVersion(frame, version);
      const projectedRecord = asRecord(projected, "projected");
      expect(Object.hasOwn(projectedRecord, "delivery")).toBe(false);
      expect(Object.hasOwn(projectedRecord, "settlementId")).toBe(false);
      expect(Object.hasOwn(projectedRecord, "settlementSource")).toBe(false);
      expect(
        Object.hasOwn(firstAnswerRecord(projectedRecord.answers), "selection"),
      ).toBe(false);
      expect(firstAnswerRecord(projectedRecord.answers).values).toEqual([
        "date-fns",
      ]);

      for (const contract of frozenServerContracts()) {
        const parsed = contract.parse(projected);
        expect(Object.hasOwn(parsed, "delivery")).toBe(false);
        expect(Object.hasOwn(parsed, "settlementId")).toBe(false);
        expect(Object.hasOwn(parsed, "settlementSource")).toBe(false);
        expect(firstAnswerRecord(parsed.answers)).toEqual(
          firstAnswerRecord(projectedRecord.answers),
        );
      }
    }
  });

  it("strips outcome, draftAnswers, and delivery from interviewErrored", () => {
    const frame = asProjectedServerFrame({
      kind: "interviewErrored",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "iv-1",
      reason: "Not now",
      resolvedAt: 20,
      settlementId: "gui-1",
      settlementSource: "gui",
      outcome: "skipped",
      draftAnswers: [
        {
          questionId: "q1",
          question: "Which library?",
          values: ["lodash"],
          notes: "saved, not sent",
          selection: SELECTION,
        },
      ],
      delivery: {
        deliveryId: "del-1",
        status: "pending",
        retryable: false,
      },
    });

    for (const version of legacyLines()) {
      const projected = projectChatServerFrameForVersion(frame, version);
      const projectedRecord = asRecord(projected, "projected");
      expect(Object.hasOwn(projectedRecord, "outcome")).toBe(false);
      expect(Object.hasOwn(projectedRecord, "draftAnswers")).toBe(false);
      expect(Object.hasOwn(projectedRecord, "delivery")).toBe(false);
      expect(Object.hasOwn(projectedRecord, "settlementId")).toBe(false);
      expect(Object.hasOwn(projectedRecord, "settlementSource")).toBe(false);
      expect(projectedRecord.reason).toBe("Not now");

      for (const contract of frozenServerContracts()) {
        const parsed = contract.parse(projected);
        expect(Object.hasOwn(parsed, "outcome")).toBe(false);
        expect(Object.hasOwn(parsed, "draftAnswers")).toBe(false);
        expect(Object.hasOwn(parsed, "delivery")).toBe(false);
        expect(Object.hasOwn(parsed, "settlementId")).toBe(false);
        expect(Object.hasOwn(parsed, "settlementSource")).toBe(false);
        expect(parsed.reason).toBe(projectedRecord.reason);
      }
    }
  });

  it("leaves every other frame kind referentially identical", () => {
    const frames: ProjectedChatSubscribeServerFrame[] = [
      asProjectedServerFrame({
        kind: "pong",
        hasBinaryPayload: false,
      }),
      asProjectedServerFrame({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        runStatus: "idle",
        activeTurn: null,
      }),
      asProjectedServerFrame({
        kind: "managedCommandsChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        managedCommands: [],
      }),
      asProjectedServerFrame({
        kind: "heldUpdatesChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        heldUpdates: [],
      }),
      asProjectedServerFrame({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        action: "resumeQueue",
        status: "accepted",
        reason: null,
        code: null,
      }),
      asProjectedServerFrame({
        kind: "queueChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        queue: { status: "idle", items: [] },
      }),
      asProjectedServerFrame({
        kind: "approvalRequested",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        approval: { approvalId: "appr-1" },
      }),
      asProjectedServerFrame({
        kind: "approvalResolved",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        approvalId: "appr-1",
        decision: { approved: true },
        resolvedAt: 1,
      }),
      asProjectedServerFrame({
        kind: "fileEditApprovalRequested",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        approval: { approvalId: "fe-1" },
      }),
      asProjectedServerFrame({
        kind: "fileEditApprovalResolved",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        approvalId: "fe-1",
        decision: { approved: true },
        resolvedAt: 1,
      }),
      asProjectedServerFrame({
        kind: "interviewRequested",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        blockId: "iv-1",
        requestedAt: 1,
      }),
      asProjectedServerFrame({
        kind: "eventAppended",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: { eventId: "e1" },
      }),
      asProjectedServerFrame({
        kind: "restoreProgress",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        checkpointId: "cp-1",
        processedCount: 1,
        totalCount: 2,
      }),
      asProjectedServerFrame({
        kind: "restoreCompleted",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        checkpointId: "cp-1",
        finishedAt: 1,
        results: [],
      }),
      asProjectedServerFrame({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        notice: {
          code: "x",
          message: "y",
          severity: "info",
          clientActionId: null,
        },
      }),
      asProjectedServerFrame({
        kind: "worktreeStateChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        worktreeBinding: null,
        missingWorktreePaths: [],
      }),
    ];
    for (const frame of frames) {
      for (const version of legacyLines()) {
        expect(projectChatServerFrameForVersion(frame, version)).toBe(frame);
      }
      expect(projectChatServerFrameForVersion(frame, live)).toBe(frame);
    }
  });
});

describe("chat-event metadata projection", () => {
  const live: SchemaVersion = { major: 1, minor: 7 };

  function expectProjectedEventParses(
    projected: ProjectedChatSubscribeServerFrame,
  ): Record<string, unknown> {
    const projectedEvent = eventFromProjected(projected);
    for (const contract of frozenServerContracts()) {
      const parsed = contract.parse(projected);
      expect(parsed.kind).toBe("eventAppended");
      const parsedEvent = asRecord(parsed.event, "parsed event");
      expect(parsedEvent).toEqual(projectedEvent);
    }
    return projectedEvent;
  }

  it("is identity on {1,7} for interview events that carry settlement facts", () => {
    const resolved = eventAppendedFrame(
      chatEventWith("e-resolved", 20, "interview.resolved", {
        ...resolvedAnswersMetadata(),
        [INTERVIEW_SETTLEMENT_METADATA_KEY]: nestedSettlementFacts(),
      }),
    );
    const requested = eventAppendedFrame(
      chatEventWith("e-requested", 10, "interview.requested", {
        source: "traycer_a2a",
      }),
    );
    expect(projectChatServerFrameForVersion(resolved, live)).toBe(resolved);
    expect(projectChatServerFrameForVersion(requested, live)).toBe(requested);
  });

  it("strips selection from interview.resolved metadata.answers and keeps values", () => {
    // The live host writes `metadata: { answers }` on interview.resolved.
    // Selection evidence is a 1.7 fact; values are the answer a 1.4-1.6
    // peer has always received.
    const event = chatEventWith(
      "e-resolved",
      20,
      "interview.resolved",
      resolvedAnswersMetadata(),
    );
    const frame = eventAppendedFrame(event);

    for (const version of legacyLines()) {
      const projected = projectChatServerFrameForVersion(frame, version);
      expect(projected).not.toBe(frame);
      const projectedEvent = expectProjectedEventParses(projected);
      const answers = recordAnswers(
        asRecord(projectedEvent.metadata, "metadata").answers,
      );
      expect(answers).toHaveLength(1);
      expect(Object.hasOwn(answers[0], "selection")).toBe(false);
      expect(answers[0].values).toEqual(["date-fns"]);
      expect(answers[0].questionId).toBe("q1");
    }
  });

  it("removes the namespaced settlement key wholesale, including nested facts", () => {
    // Future settlement facts go inside the envelope so a typed projector
    // can drop them without walking the rest of the metadata bag.
    const event = chatEventWith("e-resolved", 20, "interview.resolved", {
      extra: "keep-me",
      [INTERVIEW_SETTLEMENT_METADATA_KEY]: nestedSettlementFacts(),
    });
    const frame = eventAppendedFrame(event);

    for (const version of legacyLines()) {
      const projected = projectChatServerFrameForVersion(frame, version);
      const projectedEvent = expectProjectedEventParses(projected);
      const metadata = asRecord(projectedEvent.metadata, "metadata");
      expect(Object.hasOwn(metadata, INTERVIEW_SETTLEMENT_METADATA_KEY)).toBe(
        false,
      );
      expect(metadata.extra).toBe("keep-me");
    }
  });

  it("preserves pre-1.7 interview.requested source and interview.errored reason/code byte-for-byte", () => {
    // COLLISION GUARD. Today's host writes `{ source: "traycer_a2a" }` on
    // interview.requested and `{ reason }` / `{ reason, code }` on
    // interview.errored. The settlement payload has its own `source` and
    // `reason`. A projector that stripped settlement facts by flat name
    // would silently rewrite what 1.4-1.6 peers have always received.
    const requestedMetadata = { source: "traycer_a2a" };
    const erroredMetadata = { reason: "adapter cleanup", code: "E_INTERVIEW" };
    const requestedEvent = chatEventWith(
      "e-requested",
      10,
      "interview.requested",
      requestedMetadata,
    );
    const erroredEvent = chatEventWith(
      "e-errored",
      30,
      "interview.errored",
      erroredMetadata,
    );
    const requestedFrame = eventAppendedFrame(requestedEvent);
    const erroredFrame = eventAppendedFrame(erroredEvent);

    for (const version of legacyLines()) {
      const projectedRequested = projectChatServerFrameForVersion(
        requestedFrame,
        version,
      );
      const projectedErrored = projectChatServerFrameForVersion(
        erroredFrame,
        version,
      );
      // Nothing to strip: the projector must not copy the event at all.
      expect(projectedRequested).toBe(requestedFrame);
      expect(projectedErrored).toBe(erroredFrame);
      expect(eventFromProjected(projectedRequested).metadata).toBe(
        requestedMetadata,
      );
      expect(eventFromProjected(projectedErrored).metadata).toBe(
        erroredMetadata,
      );
      expect(
        JSON.stringify(eventFromProjected(projectedRequested).metadata),
      ).toBe(JSON.stringify({ source: "traycer_a2a" }));
      expect(
        JSON.stringify(eventFromProjected(projectedErrored).metadata),
      ).toBe(JSON.stringify({ reason: "adapter cleanup", code: "E_INTERVIEW" }));
      expectProjectedEventParses(projectedRequested);
      expectProjectedEventParses(projectedErrored);
    }
  });

  it("keeps colliding source on interview.resolved while still stripping selection", () => {
    // The same event can carry BOTH a pre-1.7 `source` convention and
    // 1.7 selection evidence. Only the answer selection is 1.7; a flat
    // `source` strip would corrupt the convention the collision guard
    // exists to protect.
    const event = chatEventWith("e-resolved", 20, "interview.resolved", {
      source: "traycer_a2a",
      ...resolvedAnswersMetadata(),
    });
    const frame = eventAppendedFrame(event);

    for (const version of legacyLines()) {
      const projected = projectChatServerFrameForVersion(frame, version);
      const projectedEvent = expectProjectedEventParses(projected);
      const metadata = asRecord(projectedEvent.metadata, "metadata");
      expect(metadata.source).toBe("traycer_a2a");
      expect(
        Object.hasOwn(firstAnswerRecord(metadata.answers), "selection"),
      ).toBe(false);
      expect(firstAnswerRecord(metadata.answers).values).toEqual(["date-fns"]);
    }
  });

  it("leaves non-interview events referentially identical even when metadata looks settlement-shaped", () => {
    const metadata = {
      answers: [
        {
          questionId: "q1",
          question: "Which library?",
          values: ["date-fns"],
          notes: null,
          selection: SELECTION,
        },
      ],
      [INTERVIEW_SETTLEMENT_METADATA_KEY]: nestedSettlementFacts(),
    };
    const turnStarted = chatEventWith("e-turn", 1, "turn.started", metadata);
    const sendAccepted = chatEventWith(
      "e-send",
      2,
      "send.accepted",
      metadata,
    );
    const turnFrame = eventAppendedFrame(turnStarted);
    const sendFrame = eventAppendedFrame(sendAccepted);

    for (const version of legacyLines()) {
      expect(projectChatServerFrameForVersion(turnFrame, version)).toBe(
        turnFrame,
      );
      expect(projectChatServerFrameForVersion(sendFrame, version)).toBe(
        sendFrame,
      );
    }
    expect(projectChatServerFrameForVersion(turnFrame, live)).toBe(turnFrame);
    expect(projectChatServerFrameForVersion(sendFrame, live)).toBe(sendFrame);
  });

  it("leaves interview events with null or non-record metadata referentially identical", () => {
    const nullMeta = chatEventWith("e-null", 10, "interview.resolved", null);
    const arrayMeta = chatEventWith(
      "e-array",
      11,
      "interview.resolved",
      ["not", "a", "record"],
    );
    const stringMeta = chatEventWith(
      "e-string",
      12,
      "interview.errored",
      "not-a-record",
    );
    const nullFrame = eventAppendedFrame(nullMeta);
    const arrayFrame = eventAppendedFrame(arrayMeta);
    const stringFrame = eventAppendedFrame(stringMeta);

    for (const version of legacyLines()) {
      expect(projectChatServerFrameForVersion(nullFrame, version)).toBe(
        nullFrame,
      );
      expect(projectChatServerFrameForVersion(arrayFrame, version)).toBe(
        arrayFrame,
      );
      expect(projectChatServerFrameForVersion(stringFrame, version)).toBe(
        stringFrame,
      );
    }
    // Only `metadata: null` is a legal chatEventSchema value; the
    // non-record cases are projector-level guards, not wire payloads.
    expectProjectedEventParses(
      projectChatServerFrameForVersion(nullFrame, { major: 1, minor: 6 }),
    );
  });

  it("projects snapshot.chat.events and snapshot messages together", () => {
    // Settlement reaches a subscriber in TWO places: interview blocks on
    // messages, and metadata on the durable event log. One snapshot has
    // to exercise both or the event-log half stays untested.
    const text = textBlock("text-1");
    const interview = populatedInterviewBlock("iv-1");
    const user = userMessage();
    const resolvedEvent = chatEventWith(
      "e-resolved",
      20,
      "interview.resolved",
      {
        ...resolvedAnswersMetadata(),
        [INTERVIEW_SETTLEMENT_METADATA_KEY]: nestedSettlementFacts(),
      },
    );
    const requestedEvent = chatEventWith(
      "e-requested",
      10,
      "interview.requested",
      { source: "traycer_a2a" },
    );
    const turnEvent = chatEventWith("e-turn", 1, "turn.started", {
      answers: resolvedAnswersMetadata().answers,
    });
    const envelope = v16SnapshotEnvelope([
      user,
      assistantMessage("assistant-1", [text, interview]),
    ]);
    const snapshot = asRecord(envelope.snapshot, "snapshot");
    const chat = asRecord(snapshot.chat, "chat");
    chat.events = [turnEvent, requestedEvent, resolvedEvent];
    const frame = asProjectedServerFrame(envelope);

    for (const version of legacyLines()) {
      const projected = projectChatServerFrameForVersion(frame, version);
      expect(projected).not.toBe(frame);
      const projectedRecord = asRecord(projected, "projected");
      const projectedSnapshot = asRecord(projectedRecord.snapshot, "snapshot");
      const projectedChat = asRecord(projectedSnapshot.chat, "chat");
      if (!Array.isArray(projectedChat.messages)) {
        throw new Error("expected messages");
      }
      expect(projectedChat.messages[0]).toBe(user);
      const projectedAssistant = asRecord(
        projectedChat.messages[1],
        "assistant",
      );
      if (!Array.isArray(projectedAssistant.blocks)) {
        throw new Error("expected blocks");
      }
      expect(projectedAssistant.blocks[0]).toBe(text);
      expectInterviewBlockStripped(
        asRecord(projectedAssistant.blocks[1], "interview"),
      );

      const events = snapshotEvents(projectedRecord);
      expect(events).toHaveLength(3);
      expect(events[0]).toBe(turnEvent);
      expect(events[1]).toBe(requestedEvent);
      expect(events[2]).not.toBe(resolvedEvent);
      const projectedResolved = asRecord(events[2], "resolved event");
      const resolvedMetadata = asRecord(
        projectedResolved.metadata,
        "resolved metadata",
      );
      expect(
        Object.hasOwn(resolvedMetadata, INTERVIEW_SETTLEMENT_METADATA_KEY),
      ).toBe(false);
      expect(
        Object.hasOwn(firstAnswerRecord(resolvedMetadata.answers), "selection"),
      ).toBe(false);
      expect(firstAnswerRecord(resolvedMetadata.answers).values).toEqual([
        "date-fns",
      ]);
      expect(asRecord(events[1], "requested").metadata).toEqual({
        source: "traycer_a2a",
      });

      for (const contract of frozenServerContracts()) {
        const parsed = contract.parse(projected);
        const parsedInterview = snapshotInterviewFromFrame(parsed);
        expectInterviewBlockStripped(parsedInterview);
        const parsedEvents = snapshotEvents(parsed);
        expect(parsedEvents).toEqual(events);
      }
    }

    expect(projectChatServerFrameForVersion(frame, live)).toBe(frame);
  });
});
