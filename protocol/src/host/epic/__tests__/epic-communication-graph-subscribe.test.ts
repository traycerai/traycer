import { describe, expect, it } from "vitest";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  downgradeEpicCommunicationGraphEventV11ToV10,
  epicCommunicationGraphEventSchema,
  epicCommunicationGraphEventSchemaV11,
  epicCommunicationGraphSubscribeClientFrameSchema,
  epicCommunicationGraphSubscribeOpenRequestSchema,
  epicCommunicationGraphSubscribeServerFrameSchema,
  epicCommunicationGraphSubscribeServerFrameSchemaV11,
  epicCommunicationGraphSubscribeV10,
  epicCommunicationGraphSubscribeV11,
  upgradeEpicCommunicationGraphEventV10ToV11,
} from "@traycer/protocol/host/epic/communication-graph";

/**
 * `epic.communicationGraph.subscribe@1.0`/`@1.1` contract fixtures + the
 * optional-method degrade guard.
 *
 * The degrade case is the load-bearing one: this method ships AFTER
 * host-v1.0.0, so a host in the field may not advertise it at all. Stream
 * compatibility is evaluated per method at subscribe time, which is what keeps
 * that from being handshake-fatal - the Communication Graph tile loses that
 * one host's edges, every other subscription on the connection is untouched.
 *
 * On the frame fixtures: `snapshot` is a BOUNDED first batch, not the whole
 * backlog, so frame kind carries no activity semantics - these fixtures are
 * written to reflect that rather than the older "snapshot = everything, events
 * = live" reading.
 *
 * On the minors: `@1.1` adds four event kinds and their nullable per-kind
 * fields; `@1.0` stays FROZEN and INSTALLED, and the resolver projects each
 * subscription to the minor it negotiated (streams have no version bridges -
 * see the module doc). The tests below pin both the `@1.0` freeze and the
 * `@1.1` additive shape.
 */

const METHOD = "epic.communicationGraph.subscribe";

const A2A_MESSAGE_EVENT = {
  id: 41,
  kind: "a2a_message",
  timestamp: 1_753_000_000_000,
  senderAgentId: "agent-orchestrator",
  receiverAgentId: "agent-reviewer",
  responseId: "resp-1",
  inReplyTo: null,
  expectReply: true,
  messageText: "Review the protocol contract.",
  noticeReason: null,
  originKind: "gui_block",
  originChatId: "chat-1",
  originRefId: "block-7",
} as const;

describe("epic.communicationGraph.subscribe contract minors", () => {
  it("keeps @1.0 frozen at 1.0 while the registry's latest minor is 1.1", () => {
    expect(epicCommunicationGraphSubscribeV10.method).toBe(METHOD);
    expect(epicCommunicationGraphSubscribeV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(epicCommunicationGraphSubscribeV11.method).toBe(METHOD);
    expect(epicCommunicationGraphSubscribeV11.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
    // The manifest advertises the LATEST installed minor; `@1.0` peers still
    // connect - the host serves them resolver-projected `@1.0` frames.
    expect(buildStreamManifest(hostStreamRpcRegistry)[METHOD]).toEqual({
      major: 1,
      minor: 1,
    });
  });

  it("stays out of the unary released floor", () => {
    // The floor is fail-closed on the method-name set; an entry there would
    // make every RPC fail against a peer that predates this method.
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(METHOD);
  });

  it("requires an explicit resume cursor on the open request", () => {
    expect(
      epicCommunicationGraphSubscribeOpenRequestSchema.parse({
        epicId: "epic-1",
        sinceCursor: null,
      }).sinceCursor,
    ).toBeNull();
    expect(
      epicCommunicationGraphSubscribeOpenRequestSchema.parse({
        epicId: "epic-1",
        sinceCursor: 41,
      }).sinceCursor,
    ).toBe(41);
    expect(
      epicCommunicationGraphSubscribeOpenRequestSchema.safeParse({
        epicId: "epic-1",
      }).success,
    ).toBe(false);
  });
});

describe("epic.communicationGraph.subscribe@1.0 frames", () => {
  it("parses a snapshot frame carrying an initial batch of rows", () => {
    const parsed = epicCommunicationGraphSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      epicId: "epic-1",
      events: [A2A_MESSAGE_EVENT],
      headId: A2A_MESSAGE_EVENT.id,
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind === "snapshot") {
      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].messageText).toBe(
        "Review the protocol contract.",
      );
    }
  });

  it("parses an empty snapshot frame (epic predating capture, or a caught-up resume)", () => {
    const parsed = epicCommunicationGraphSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      epicId: "epic-1",
      events: [],
      // Required-and-nullable: an empty log reports no head, explicitly.
      headId: null,
      hasBinaryPayload: false,
    });

    expect(parsed.kind === "snapshot" && parsed.events).toEqual([]);
  });

  it("carries a bounded snapshot plus overflow events as one ascending sequence", () => {
    // The delivery contract is about ORDER and COMPLETENESS, not frame kind:
    // the snapshot is a bounded FIRST BATCH, and the rest of the backlog
    // continues as `event` frames in the same strictly id-ascending sequence.
    // This fixture encodes that shape - the ordering and exactly-once
    // properties themselves are resolver behaviour and are pinned host-side.
    const snapshot = epicCommunicationGraphSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      epicId: "epic-1",
      events: [
        { ...A2A_MESSAGE_EVENT, id: 11 },
        { ...A2A_MESSAGE_EVENT, id: 12 },
      ],
      // The log's head at handoff covers the overflow below: 13 and 14 are
      // pre-existing rows the bounded snapshot could not carry, and headId is
      // what lets a client class them as history rather than new activity.
      headId: 14,
      hasBinaryPayload: false,
    });
    // Backlog past the snapshot's bound - pre-existing rows, NOT new activity.
    const overflow = [13, 14].map((id) =>
      epicCommunicationGraphSubscribeServerFrameSchema.parse({
        kind: "event",
        epicId: "epic-1",
        event: { ...A2A_MESSAGE_EVENT, id },
        hasBinaryPayload: false,
      }),
    );

    const delivered = [
      ...(snapshot.kind === "snapshot" ? snapshot.events : []),
      ...overflow.flatMap((frame) =>
        frame.kind === "event" ? [frame.event] : [],
      ),
    ].map((event) => event.id);

    expect(delivered).toEqual([11, 12, 13, 14]);
  });

  it("parses an event frame for the notice kind", () => {
    const notice = epicCommunicationGraphEventSchema.parse({
      ...A2A_MESSAGE_EVENT,
      id: 42,
      kind: "a2a_notice",
      expectReply: null,
      messageText: "agent-reviewer went idle without replying.",
      noticeReason: "turn-ended",
      originKind: null,
      originChatId: null,
      originRefId: null,
    });
    expect(notice.kind).toBe("a2a_notice");
    expect(notice.noticeReason).toBe("turn-ended");
  });

  it("rejects the file_write kind this minor no longer carries", () => {
    // File-write capture was descoped: the graph is A2A-only, and a row whose
    // kind this contract cannot represent must fail the frame rather than
    // arrive with every file field missing.
    expect(
      epicCommunicationGraphEventSchema.safeParse({
        ...A2A_MESSAGE_EVENT,
        kind: "file_write",
      }).success,
    ).toBe(false);
  });

  it("accepts a notice reason the closed broker enum does not carry", () => {
    // `noticeReason` is an open string precisely so the historical log keeps
    // parsing when the broker's live reason set grows past this minor.
    expect(
      epicCommunicationGraphEventSchema.parse({
        ...A2A_MESSAGE_EVENT,
        kind: "a2a_notice",
        noticeReason: "some-reason-invented-after-1.0-froze",
      }).noticeReason,
    ).toBe("some-reason-invented-after-1.0-froze");
  });

  it("requires noticeReason to be present, per the required-nullable convention", () => {
    const { noticeReason: _omittedReason, ...withoutNoticeReason } =
      A2A_MESSAGE_EVENT;

    expect(
      epicCommunicationGraphEventSchema.safeParse(withoutNoticeReason).success,
    ).toBe(false);
  });

  it("parses the heartbeat frames", () => {
    expect(
      epicCommunicationGraphSubscribeServerFrameSchema.parse({
        kind: "pong",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("pong");
    expect(
      epicCommunicationGraphSubscribeClientFrameSchema.parse({
        kind: "ping",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("ping");
  });

  it("rejects an unknown event kind", () => {
    expect(
      epicCommunicationGraphEventSchema.safeParse({
        ...A2A_MESSAGE_EVENT,
        kind: "artifact_write",
      }).success,
    ).toBe(false);
  });
});

describe("epic.communicationGraph.subscribe@1.1 rows", () => {
  // The @1.1 event is the frozen @1.0 object plus 17 required-nullable
  // per-kind fields. `V11_EMPTY_EVENT` is the "@1.0 row upgraded" baseline;
  // each fixture below fills only the fields its kind owns.
  const V11_EMPTY_EVENT = {
    ...A2A_MESSAGE_EVENT,
    toolName: null,
    toolInput: null,
    durationMs: null,
    success: null,
    tokenCost: null,
    approvalId: null,
    status: null,
    targetAction: null,
    agentId: null,
    previousState: null,
    newState: null,
    trigger: null,
    hostId: null,
    resourceType: null,
    metricValue: null,
    threshold: null,
    breach: null,
  } as const;

  it("parses a tool_call row with its per-kind fields populated", () => {
    const row = epicCommunicationGraphEventSchemaV11.parse({
      ...V11_EMPTY_EVENT,
      id: 101,
      kind: "tool_call",
      senderAgentId: "agent-builder",
      receiverAgentId: null,
      responseId: null,
      inReplyTo: null,
      expectReply: null,
      messageText: null,
      toolName: "read_file",
      toolInput: "read protocol/src/host/epic/communication-graph.ts",
      durationMs: 312,
      success: true,
      tokenCost: 1542,
    });
    expect(row.kind).toBe("tool_call");
    expect(row.toolName).toBe("read_file");
    expect(row.durationMs).toBe(312);
    expect(row.success).toBe(true);
    expect(row.tokenCost).toBe(1542);
    // Fields owned by other kinds stay null on this row.
    expect(row.approvalId).toBeNull();
    expect(row.hostId).toBeNull();
    expect(row.agentId).toBeNull();
  });

  it("parses an approval row with its per-kind fields populated", () => {
    const row = epicCommunicationGraphEventSchemaV11.parse({
      ...V11_EMPTY_EVENT,
      id: 102,
      kind: "approval",
      senderAgentId: "agent-builder",
      receiverAgentId: null,
      responseId: null,
      inReplyTo: null,
      expectReply: null,
      messageText: null,
      approvalId: "approval-9",
      status: "granted",
      targetAction: "agent.stop",
      originKind: "gui_message",
      originChatId: "chat-1",
      originRefId: "block-9",
    });
    expect(row.kind).toBe("approval");
    expect(row.approvalId).toBe("approval-9");
    expect(row.status).toBe("granted");
    expect(row.targetAction).toBe("agent.stop");
    // Source traceability rides the existing origin fields.
    expect(row.originRefId).toBe("block-9");
  });

  it("parses a lifecycle row with its per-kind fields populated", () => {
    const row = epicCommunicationGraphEventSchemaV11.parse({
      ...V11_EMPTY_EVENT,
      id: 103,
      kind: "lifecycle",
      senderAgentId: null,
      receiverAgentId: null,
      responseId: null,
      inReplyTo: null,
      expectReply: null,
      messageText: null,
      agentId: "agent-reviewer",
      previousState: "active",
      newState: "stopped",
      trigger: "user",
    });
    expect(row.kind).toBe("lifecycle");
    expect(row.agentId).toBe("agent-reviewer");
    expect(row.previousState).toBe("active");
    expect(row.newState).toBe("stopped");
    expect(row.trigger).toBe("user");
  });

  it("parses a resource_event row with its per-kind fields populated", () => {
    const row = epicCommunicationGraphEventSchemaV11.parse({
      ...V11_EMPTY_EVENT,
      id: 104,
      kind: "resource_event",
      senderAgentId: null,
      receiverAgentId: null,
      responseId: null,
      inReplyTo: null,
      expectReply: null,
      messageText: null,
      hostId: "host-1",
      resourceType: "memory",
      metricValue: 87.4,
      threshold: 80,
      breach: true,
    });
    expect(row.kind).toBe("resource_event");
    expect(row.hostId).toBe("host-1");
    expect(row.resourceType).toBe("memory");
    expect(row.metricValue).toBe(87.4);
    expect(row.threshold).toBe(80);
    expect(row.breach).toBe(true);
  });

  it("still parses a @1.0-shaped row once the @1.1 fields are present as nulls", () => {
    // The upgrade transform's output - the "every @1.0 row is a valid @1.1
    // row" property that makes the minor purely additive at the data level.
    const row = epicCommunicationGraphEventSchemaV11.parse(V11_EMPTY_EVENT);
    expect(row.kind).toBe("a2a_message");
    expect(row.messageText).toBe("Review the protocol contract.");
    expect(row.toolName).toBeNull();
    expect(row.breach).toBeNull();
  });

  it("accepts a status value invented after the minor froze (open string)", () => {
    // Same historical-log argument as `noticeReason`: `status`/`trigger`/
    // `resourceType` annotate a row whose kind already renders, so unknown
    // values degrade to raw strings instead of unreadable rows.
    expect(
      epicCommunicationGraphEventSchemaV11.parse({
        ...V11_EMPTY_EVENT,
        kind: "approval",
        approvalId: "approval-9",
        status: "escalated",
        targetAction: "agent.stop",
      }).status,
    ).toBe("escalated");
  });

  it("requires every @1.1 field, per the required-nullable convention", () => {
    const { toolName: _omittedToolName, ...withoutToolName } = V11_EMPTY_EVENT;
    expect(
      epicCommunicationGraphEventSchemaV11.safeParse(withoutToolName).success,
    ).toBe(false);
  });

  it("keeps the @1.0 schema closed: it still rejects every new kind", () => {
    for (const kind of ["tool_call", "approval", "lifecycle", "resource_event"]) {
      expect(
        epicCommunicationGraphEventSchema.safeParse({
          ...A2A_MESSAGE_EVENT,
          kind,
        }).success,
      ).toBe(false);
    }
  });
});

describe("epic.communicationGraph.subscribe@1.1 frames", () => {
  const V11_TOOL_CALL_EVENT = {
    id: 101,
    kind: "tool_call",
    timestamp: 1_753_000_000_001,
    senderAgentId: "agent-builder",
    receiverAgentId: null,
    responseId: null,
    inReplyTo: null,
    expectReply: null,
    messageText: null,
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    toolName: "read_file",
    toolInput: null,
    durationMs: 312,
    success: true,
    tokenCost: 1542,
    approvalId: null,
    status: null,
    targetAction: null,
    agentId: null,
    previousState: null,
    newState: null,
    trigger: null,
    hostId: null,
    resourceType: null,
    metricValue: null,
    threshold: null,
    breach: null,
  } as const;

  it("parses a snapshot frame carrying a new-kind row", () => {
    const parsed = epicCommunicationGraphSubscribeServerFrameSchemaV11.parse({
      kind: "snapshot",
      epicId: "epic-1",
      events: [V11_TOOL_CALL_EVENT],
      headId: V11_TOOL_CALL_EVENT.id,
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind === "snapshot") {
      expect(parsed.events[0].kind).toBe("tool_call");
      expect(parsed.events[0].toolName).toBe("read_file");
    }
  });

  it("parses an event frame carrying a new-kind row", () => {
    const parsed = epicCommunicationGraphSubscribeServerFrameSchemaV11.parse({
      kind: "event",
      epicId: "epic-1",
      event: V11_TOOL_CALL_EVENT,
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") {
      expect(parsed.event.kind).toBe("tool_call");
    }
  });

  it("reuses the @1.0 open request and client frames verbatim", () => {
    expect(epicCommunicationGraphSubscribeV11.openRequestSchema).toBe(
      epicCommunicationGraphSubscribeOpenRequestSchema,
    );
    expect(epicCommunicationGraphSubscribeV11.clientFrameSchema).toBe(
      epicCommunicationGraphSubscribeClientFrameSchema,
    );
  });
});

describe("epic.communicationGraph.subscribe@1.0 ↔ @1.1 row transforms", () => {
  it("upgrades a @1.0 row to @1.1 by filling the new fields with null", () => {
    const upgraded = upgradeEpicCommunicationGraphEventV10ToV11(
      epicCommunicationGraphEventSchema.parse(A2A_MESSAGE_EVENT),
    );

    expect(epicCommunicationGraphEventSchemaV11.parse(upgraded).kind).toBe(
      "a2a_message",
    );
    expect(upgraded.id).toBe(A2A_MESSAGE_EVENT.id);
    expect(upgraded.messageText).toBe("Review the protocol contract.");
    expect(upgraded.toolName).toBeNull();
    expect(upgraded.breach).toBeNull();
  });

  it("downgrades a representable @1.1 row by stripping the @1.1 fields", () => {
    const upgraded = upgradeEpicCommunicationGraphEventV10ToV11(
      epicCommunicationGraphEventSchema.parse(A2A_MESSAGE_EVENT),
    );
    const result = downgradeEpicCommunicationGraphEventV11ToV10(upgraded);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Stripped shape parses under the FROZEN @1.0 schema.
      expect(epicCommunicationGraphEventSchema.parse(result.value).kind).toBe(
        "a2a_message",
      );
      expect(result.value).not.toHaveProperty("toolName");
      expect(result.value).not.toHaveProperty("breach");
      expect(result.value.id).toBe(A2A_MESSAGE_EVENT.id);
    }
  });

  it("refuses to downgrade a new-kind row: the @1.0 peer must SKIP it", () => {
    const toolCall = epicCommunicationGraphEventSchemaV11.parse({
      id: 101,
      kind: "tool_call",
      timestamp: 1_753_000_000_001,
      senderAgentId: "agent-builder",
      receiverAgentId: null,
      responseId: null,
      inReplyTo: null,
      expectReply: null,
      messageText: null,
      noticeReason: null,
      originKind: null,
      originChatId: null,
      originRefId: null,
      toolName: "read_file",
      toolInput: null,
      durationMs: 312,
      success: true,
      tokenCost: 1542,
      approvalId: null,
      status: null,
      targetAction: null,
      agentId: null,
      previousState: null,
      newState: null,
      trigger: null,
      hostId: null,
      resourceType: null,
      metricValue: null,
      threshold: null,
      breach: null,
    });

    const result = downgradeEpicCommunicationGraphEventV11ToV10(toolCall);
    expect(result).toEqual({ ok: false, reason: "unrepresentable-kind" });
  });
});

describe("epic.communicationGraph.subscribe@1.1 negotiated-minor compat", () => {
  it("keeps a @1.0 peer compatible: the @1.0 minor stays installed", () => {
    // The host's registry manifests 1.1; a client whose manifest still says
    // 1.0 must connect. The host serves it resolver-projected @1.0 frames
    // (streams have no bridges - compat is installed-minor negotiation).
    const hostManifest = buildStreamManifest(hostStreamRpcRegistry);
    const clientManifest = { ...hostManifest, [METHOD]: { major: 1, minor: 0 } };

    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        hostManifest,
        clientManifest,
        "host",
        METHOD,
      ).ok,
    ).toBe(true);
  });

  it("skips new-kind rows for a @1.0 peer instead of failing the stream", () => {
    // The resolver's projection path: for every stored row it consults the
    // downgrade; `unrepresentable-kind` means skip (cursor advances, nothing
    // is held back) - exactly the representability policy's contract.
    const newKindEvent = epicCommunicationGraphEventSchemaV11.parse({
      id: 101,
      kind: "resource_event",
      timestamp: 1_753_000_000_001,
      senderAgentId: null,
      receiverAgentId: null,
      responseId: null,
      inReplyTo: null,
      expectReply: null,
      messageText: null,
      noticeReason: null,
      originKind: null,
      originChatId: null,
      originRefId: null,
      toolName: null,
      toolInput: null,
      durationMs: null,
      success: null,
      tokenCost: null,
      approvalId: null,
      status: null,
      targetAction: null,
      agentId: null,
      previousState: null,
      newState: null,
      trigger: null,
      hostId: "host-1",
      resourceType: "cpu",
      metricValue: 92,
      threshold: 90,
      breach: true,
    });

    const result = downgradeEpicCommunicationGraphEventV11ToV10(newKindEvent);
    expect(result).toEqual({ ok: false, reason: "unrepresentable-kind" });
  });
});

describe("epic.communicationGraph.subscribe@1.0 degrades against an older host", () => {
  it("fails only this method's subscribe, leaving every other stream method compatible", () => {
    const currentManifest = buildStreamManifest(hostStreamRpcRegistry);
    // A host that predates the method simply omits it from its manifest.
    const olderHostManifest = Object.fromEntries(
      Object.entries(currentManifest).filter(([method]) => method !== METHOD),
    );

    const commGraph = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      currentManifest,
      olderHostManifest,
      "client",
      METHOD,
    );
    expect(commGraph.ok).toBe(false);
    if (!commGraph.ok) {
      // The client turns this into `onMethodSupport(method, "unsupported")`
      // and the tile renders that host's agents without edge data.
      expect(commGraph.details.incompatibleMethods).toEqual([
        expect.objectContaining({ method: METHOD }),
      ]);
    }

    for (const method of ["epic.subscribe", "chat.subscribe"]) {
      expect(
        checkStreamMethodCompatibility(
          hostStreamRpcRegistry,
          currentManifest,
          olderHostManifest,
          "client",
          method,
        ).ok,
      ).toBe(true);
    }
  });
});
