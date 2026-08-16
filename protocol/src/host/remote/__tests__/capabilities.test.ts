import { describe, expect, it } from "vitest";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  hostRemoteCapabilitiesSubscribeV10,
  remoteCapabilitiesSubscribeClientFrameSchema,
  remoteCapabilitiesSubscribeOpenRequestSchema,
  remoteCapabilitiesSubscribeServerFrameSchema,
  remoteCapabilitySchema,
} from "@traycer/protocol/host/remote/capabilities";

/**
 * `host.remote.capabilities.subscribe@1.0` contract fixtures + the
 * optional-method degrade guard.
 *
 * The degrade case is the load-bearing one, exactly as for
 * `epic.communicationGraph.subscribe`: this method ships AFTER host-v1.0.0,
 * so a host in the field may not advertise it at all. Stream compatibility
 * is evaluated per method at subscribe time, so a missing method is a
 * per-feature "capabilities unknown" degrade, never a handshake failure.
 *
 * On the frames: `snapshot` is the one authoritative REPLACE-WHOLE baseline
 * emitted on open; `update` carries the FULL capability (never a patch), and
 * every frame is text-only (`hasBinaryPayload: false`).
 */

const METHOD = "host.remote.capabilities.subscribe";

const REMOTE_CAPABILITY = {
  hostId: "host-remote-1",
  version: "1.4.2",
  supportedStreamMethods: [
    "epic.communicationGraph.subscribe@1.0@1",
    "host.remote.capabilities.subscribe@1.0@0",
  ],
  supportedUnaryMethods: ["agent.list@1.0@0", "epic.listTasks@1.1@0"],
  persistenceType: "sqlite",
  harnesses: ["claude", "codex"],
  features: ["durable-inbox", "policy-eval"],
} as const;

describe("host.remote.capabilities.subscribe contract identity", () => {
  it("defines the method at schema version 1.0 and advertises it", () => {
    expect(hostRemoteCapabilitiesSubscribeV10.method).toBe(METHOD);
    expect(hostRemoteCapabilitiesSubscribeV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(buildStreamManifest(hostStreamRpcRegistry)[METHOD]).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("stays out of the unary released floor", () => {
    // The floor is fail-closed on the method-name set; an entry there would
    // make every RPC fail against a peer that predates this method.
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(METHOD);
  });
});

describe("remoteCapabilitySchema", () => {
  it("parses a full sample capability", () => {
    const parsed = remoteCapabilitySchema.parse(REMOTE_CAPABILITY);

    expect(parsed.hostId).toBe("host-remote-1");
    expect(parsed.version).toBe("1.4.2");
    expect(parsed.supportedStreamMethods).toContain(
      "epic.communicationGraph.subscribe@1.0@1",
    );
    expect(parsed.supportedUnaryMethods).toContain("agent.list@1.0@0");
    expect(parsed.persistenceType).toBe("sqlite");
    expect(parsed.harnesses).toEqual(["claude", "codex"]);
    expect(parsed.features).toEqual(["durable-inbox", "policy-eval"]);
  });

  it("rejects an unknown persistenceType", () => {
    expect(
      remoteCapabilitySchema.safeParse({
        ...REMOTE_CAPABILITY,
        persistenceType: "postgres",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing hostId", () => {
    const { hostId: _omittedHostId, ...withoutHostId } = REMOTE_CAPABILITY;
    expect(
      remoteCapabilitySchema.safeParse(withoutHostId).success,
    ).toBe(false);
  });

  it("accepts capability values invented after the minor froze (open lists)", () => {
    // The lists are open strings so a NEWER remote host's values still parse;
    // an unknown entry degrades to "not supported", never an unreadable frame.
    const parsed = remoteCapabilitySchema.parse({
      ...REMOTE_CAPABILITY,
      supportedStreamMethods: [
        "some.futureMethod.subscribe@1.0@0",
      ],
      harnesses: ["future-harness"],
      features: ["future-feature"],
    });

    expect(parsed.supportedStreamMethods[0]).toBe(
      "some.futureMethod.subscribe@1.0@0",
    );
    expect(parsed.harnesses).toEqual(["future-harness"]);
    expect(parsed.features).toEqual(["future-feature"]);
  });
});

describe("host.remote.capabilities.subscribe open request", () => {
  it("parses an open request naming the remote host", () => {
    const parsed = remoteCapabilitiesSubscribeOpenRequestSchema.parse({
      hostId: "host-remote-1",
    });

    expect(parsed.hostId).toBe("host-remote-1");
  });

  it("rejects an open request without a hostId", () => {
    expect(
      remoteCapabilitiesSubscribeOpenRequestSchema.safeParse({}).success,
    ).toBe(false);
  });

  it("rejects an empty hostId", () => {
    expect(
      remoteCapabilitiesSubscribeOpenRequestSchema.safeParse({
        hostId: "",
      }).success,
    ).toBe(false);
  });
});

describe("host.remote.capabilities.subscribe server frames", () => {
  it("parses the initial snapshot frame (REPLACE-WHOLE baseline)", () => {
    const parsed = remoteCapabilitiesSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      capability: REMOTE_CAPABILITY,
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind === "snapshot") {
      expect(parsed.capability.hostId).toBe("host-remote-1");
      expect(parsed.capability.persistenceType).toBe("sqlite");
    }
  });

  it("parses an update frame carrying the FULL capability, not a patch", () => {
    const parsed = remoteCapabilitiesSubscribeServerFrameSchema.parse({
      kind: "update",
      capability: {
        ...REMOTE_CAPABILITY,
        version: "1.5.0",
        features: ["durable-inbox", "policy-eval", "remote-sessions"],
      },
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("update");
    if (parsed.kind === "update") {
      // Replace-wholesale: every field is present on the frame, so a consumer
      // never patches field-wise.
      expect(parsed.capability.version).toBe("1.5.0");
      expect(parsed.capability.hostId).toBe("host-remote-1");
      expect(parsed.capability.features).toEqual([
        "durable-inbox",
        "policy-eval",
        "remote-sessions",
      ]);
    }
  });

  it("parses the heartbeat frame", () => {
    expect(
      remoteCapabilitiesSubscribeServerFrameSchema.parse({
        kind: "pong",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("pong");
  });

  it("rejects an unknown server frame kind", () => {
    expect(
      remoteCapabilitiesSubscribeServerFrameSchema.safeParse({
        kind: "event",
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
  });

  it("rejects a binary-payload frame", () => {
    // Text frames only - this contract has no binary side channel.
    expect(
      remoteCapabilitiesSubscribeServerFrameSchema.safeParse({
        kind: "snapshot",
        capability: REMOTE_CAPABILITY,
        hasBinaryPayload: true,
      }).success,
    ).toBe(false);
  });

  it("requires hasBinaryPayload on every server frame", () => {
    const { hasBinaryPayload: _omitted, ...withoutBinaryFlag } = {
      kind: "snapshot",
      capability: REMOTE_CAPABILITY,
      hasBinaryPayload: false,
    };

    expect(
      remoteCapabilitiesSubscribeServerFrameSchema.safeParse(
        withoutBinaryFlag,
      ).success,
    ).toBe(false);
  });
});

describe("host.remote.capabilities.subscribe client frames", () => {
  it("parses the ping frame", () => {
    expect(
      remoteCapabilitiesSubscribeClientFrameSchema.parse({
        kind: "ping",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("ping");
  });

  it("rejects a binary-payload client frame", () => {
    expect(
      remoteCapabilitiesSubscribeClientFrameSchema.safeParse({
        kind: "ping",
        hasBinaryPayload: true,
      }).success,
    ).toBe(false);
  });
});

describe("host.remote.capabilities.subscribe degrades against an older host", () => {
  it("fails only this method's subscribe, leaving every other stream method compatible", () => {
    const currentManifest = buildStreamManifest(hostStreamRpcRegistry);
    // A host that predates the method simply omits it from its manifest.
    const olderHostManifest = Object.fromEntries(
      Object.entries(currentManifest).filter(([method]) => method !== METHOD),
    );

    const caps = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      currentManifest,
      olderHostManifest,
      "client",
      METHOD,
    );
    expect(caps.ok).toBe(false);
    if (!caps.ok) {
      // The client turns this into `onMethodSupport(method, "unsupported")`
      // and the cross-host surface degrades to "capabilities unknown".
      expect(caps.details.incompatibleMethods).toEqual([
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
