import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { check } from "@traycer/protocol/framework/compatibility-checker";
import type { ConnectionManifest } from "@traycer/protocol/framework/ws-protocol";

const echoV10 = defineRpcContract({
  method: "echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ text: z.string() }),
  responseSchema: z.object({ upper: z.string() }),
});

const echoV11 = defineRpcContract({
  method: "echo",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: z.object({ text: z.string(), trim: z.boolean() }),
  responseSchema: z.object({ upper: z.string(), trimmed: z.boolean() }),
});

const echoV20 = defineRpcContract({
  method: "echo",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: z.object({
    text: z.string().min(1),
    trim: z.boolean(),
    locale: z.string().nullable(),
  }),
  responseSchema: z.object({
    upper: z.string(),
    trimmed: z.boolean(),
    localeApplied: z.boolean(),
  }),
});

const pingV10 = defineRpcContract({
  method: "ping",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ pong: z.boolean() }),
});

const statusV10 = defineRpcContract({
  method: "status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ ready: z.boolean() }),
});

const upgradeEchoV10ToV11 = defineUpgradePath<typeof echoV10, typeof echoV11>({
  from: echoV10.schemaVersion,
  to: echoV11.schemaVersion,
  upgradeRequest: (request) => ({ text: request.text, trim: false }),
  upgradeResponse: (response) => ({ upper: response.upper, trimmed: false }),
});

const upgradeEchoV11ToV20 = defineUpgradePath<typeof echoV11, typeof echoV20>({
  from: echoV11.schemaVersion,
  to: echoV20.schemaVersion,
  upgradeRequest: (request) => ({
    text: request.text,
    trim: request.trim,
    locale: null,
  }),
  upgradeResponse: (response) => ({
    upper: response.upper,
    trimmed: response.trimmed,
    localeApplied: false,
  }),
});

const downgradeEchoV20ToV11 = defineDowngradePath<
  typeof echoV20,
  typeof echoV11
>({
  from: echoV20.schemaVersion,
  to: echoV11.schemaVersion,
  downgradeRequest: (request) => ({
    ok: true,
    value: { text: request.text, trim: request.trim },
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: { upper: response.upper, trimmed: response.trimmed },
  }),
});

const registryEchoV11 = defineVersionedRpcRegistry({
  echo: {
    1: {
      latestMinor: 1,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
        1: {
          contract: echoV11,
          upgradeFromPreviousVersion: upgradeEchoV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
});

const registryEchoV20WithBridge = defineVersionedRpcRegistry({
  echo: {
    1: {
      latestMinor: 1,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
        1: {
          contract: echoV11,
          upgradeFromPreviousVersion: upgradeEchoV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: echoV20,
          upgradeFromPreviousVersion: upgradeEchoV11ToV20,
        },
      },
      downgradePathsFromLatest: { 1: downgradeEchoV20ToV11 },
    },
  },
});

const registryEchoV20NoBridge = defineVersionedRpcRegistry({
  echo: {
    2: {
      latestMinor: 0,
      versions: {
        0: { contract: echoV20, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

const registryWithPing = defineVersionedRpcRegistry({
  echo: {
    1: {
      latestMinor: 1,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
        1: {
          contract: echoV11,
          upgradeFromPreviousVersion: upgradeEchoV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  ping: {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: pingV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

const registryWithStatus = defineVersionedRpcRegistry({
  echo: {
    1: {
      latestMinor: 1,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
        1: {
          contract: echoV11,
          upgradeFromPreviousVersion: upgradeEchoV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  status: {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: statusV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

const manifestEcho11: ConnectionManifest = {
  echo: { major: 1, minor: 1 },
};

const manifestEcho10: ConnectionManifest = {
  echo: { major: 1, minor: 0 },
};

const manifestEcho20: ConnectionManifest = {
  echo: { major: 2, minor: 0 },
};

describe("CompatibilityChecker.check", () => {
  it("accepts same-major same-minor manifests", () => {
    const result = check(
      registryEchoV11,
      manifestEcho11,
      manifestEcho11,
      "host",
    );

    expect(result).toEqual({ ok: true });
  });

  it("accepts same-major different-minor manifests via the within-major chain", () => {
    const hostResult = check(
      registryEchoV11,
      manifestEcho11,
      manifestEcho10,
      "host",
    );
    expect(hostResult).toEqual({ ok: true });

    const clientResult = check(
      registryEchoV11,
      manifestEcho10,
      manifestEcho11,
      "client",
    );
    expect(clientResult).toEqual({ ok: true });
  });

  it("accepts cross-major pairs when the newer side carries a downgrade bridge", () => {
    const hostResult = check(
      registryEchoV20WithBridge,
      manifestEcho20,
      manifestEcho11,
      "host",
    );
    expect(hostResult).toEqual({ ok: true });

    const clientOlderSide = check(
      registryEchoV11,
      manifestEcho11,
      manifestEcho20,
      "client",
    );
    expect(clientOlderSide).toEqual({ ok: true });
  });

  it("reports no-bridge when the newer side lacks a cross-major downgrade", () => {
    const result = check(
      registryEchoV20NoBridge,
      manifestEcho20,
      manifestEcho11,
      "host",
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected incompatibility");
    }
    expect(result.details.code).toBe("INCOMPATIBLE");
    expect(result.details.incompatibleMethods).toEqual([
      {
        method: "echo",
        clientCanonical: { major: 1, minor: 1 },
        hostCanonical: { major: 2, minor: 0 },
        blocking: "no-bridge",
      },
    ]);
    expect(result.details.upgradeGuidance).toEqual({
      clientShouldUpgrade: true,
      hostShouldUpgrade: false,
    });
  });

  it("labels missing methods from each side's perspective", () => {
    const hostSees = check(
      registryWithPing,
      { echo: { major: 1, minor: 1 }, ping: { major: 1, minor: 0 } },
      { echo: { major: 1, minor: 1 } },
      "host",
    );
    expect(hostSees.ok).toBe(false);
    if (hostSees.ok) {
      throw new Error("expected incompatibility");
    }
    expect(hostSees.details.incompatibleMethods).toEqual([
      {
        method: "ping",
        clientCanonical: null,
        hostCanonical: { major: 1, minor: 0 },
        blocking: "client-missing-method",
      },
    ]);
    expect(hostSees.details.upgradeGuidance).toEqual({
      clientShouldUpgrade: true,
      hostShouldUpgrade: false,
    });

    const clientSees = check(
      registryWithStatus,
      { echo: { major: 1, minor: 1 }, status: { major: 1, minor: 0 } },
      { echo: { major: 1, minor: 1 } },
      "client",
    );
    expect(clientSees.ok).toBe(false);
    if (clientSees.ok) {
      throw new Error("expected incompatibility");
    }
    expect(clientSees.details.incompatibleMethods).toEqual([
      {
        method: "status",
        clientCanonical: { major: 1, minor: 0 },
        hostCanonical: null,
        blocking: "host-missing-method",
      },
    ]);
    expect(clientSees.details.upgradeGuidance).toEqual({
      clientShouldUpgrade: false,
      hostShouldUpgrade: true,
    });
  });

  it("pins current full-manifest verdicts for added method names", () => {
    const hostSeesClientMissingAddedMethod = check(
      registryWithPing,
      { echo: { major: 1, minor: 1 }, ping: { major: 1, minor: 0 } },
      { echo: { major: 1, minor: 1 } },
      "host",
    );

    expect(hostSeesClientMissingAddedMethod).toEqual({
      ok: false,
      details: {
        code: "INCOMPATIBLE",
        reason: "Incompatible methods: ping",
        incompatibleMethods: [
          {
            method: "ping",
            clientCanonical: null,
            hostCanonical: { major: 1, minor: 0 },
            blocking: "client-missing-method",
          },
        ],
        upgradeGuidance: {
          clientShouldUpgrade: true,
          hostShouldUpgrade: false,
        },
      },
    });

    const clientSeesHostMissingAddedMethod = check(
      registryWithStatus,
      { echo: { major: 1, minor: 1 }, status: { major: 1, minor: 0 } },
      { echo: { major: 1, minor: 1 } },
      "client",
    );

    expect(clientSeesHostMissingAddedMethod).toEqual({
      ok: false,
      details: {
        code: "INCOMPATIBLE",
        reason: "Incompatible methods: status",
        incompatibleMethods: [
          {
            method: "status",
            clientCanonical: { major: 1, minor: 0 },
            hostCanonical: null,
            blocking: "host-missing-method",
          },
        ],
        upgradeGuidance: {
          clientShouldUpgrade: false,
          hostShouldUpgrade: true,
        },
      },
    });
  });
});
