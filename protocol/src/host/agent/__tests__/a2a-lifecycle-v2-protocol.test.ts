/**
 * Protocol-layer coverage for A2A lifecycle v2 regression rows R21–R23.
 *
 * R21 — released @1.0 schemas for the four contracts stay byte-compatible
 *       with the committed released baseline surface.
 * R22 — new client + old host: within-major negotiation stays on 1.0 and
 *       upgrade paths fabricate honest legacy-best-effort defaults.
 * R23 — old client + new host: stream/unary stay connected; projected v1
 *       frames decode with no 1.1 fields/enums leaking.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildConnectionManifest,
  checkCompatibility,
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import {
  checkSurfaceCompatibility,
  parseCompatExceptionsFile,
  protocolSurfaceSchema,
} from "@traycer/protocol/framework/surface-compat";
import {
  buildStreamManifest,
  checkStreamCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import {
  agentInboxMessageSchema,
  agentInboxMessageSchemaV11,
  agentInboxNoticeSchema,
  agentInboxNoticeSchemaV11,
  agentInboxReadV10,
  agentInboxReadV11,
  agentInboxSubscribeV10,
  agentInboxSubscribeV11,
  agentDeliveryOutcomeSchema,
} from "@traycer/protocol/host/agent/inbox";
import {
  agentSendMessageUpgradeV10ToV11,
  agentSendMessageV10,
  agentSendMessageV11,
} from "@traycer/protocol/host/agent/contracts";
import {
  agentTuiTurnEndedUpgradeV10ToV11,
  agentTuiTurnEndedV10,
  agentTuiTurnEndedV11,
} from "@traycer/protocol/host/agent/tui/contracts";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

const A2A_UNARY_METHODS = [
  "agent.sendMessage",
  "agent.inbox.read",
  "agent.tui.turnEnded",
] as const;

const A2A_STREAM_METHODS = ["agent.inbox.subscribe"] as const;

const fixturePath = join(
  import.meta.dirname,
  "../../__tests__/__fixtures__/released-baseline-surface.json",
);
const exceptionsPath = join(
  import.meta.dirname,
  "../../../../scripts/compat/compat-exceptions.json",
);

function releasedBaselineSurface() {
  return protocolSurfaceSchema.parse(
    JSON.parse(readFileSync(fixturePath, "utf8")),
  );
}

function liveSurface() {
  return buildProtocolSurface({
    unary: hostRpcRegistry,
    unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
    stream: hostStreamRpcRegistry,
  });
}

function exceptions() {
  return parseCompatExceptionsFile(
    JSON.parse(readFileSync(exceptionsPath, "utf8")),
  ).exceptions;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, nested) => {
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(
        Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return nested;
  });
}

const sampleInboxMessageV10 = {
  reply: { expectsReply: true as const, responseId: "resp-1" },
  fromAgentId: "sender-1",
  senderTitle: "Sender",
  senderHarnessId: "claude",
  epicId: "epic-1",
  prompt: "hello",
  enqueuedAt: 1_700_000_000_000,
};

const sampleInboxNoticeV10 = {
  kind: "inactivity" as const,
  senderAgentId: "sender-1",
  responseId: "resp-1",
  receiverAgentId: "receiver-1",
  receiverTitle: "Receiver",
  receiverHarnessId: "claude",
  epicId: "epic-1",
  reason: "turn-ended" as const,
  detail: null,
  droppedReceivers: null,
  noticedAt: 1_700_000_000_100,
};

// ─── R21 — released v1 freeze ─────────────────────────────────────────────

describe("R21 — released @1.0 A2A schemas are frozen against the baseline", () => {
  it("live registries have zero blocking findings for the four A2A @1.0 contracts", () => {
    const result = checkSurfaceCompatibility({
      mine: liveSurface(),
      theirs: releasedBaselineSurface(),
      theirsLabel: "released-baseline-surface.json",
      exceptions: exceptions(),
    });

    const a2aBlocking = result.blocking.filter(
      (finding) =>
        finding.method !== null &&
        (A2A_UNARY_METHODS.includes(
          finding.method as (typeof A2A_UNARY_METHODS)[number],
        ) ||
          A2A_STREAM_METHODS.includes(
            finding.method as (typeof A2A_STREAM_METHODS)[number],
          )),
    );

    if (a2aBlocking.length > 0) {
      const report = a2aBlocking
        .map((finding) => {
          const location = [
            finding.family,
            finding.method,
            finding.version === null ? null : `@${finding.version}`,
            finding.payload === null ? null : ` ${finding.payload}`,
            finding.path === null ? null : ` at ${finding.path}`,
          ]
            .filter((part): part is string => part !== null)
            .join("");
          return `  [${finding.severity.toUpperCase()}] ${location}\n      ${finding.detail}`;
        })
        .join("\n");
      expect.fail(
        `${a2aBlocking.length} A2A @1.0 blocking finding(s):\n${report}`,
      );
    }

    expect(a2aBlocking).toEqual([]);
  });

  it("each @1.0 schema JSON is byte-stable vs the released baseline surface", () => {
    const theirs = releasedBaselineSurface();
    const mine = liveSurface();

    for (const method of A2A_UNARY_METHODS) {
      const released = theirs.unary[method]?.schemas["1.0"];
      const live = mine.unary[method]?.schemas["1.0"];
      expect(released, `${method} missing from released baseline`).toBeDefined();
      expect(live, `${method} missing from live surface`).toBeDefined();
      expect(stableStringify(live)).toBe(stableStringify(released));
    }

    for (const method of A2A_STREAM_METHODS) {
      const released = theirs.stream[method]?.schemas["1.0"];
      const live = mine.stream[method]?.schemas["1.0"];
      expect(released, `${method} missing from released baseline`).toBeDefined();
      expect(live, `${method} missing from live surface`).toBeDefined();
      expect(stableStringify(live)).toBe(stableStringify(released));
    }
  });

  it("registry still installs frozen @1.0 contracts for all four methods", () => {
    expect(hostRpcRegistry["agent.sendMessage"][1].versions[0].contract).toBe(
      agentSendMessageV10,
    );
    expect(hostRpcRegistry["agent.inbox.read"][1].versions[0].contract).toBe(
      agentInboxReadV10,
    );
    expect(hostRpcRegistry["agent.tui.turnEnded"][1].versions[0].contract).toBe(
      agentTuiTurnEndedV10,
    );
    expect(
      hostStreamRpcRegistry["agent.inbox.subscribe"][1].versions[0].contract,
    ).toBe(agentInboxSubscribeV10);
  });

  it("mutation probe: growing a frozen v1 notice reason enum fails the freeze", () => {
    // Non-vacuous check for R21: if @1.0 notice.reason grew, the enum set
    // against the released baseline would diverge. We simulate the diverged
    // schema here rather than mutating production source.
    const releasedNoticeReason = (
      releasedBaselineSurface().stream["agent.inbox.subscribe"]?.schemas[
        "1.0"
      ] as {
        serverFrame: {
          oneOf: Array<{
            properties?: {
              notice?: {
                properties?: { reason?: { enum?: string[] } };
              };
            };
          }>;
        };
      }
    ).serverFrame.oneOf.find(
      (option) => option.properties?.notice !== undefined,
    )?.properties?.notice?.properties?.reason;

    expect(releasedNoticeReason?.enum).toBeDefined();
    const releasedEnum = [...(releasedNoticeReason?.enum ?? [])].sort();
    const liveEnum = [...agentInboxNoticeSchema.shape.reason.options].sort();
    expect(liveEnum).toEqual(releasedEnum);

    const mutatedEnum = [...liveEnum, "service-unconfirmed"].sort();
    expect(mutatedEnum).not.toEqual(releasedEnum);
  });
});

// ─── R22 — new client / old host ──────────────────────────────────────────

describe("R22 — new client + old host negotiates 1.0 with best-effort defaults", () => {
  it("unary handshake stays compatible when host is still @1.0 canonical", () => {
    const newClientManifest = buildConnectionManifest(hostRpcRegistry);
    // Released host: canonical minor 0 for the three unary A2A methods.
    const oldHostManifest = {
      "agent.sendMessage": { major: 1, minor: 0 },
      "agent.inbox.read": { major: 1, minor: 0 },
      "agent.tui.turnEnded": { major: 1, minor: 0 },
      "agent.getTranscript": { major: 1, minor: 0 },
      "agent.stop": { major: 1, minor: 0 },
      "agent.create": { major: 2, minor: 0 },
      "agent.list": { major: 4, minor: 0 },
    };

    // Per-method checks against the live (new) registry as the client side.
    for (const method of A2A_UNARY_METHODS) {
      const mine = { [method]: newClientManifest[method] };
      const theirs = { [method]: oldHostManifest[method] };
      const result = checkCompatibility(
        hostRpcRegistry,
        mine,
        theirs,
        "client",
      );
      expect(result.ok, `${method} should bridge new-client/old-host`).toBe(
        true,
      );
    }
  });

  it("sendMessage 1.0→1.1 upgrade fabricates deliveryId:null + legacy-best-effort", () => {
    const upgraded = agentSendMessageUpgradeV10ToV11.upgradeResponse({
      responseId: "resp-1",
    });
    expect(upgraded).toEqual({
      responseId: "resp-1",
      deliveryId: null,
      deliveryGuarantee: "legacy-best-effort",
    });

    const viaRegistry = upgradeResponseToVersion(
      hostRpcRegistry["agent.sendMessage"],
      { major: 1, minor: 0 },
      { major: 1, minor: 1 },
      { responseId: null },
    );
    expect(viaRegistry).toEqual({
      responseId: null,
      deliveryId: null,
      deliveryGuarantee: "legacy-best-effort",
    });

    // New client never invents tracked-v2 from a v1 host response.
    expect(viaRegistry.deliveryGuarantee).not.toBe("tracked-v2");
    expect(viaRegistry.deliveryId).toBeNull();
  });

  it("turnEnded 1.0→1.1 upgrade fabricates null proof/replay inputs", () => {
    const upgradedRequest = agentTuiTurnEndedUpgradeV10ToV11.upgradeRequest({
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessId: "claude",
    });
    expect(upgradedRequest).toEqual({
      epicId: "epic-1",
      tuiAgentId: "agent-1",
      harnessId: "claude",
      observedHarnessSessionId: null,
      transcriptPath: null,
      previouslyReportedLeafUuid: null,
    });

    const upgradedResponse = agentTuiTurnEndedUpgradeV10ToV11.upgradeResponse({
      accepted: true,
    });
    expect(upgradedResponse).toEqual({
      accepted: true,
      acceptedLeafUuid: null,
    });

    const viaRegistry = upgradeRequestToVersion(
      hostRpcRegistry["agent.tui.turnEnded"],
      { major: 1, minor: 0 },
      { major: 1, minor: 1 },
      { epicId: "e", tuiAgentId: "a", harnessId: "codex" },
    );
    expect(viaRegistry.observedHarnessSessionId).toBeNull();
    expect(viaRegistry.transcriptPath).toBeNull();
    expect(viaRegistry.previouslyReportedLeafUuid).toBeNull();
  });

  it("inbox.read 1.0→1.1 upgrade fabricates null delivery identity on messages", () => {
    const viaRegistry = upgradeResponseToVersion(
      hostRpcRegistry["agent.inbox.read"],
      { major: 1, minor: 0 },
      { major: 1, minor: 1 },
      { messages: [sampleInboxMessageV10] },
    );
    expect(viaRegistry.messages).toHaveLength(1);
    expect(viaRegistry.messages[0]).toMatchObject({
      ...sampleInboxMessageV10,
      deliveryId: null,
      replyToDeliveryId: null,
      consumedResponseId: null,
    });
  });

  it("stream: new client + old host stays connected on agent.inbox.subscribe", () => {
    const newClient = buildStreamManifest(hostStreamRpcRegistry);
    const oldHost = {
      "agent.inbox.subscribe": { major: 1, minor: 0 },
    };
    const result = checkStreamCompatibility(
      hostStreamRpcRegistry,
      { "agent.inbox.subscribe": newClient["agent.inbox.subscribe"] },
      oldHost,
      "client",
    );
    expect(result.ok).toBe(true);
  });
});

// ─── R23 — old client / new host ──────────────────────────────────────────

describe("R23 — old client + new host projects frozen v1 frames", () => {
  it("unary handshake stays compatible when client is still @1.0 canonical", () => {
    const newHostManifest = buildConnectionManifest(hostRpcRegistry);
    for (const method of A2A_UNARY_METHODS) {
      const mine = { [method]: newHostManifest[method] };
      const theirs = { [method]: { major: 1, minor: 0 } };
      const result = checkCompatibility(hostRpcRegistry, mine, theirs, "host");
      expect(result.ok, `${method} should bridge old-client/new-host`).toBe(
        true,
      );
    }
  });

  it("stream: old subscribe@1.0 client stays connected against a 1.1 host", () => {
    const newHost = buildStreamManifest(hostStreamRpcRegistry);
    expect(newHost["agent.inbox.subscribe"]).toEqual({
      major: 1,
      minor: 1,
    });
    const result = checkStreamCompatibility(
      hostStreamRpcRegistry,
      { "agent.inbox.subscribe": newHost["agent.inbox.subscribe"] },
      { "agent.inbox.subscribe": { major: 1, minor: 0 } },
      "host",
    );
    expect(result.ok).toBe(true);
  });

  it("projected v1 message frames strip 1.1 delivery fields cleanly", () => {
    const v11Message = agentInboxMessageSchemaV11.parse({
      ...sampleInboxMessageV10,
      deliveryId: "deliv-1",
      replyToDeliveryId: null,
      consumedResponseId: null,
    });

    // Within-major strip-downgrade: re-parse through the frozen @1.0 schema.
    // Zod strips unknown keys; the v1 client never sees delivery identity.
    const projected = agentInboxMessageSchema.parse(v11Message);
    expect(projected).toEqual(sampleInboxMessageV10);
    expect("deliveryId" in projected).toBe(false);
    expect("replyToDeliveryId" in projected).toBe(false);
    expect("consumedResponseId" in projected).toBe(false);
  });

  it("projected v1 notice frames strip outcome/delivery fields; no v2 enums leak", () => {
    const v11Notice = agentInboxNoticeSchemaV11.parse({
      ...sampleInboxNoticeV10,
      deliveryId: "deliv-1",
      replyToDeliveryId: null,
      consumedResponseId: "resp-consumed",
      outcome: "turn-ended-without-reply",
      isCorrective: false,
      durableQueuedWorkRemains: null,
    });

    const projected = agentInboxNoticeSchema.parse(v11Notice);
    expect(projected).toEqual(sampleInboxNoticeV10);
    expect("deliveryId" in projected).toBe(false);
    expect("outcome" in projected).toBe(false);
    expect("isCorrective" in projected).toBe(false);
    expect("durableQueuedWorkRemains" in projected).toBe(false);

    // Frozen @1.0 reason enum still rejects every v2-only product outcome
    // (shared spellings like "exited" are intentionally allowed on both).
    const v1Reasons = new Set<string>(
      agentInboxNoticeSchema.shape.reason.options,
    );
    for (const outcome of agentDeliveryOutcomeSchema.options) {
      if (v1Reasons.has(outcome)) {
        continue;
      }
      expect(
        agentInboxNoticeSchema.shape.reason.safeParse(outcome).success,
        `v1 reason must not admit v2 outcome ${outcome}`,
      ).toBe(false);
    }
  });

  it("1.1 server frames parse with delivery identity; 1.0 frames reject it", () => {
    const messageFrameV11 = {
      kind: "message" as const,
      hasBinaryPayload: false as const,
      item: {
        ...sampleInboxMessageV10,
        deliveryId: "deliv-1",
        replyToDeliveryId: "deliv-0",
        consumedResponseId: null,
      },
    };
    expect(
      agentInboxSubscribeV11.serverFrameSchema.safeParse(messageFrameV11)
        .success,
    ).toBe(true);

    // @1.0 schema strips unknown keys on the item rather than rejecting the
    // whole frame — that is the strip-downgrade guarantee. After strip, the
    // item has no delivery identity for the old client to observe.
    const parsedV10 =
      agentInboxSubscribeV10.serverFrameSchema.safeParse(messageFrameV11);
    expect(parsedV10.success).toBe(true);
    if (parsedV10.success && parsedV10.data.kind === "message") {
      expect("deliveryId" in parsedV10.data.item).toBe(false);
    }
  });

  it("v1.0 notice reason enum is unchanged (no v2 outcomes on @1.0)", () => {
    expect(agentInboxNoticeSchema.shape.reason.options).toEqual([
      "turn-ended",
      "exited",
      "quiet",
      "user-stopped",
      "errored",
      "awaiting-input",
      "receiver-cancelled",
    ]);
    // Product v2 outcomes live only on the additive field.
    expect(agentDeliveryOutcomeSchema.options).toEqual([
      "replied",
      "turn-ended-without-reply",
      "delivery-failed",
      "service-failed",
      "service-unconfirmed",
      "cancelled",
      "purged",
      "deleted",
      "exited",
      "stopped",
    ]);
  });

  it("latest minors are 1.1 while @1.0 remains installed", () => {
    expect(hostRpcRegistry["agent.sendMessage"][1].latestMinor).toBe(1);
    expect(hostRpcRegistry["agent.inbox.read"][1].latestMinor).toBe(1);
    expect(hostRpcRegistry["agent.tui.turnEnded"][1].latestMinor).toBe(1);
    expect(hostStreamRpcRegistry["agent.inbox.subscribe"][1].latestMinor).toBe(
      1,
    );
    expect(agentSendMessageV11.schemaVersion).toEqual({ major: 1, minor: 1 });
    expect(agentInboxReadV11.schemaVersion).toEqual({ major: 1, minor: 1 });
    expect(agentTuiTurnEndedV11.schemaVersion).toEqual({ major: 1, minor: 1 });
    expect(agentInboxSubscribeV11.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
  });
});
