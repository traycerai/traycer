import { randomUUID } from "node:crypto";
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
import { resolveUnavailableMethodDegrade } from "@traycer/protocol/host-transport/remote/unavailable-method-degrade";

const LIST_METHOD = "providers.syncLinks.list";
const STOP_METHOD = "providers.syncLinks.stop";
const METHODS = [LIST_METHOD, STOP_METHOD] as const;

const CLAUDE_PROFILE = randomUUID();
const CODEX_PROFILE = randomUUID();

const claudeFolder = {
  providerId: "claude-code" as const,
  profileId: CLAUDE_PROFILE,
  label: "Claude work",
  accountClass: "renewing" as const,
  hold: "none" as const,
  peers: [
    {
      hostId: "host-air",
      displayName: "MacBook Air",
      version: "needs-update" as const,
    },
    {
      hostId: "host-studio",
      displayName: "Studio",
      version: "current" as const,
    },
  ],
};

const codexFolder = {
  providerId: "codex" as const,
  profileId: CODEX_PROFILE,
  label: "Codex key",
  accountClass: "key" as const,
  hold: "none" as const,
  peers: [
    { hostId: "host-mini", displayName: null, version: "unknown" as const },
  ],
};

const threeComputers = {
  teamComputer: false,
  folders: [claudeFolder, codexFolder],
};

const folderScope = {
  scope: {
    kind: "folder" as const,
    providerId: "codex" as const,
    profileId: CODEX_PROFILE,
  },
};

const listContract = hostRpcRegistry[LIST_METHOD][1].versions[0].contract;
const stopContract = hostRpcRegistry[STOP_METHOD][1].versions[0].contract;

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
        params:
          method === LIST_METHOD
            ? listContract.requestSchema.parse({})
            : stopContract.requestSchema.parse({ scope: { kind: "all" } }),
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

describe("providers.syncLinks.list schema", () => {
  it("parses a claude folder with two peers and a codex folder with one", () => {
    expect(listContract.responseSchema.parse(threeComputers)).toEqual(
      threeComputers,
    );
  });

  it("rejects an unknown field", () => {
    expect(
      listContract.responseSchema.safeParse({
        ...threeComputers,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("rejects a folder with no peers", () => {
    expect(
      listContract.responseSchema.safeParse({
        teamComputer: false,
        folders: [{ ...claudeFolder, peers: [] }, codexFolder],
      }).success,
    ).toBe(false);
  });

  it("rejects the link-store spelling of the claude provider", () => {
    expect(
      listContract.responseSchema.safeParse({
        teamComputer: false,
        folders: [{ ...claudeFolder, providerId: "claude" }, codexFolder],
      }).success,
    ).toBe(false);
  });
});

describe("providers.syncLinks.stop schema", () => {
  it("parses a stop for every linked folder", () => {
    expect(
      stopContract.requestSchema.parse({ scope: { kind: "all" } }),
    ).toEqual({ scope: { kind: "all" } });
  });

  it("parses a stop for one folder", () => {
    expect(stopContract.requestSchema.parse(folderScope)).toEqual(folderScope);
  });

  it("rejects a folder scope without a profile id", () => {
    expect(
      stopContract.requestSchema.safeParse({
        scope: { kind: "folder", providerId: "claude-code" },
      }).success,
    ).toBe(false);
  });

  it("parses kept and gave-up-copy outcomes", () => {
    const response = {
      accounts: [
        {
          providerId: "claude-code" as const,
          profileId: CLAUDE_PROFILE,
          outcome: "kept" as const,
        },
        {
          providerId: "codex" as const,
          profileId: CODEX_PROFILE,
          outcome: "gave-up-copy" as const,
        },
      ],
    };
    expect(stopContract.responseSchema.parse(response)).toEqual(response);
  });
});
