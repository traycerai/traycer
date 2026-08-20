import { describe, expect, it } from "vitest";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  epicCommunicationGraphEventSchema,
  epicCommunicationGraphEventSchemaV10,
  epicCommunicationGraphSubscribeClientFrameSchema,
  epicCommunicationGraphSubscribeOpenRequestSchema,
  epicCommunicationGraphSubscribeServerFrameSchema,
  epicCommunicationGraphSubscribeV10,
  epicCommunicationGraphSubscribeV11,
} from "@traycer/protocol/host/epic/communication-graph";

/**
 * `epic.communicationGraph.subscribe@1.0` contract fixtures + the
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

describe("epic.communicationGraph.subscribe@1.0 contract", () => {
  it("declares the method at 1.0 and registers it in the stream registry", () => {
    expect(epicCommunicationGraphSubscribeV10.method).toBe(METHOD);
    expect(epicCommunicationGraphSubscribeV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
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

  it("accepts host_agent_verb on the 1.1 schema and rejects it on frozen 1.0", () => {
    const verb = {
      ...A2A_MESSAGE_EVENT,
      kind: "host_agent_verb",
      originKind: "remote_host",
      originRefId: "origin-host-1",
    };
    expect(epicCommunicationGraphEventSchema.safeParse(verb).success).toBe(
      true,
    );
    expect(epicCommunicationGraphEventSchemaV10.safeParse(verb).success).toBe(
      false,
    );
    expect(epicCommunicationGraphSubscribeV11.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
    expect(epicCommunicationGraphSubscribeV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
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
