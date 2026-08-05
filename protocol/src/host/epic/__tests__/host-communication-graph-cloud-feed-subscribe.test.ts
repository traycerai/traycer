import { describe, expect, it } from "vitest";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  hostCommunicationGraphCloudFeedEventSchema,
  hostCommunicationGraphCloudFeedSubscribeClientFrameSchemaV10,
  hostCommunicationGraphCloudFeedSubscribeOpenRequestSchemaV10,
  hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10,
  hostCommunicationGraphCloudFeedSubscribeV10,
} from "@traycer/protocol/host/epic/communication-graph";

/**
 * `host.communicationGraph.subscribe@1.0` contract fixtures + the
 * optional-method degrade guard.
 *
 * Unlike `host.notifications.cloudFeed.subscribe` (whole-snapshot), this
 * contract is cursor/resume-based like `epic.communicationGraph.subscribe` -
 * these fixtures pin the compound cloud cursor shape, the
 * never-a-bootstrap-reset framing, and the `connectionState: "reconnecting"`
 * degrade frame this contract additionally carries over the local one.
 */

const METHOD = "host.communicationGraph.subscribe";

const CLOUD_EVENT = {
  eventId: "0195a1f0-0001-7000-8000-00000000000a",
  originHostId: "host-1",
  originSequence: 41,
  ingestVersion: 100,
  kind: "a2a_message",
  capturedAt: 1_753_000_000_000,
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
  historicalUpload: false,
} as const;

describe("host.communicationGraph.subscribe@1.0 contract", () => {
  it("declares the method at 1.0 and registers it in the stream registry", () => {
    expect(hostCommunicationGraphCloudFeedSubscribeV10.method).toBe(METHOD);
    expect(hostCommunicationGraphCloudFeedSubscribeV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(buildStreamManifest(hostStreamRpcRegistry)[METHOD]).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("stays out of the unary released floor", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(METHOD);
  });

  it("requires an explicit resume cursor on the open request", () => {
    expect(
      hostCommunicationGraphCloudFeedSubscribeOpenRequestSchemaV10.parse({
        epicId: "epic-1",
        sinceCursor: null,
      }).sinceCursor,
    ).toBeNull();
    expect(
      hostCommunicationGraphCloudFeedSubscribeOpenRequestSchemaV10.parse({
        epicId: "epic-1",
        sinceCursor: { ingestVersion: 99, eventId: CLOUD_EVENT.eventId },
      }).sinceCursor,
    ).toEqual({ ingestVersion: 99, eventId: CLOUD_EVENT.eventId });
    expect(
      hostCommunicationGraphCloudFeedSubscribeOpenRequestSchemaV10.safeParse({
        epicId: "epic-1",
      }).success,
    ).toBe(false);
  });
});

describe("host.communicationGraph.subscribe@1.0 frames", () => {
  it("carries only the host-authoritative cloud availability confirmation", () => {
    expect(
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10.parse({
        kind: "availability",
        availability: "available",
        hasBinaryPayload: false,
      }),
    ).toEqual({
      kind: "availability",
      availability: "available",
      hasBinaryPayload: false,
    });
    expect(
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10.safeParse({
        kind: "availability",
        availability: "unavailable",
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
  });

  it("parses a snapshot frame carrying a non-negative headVersion, never null", () => {
    const parsed =
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10.parse({
        kind: "snapshot",
        epicId: "epic-1",
        events: [CLOUD_EVENT],
        headVersion: 100,
        hasBinaryPayload: false,
      });
    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind === "snapshot") {
      expect(parsed.events).toHaveLength(1);
      expect(parsed.headVersion).toBe(100);
    }
  });

  it("parses an empty snapshot frame with headVersion 0 (nothing ingested yet)", () => {
    const parsed =
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10.parse({
        kind: "snapshot",
        epicId: "epic-1",
        events: [],
        headVersion: 0,
        hasBinaryPayload: false,
      });
    expect(parsed.kind === "snapshot" && parsed.events).toEqual([]);
    expect(parsed.kind === "snapshot" && parsed.headVersion).toBe(0);
  });

  it("reserves an optional deletion frontier without changing absent frames", () => {
    const withoutFrontier = {
      kind: "snapshot",
      epicId: "epic-1",
      events: [CLOUD_EVENT],
      headVersion: 100,
      hasBinaryPayload: false,
    } as const;
    expect(
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10.parse(
        withoutFrontier,
      ),
    ).toEqual(withoutFrontier);
    expect(
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10.parse({
        ...withoutFrontier,
        frontier: 75,
      }),
    ).toEqual({ ...withoutFrontier, frontier: 75 });
  });

  it("rejects a null headVersion - the cloud counter always reports a number", () => {
    expect(
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10.safeParse({
        kind: "snapshot",
        epicId: "epic-1",
        events: [],
        headVersion: null,
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
  });

  it("parses an event frame carrying historicalUpload", () => {
    const parsed =
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10.parse({
        kind: "event",
        epicId: "epic-1",
        event: { ...CLOUD_EVENT, historicalUpload: true },
        hasBinaryPayload: false,
      });
    expect(parsed.kind === "event" && parsed.event.historicalUpload).toBe(true);
  });

  it("parses explicit caught-up progress beyond skipped wire rows", () => {
    const parsed =
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10.parse({
        kind: "caughtUp",
        epicId: "epic-1",
        headVersion: 101,
        cursor: { ingestVersion: 101, eventId: "skipped-row" },
        hasBinaryPayload: false,
      });
    expect(parsed).toMatchObject({
      kind: "caughtUp",
      headVersion: 101,
      cursor: { ingestVersion: 101, eventId: "skipped-row" },
    });
  });

  it("parses the connectionState: reconnecting degrade frame", () => {
    const parsed =
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10.parse({
        kind: "connectionState",
        connectionState: "reconnecting",
        hasBinaryPayload: false,
      });
    expect(parsed.kind).toBe("connectionState");
  });

  it("parses the heartbeat frames", () => {
    expect(
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10.parse({
        kind: "pong",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("pong");
    expect(
      hostCommunicationGraphCloudFeedSubscribeClientFrameSchemaV10.parse({
        kind: "ping",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("ping");
  });

  it("rejects an unknown event kind (skip-not-surface representability policy)", () => {
    expect(
      hostCommunicationGraphCloudFeedEventSchema.safeParse({
        ...CLOUD_EVENT,
        kind: "artifact_write",
      }).success,
    ).toBe(false);
  });

  it("accepts a notice reason the closed broker enum does not carry", () => {
    expect(
      hostCommunicationGraphCloudFeedEventSchema.parse({
        ...CLOUD_EVENT,
        kind: "a2a_notice",
        noticeReason: "some-reason-invented-after-1.0-froze",
      }).noticeReason,
    ).toBe("some-reason-invented-after-1.0-froze");
  });
});

describe("host.communicationGraph.subscribe@1.0 degrades against an older host", () => {
  it("fails only this method's subscribe, leaving every other stream method compatible", () => {
    const currentManifest = buildStreamManifest(hostStreamRpcRegistry);
    const olderHostManifest = Object.fromEntries(
      Object.entries(currentManifest).filter(([method]) => method !== METHOD),
    );

    const cloudFeed = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      currentManifest,
      olderHostManifest,
      "client",
      METHOD,
    );
    expect(cloudFeed.ok).toBe(false);
    if (!cloudFeed.ok) {
      expect(cloudFeed.details.incompatibleMethods).toEqual([
        expect.objectContaining({ method: METHOD }),
      ]);
    }

    for (const method of [
      "epic.communicationGraph.subscribe",
      "epic.subscribe",
      "chat.subscribe",
    ]) {
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
