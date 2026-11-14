import { describe, expect, it } from "vitest";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import { checkSurfaceCompatibility } from "@traycer/protocol/framework/surface-compat";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  providersCommitProfileMoveRequestSchema,
  providersCommitProfileMoveResponseSchema,
  providersPreviewProfileMoveResponseSchema,
} from "@traycer/protocol/host/profile-move-schemas";
import { resolveUnavailableMethodDegrade } from "@traycer/protocol/host-transport/remote/unavailable-method-degrade";

const PREVIEW_METHOD = "providers.previewProfileMove";
const COMMIT_METHOD = "providers.commitProfileMove";
const METHODS = [PREVIEW_METHOD, COMMIT_METHOD] as const;
const OPERATION_ID = "01a2b3c4-d5e6-4789-8abc-0123456789ab";
const BOT_ID = "bot_01HZK2Q8Y7N6M5P4R3T2V1W0XA";
const source = { providerId: "claude-code", profileId: "managed-1" } as const;
const ref = { kind: "bot", botId: BOT_ID } as const;

const agentTarget = {
  kind: "agent" as const,
  epicId: "epic-synthetic",
  agentId: "agent-synthetic",
  hostId: "host-synthetic",
  title: "Synthetic agent",
  standing: "waiting" as const,
};

const botTarget = {
  kind: "bot" as const,
  botId: BOT_ID,
  hostId: "host-synthetic",
  title: "Synthetic bot",
  standing: "waiting" as const,
};

const terminal = {
  epicId: "epic-terminal",
  agentId: "agent-terminal",
  hostId: "host-terminal",
  title: "Terminal agent",
};

const commitRequest = {
  operationId: OPERATION_ID,
  extent: "fleet" as const,
  mode: "waiting" as const,
  source,
  destinationProfileId: "managed-2",
  targets: [ref],
};

function registryFor(method: (typeof METHODS)[number]) {
  return hostRpcRegistry[method];
}

describe.each(METHODS)("%s optional registry surface", (method) => {
  const methodRegistry = registryFor(method);

  it("validates alone at optional 1.0, off the released floor", () => {
    expect(() =>
      validateVersionedRpcRegistry({ [method]: methodRegistry }),
    ).not.toThrow();
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
    expect(methodRegistry.degrade).toEqual({ kind: "unsupported" });
    expect(methodRegistry[1].latestMinor).toBe(0);

    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(split.optionalManifest[method]).toEqual({ major: 1, minor: 0 });
    expect(split.manifest[method]).toBeUndefined();
  });

  it("is advisory when the peer does not advertise it", () => {
    const mine = buildProtocolSurface({
      unary: { [method]: methodRegistry },
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: {},
    });
    const theirs = buildProtocolSurface({
      unary: {},
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: {},
    });
    const result = checkSurfaceCompatibility({
      mine,
      theirs,
      theirsLabel: "released",
      exceptions: [],
    });
    expect(result.blocking).toEqual([]);
    expect(result.findings).toEqual([
      expect.objectContaining({
        method,
        family: "unary",
        severity: "advisory",
      }),
    ]);
  });

  it("rejects an unavailable peer without running fallback", async () => {
    let fallbackRan = false;
    await expect(
      resolveUnavailableMethodDegrade({
        registry: hostRpcRegistry,
        method,
        methodRegistry,
        clientCanonical: { major: 1, minor: 0 },
        clientManifest: { [method]: { major: 1, minor: 0 } },
        hostManifest: {},
        params: {},
        requestId: `req-${method}`,
        execute: () => {
          fallbackRan = true;
          return Promise.resolve({});
        },
      }),
    ).rejects.toMatchObject({
      code: "E_HOST_UNSUPPORTED",
      method,
      fatalDetails: {
        code: "E_HOST_UNSUPPORTED",
        upgradeGuidance: {
          clientShouldUpgrade: false,
          hostShouldUpgrade: true,
        },
      },
    });
    expect(fallbackRan).toBe(false);
  });
});

describe("providers.previewProfileMove schema", () => {
  it("accepts fleet waiting targets without count and keeps terminals outside targets", () => {
    const parsed = providersPreviewProfileMoveResponseSchema.parse({
      extent: "fleet",
      mode: "waiting",
      targets: [agentTarget, botTarget],
      terminals: [terminal],
      pendingComputers: [{ hostId: "host-pending", reason: "unreachable" }],
    });
    expect(parsed.targets).toHaveLength(2);
    expect(parsed.terminals).toEqual([terminal]);
    expect(parsed).not.toHaveProperty("count");
  });

  it("rejects a running target in waiting mode", () => {
    expect(
      providersPreviewProfileMoveResponseSchema.safeParse({
        extent: "fleet",
        mode: "waiting",
        targets: [{ ...agentTarget, standing: "running" }],
        terminals: [],
        pendingComputers: [],
      }).success,
    ).toBe(false);
  });

  it("rejects pending computers for this-computer extent", () => {
    expect(
      providersPreviewProfileMoveResponseSchema.safeParse({
        extent: "this-computer",
        mode: "waiting",
        targets: [],
        terminals: [],
        pendingComputers: [{ hostId: "host-pending", reason: "unsupported" }],
      }).success,
    ).toBe(false);
  });

  it("rejects each list over its schema ceiling without truncating", () => {
    const overLimit = [
      {
        targets: Array.from({ length: 2001 }, (_, index) => ({
          ...agentTarget,
          epicId: `epic-${index}`,
        })),
        terminals: [],
        pendingComputers: [],
      },
      {
        targets: [],
        terminals: Array.from({ length: 2001 }, (_, index) => ({
          ...terminal,
          epicId: `epic-${index}`,
        })),
        pendingComputers: [],
      },
      {
        targets: [],
        terminals: [],
        pendingComputers: Array.from({ length: 501 }, (_, index) => ({
          hostId: `host-${index}`,
          reason: "unreachable",
        })),
      },
    ];
    for (const lists of overLimit) {
      expect(
        providersPreviewProfileMoveResponseSchema.safeParse({
          extent: "fleet",
          mode: "waiting",
          ...lists,
        }).success,
      ).toBe(false);
    }
  });
});

describe("providers.commitProfileMove schemas", () => {
  it("accepts a request-ref result with a null row in waiting mode", () => {
    const parsed = providersCommitProfileMoveResponseSchema.parse({
      operationId: OPERATION_ID,
      extent: "fleet",
      mode: "waiting",
      results: [{ outcome: "pending", target: ref, row: null }],
    });
    expect(parsed.results).toEqual([
      { outcome: "pending", target: ref, row: null },
    ]);
  });

  it("rejects deferred outcomes and non-waiting rows in waiting mode", () => {
    const base = {
      operationId: OPERATION_ID,
      extent: "fleet",
      mode: "waiting",
    };
    expect(
      providersCommitProfileMoveResponseSchema.safeParse({
        ...base,
        results: [{ outcome: "deferred", target: ref, row: null }],
      }).success,
    ).toBe(false);
    expect(
      providersCommitProfileMoveResponseSchema.safeParse({
        ...base,
        results: [
          {
            outcome: "pending",
            target: ref,
            row: { ...botTarget, standing: "running" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a same-profile destination, duplicate target, uppercase operation id, and empty profile id", () => {
    expect(
      providersCommitProfileMoveRequestSchema.safeParse({
        ...commitRequest,
        destinationProfileId: source.profileId,
      }).success,
    ).toBe(false);
    expect(
      providersCommitProfileMoveRequestSchema.safeParse({
        ...commitRequest,
        targets: [ref, ref],
      }).success,
    ).toBe(false);
    expect(
      providersCommitProfileMoveRequestSchema.safeParse({
        ...commitRequest,
        operationId: "01A2b3c4-d5e6-4789-8abc-0123456789ab",
      }).success,
    ).toBe(false);
    expect(
      providersCommitProfileMoveRequestSchema.safeParse({
        ...commitRequest,
        source: { ...source, profileId: "" },
      }).success,
    ).toBe(false);
  });

  it("rejects a target list past the 2000-target ceiling", () => {
    const targets = Array.from({ length: 2001 }, (_, index) => ({
      kind: "agent" as const,
      epicId: `epic-${index}`,
      agentId: "agent-synthetic",
    }));
    expect(
      providersCommitProfileMoveRequestSchema.safeParse({
        ...commitRequest,
        targets,
      }).success,
    ).toBe(false);
  });
});
