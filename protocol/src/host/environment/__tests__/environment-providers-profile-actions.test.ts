import { assert, describe, expect, it } from "vitest";
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

/**
 * Caller-session actions on a row from `environment.providers.list`.
 * Registration, the released floor, and one valid and one malformed
 * request and response are the redesign wire table. Here: an unknown
 * provider id is kept, a rename label's bounds, an answer that keeps
 * neither a revision, a harness id nor an account id, and the handshake
 * when a peer does not advertise that one method.
 */
const ACTIONS = [
  "environment.providers.signOutProfile",
  "environment.providers.removeProfile",
  "environment.providers.renameProfile",
] as const;

const TARGET = {
  environmentId: "env-1",
  providerId: "future-provider",
  profileId: "1",
};

const NOT_ON_THE_ANSWER = {
  revision: "9",
  harnessId: "claude-code",
  accountId: "row",
};

describe("environment provider profile actions", () => {
  it("keeps an unknown provider id on each action and rejects an empty one", () => {
    for (const method of [
      "environment.providers.signOutProfile",
      "environment.providers.removeProfile",
    ] as const) {
      const requestSchema =
        hostRpcRegistry[method][1].versions[0].contract.requestSchema;
      expect(requestSchema.parse(TARGET)).toEqual(TARGET);
      expect(
        requestSchema.safeParse({ ...TARGET, providerId: "" }).success,
      ).toBe(false);
    }
    const renamed = { ...TARGET, label: "Chosen" };
    const rename =
      hostRpcRegistry["environment.providers.renameProfile"][1].versions[0]
        .contract.requestSchema;
    expect(rename.parse(renamed)).toEqual(renamed);
    expect(rename.safeParse({ ...renamed, providerId: "" }).success).toBe(
      false,
    );
  });

  it("accepts a rename label of 1 and 64 characters and rejects 0 and 65", () => {
    const requestSchema =
      hostRpcRegistry["environment.providers.renameProfile"][1].versions[0]
        .contract.requestSchema;
    const base = {
      environmentId: "env-1",
      providerId: "claude-code",
      profileId: "1",
    };
    const one = "a";
    const sixtyFour = "a".repeat(64);
    expect(requestSchema.parse({ ...base, label: one })).toEqual({
      ...base,
      label: one,
    });
    expect(requestSchema.parse({ ...base, label: sixtyFour })).toEqual({
      ...base,
      label: sixtyFour,
    });
    expect(requestSchema.safeParse({ ...base, label: "" }).success).toBe(false);
    expect(
      requestSchema.safeParse({ ...base, label: "a".repeat(65) }).success,
    ).toBe(false);
  });

  it("answers with the action's flag or label and drops a revision, a harness id and an account id", () => {
    const signOut =
      hostRpcRegistry["environment.providers.signOutProfile"][1].versions[0]
        .contract.responseSchema;
    const remove =
      hostRpcRegistry["environment.providers.removeProfile"][1].versions[0]
        .contract.responseSchema;
    const rename =
      hostRpcRegistry["environment.providers.renameProfile"][1].versions[0]
        .contract.responseSchema;
    expect(signOut.parse({ signedOut: true, ...NOT_ON_THE_ANSWER })).toEqual({
      signedOut: true,
    });
    expect(remove.parse({ removed: true, ...NOT_ON_THE_ANSWER })).toEqual({
      removed: true,
    });
    expect(rename.parse({ label: "Chosen", ...NOT_ON_THE_ANSWER })).toEqual({
      label: "Chosen",
    });
  });
});

describe("environment provider profile action handshake", () => {
  it("advertises each action on the optional manifest", () => {
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    for (const method of ACTIONS) {
      expect(() =>
        validateVersionedRpcRegistry({
          [method]: hostRpcRegistry[method],
        }),
      ).not.toThrow();
      expect(split.optionalManifest[method]).toEqual({ major: 1, minor: 0 });
      expect(split.manifest[method]).toBeUndefined();
    }
  });

  it.each(ACTIONS)(
    "treats a peer that lacks %s as advisory and unsupported",
    (method) => {
      const mine = buildProtocolSurface({
        unary: { [method]: hostRpcRegistry[method] },
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
      const finding = result.findings[0];
      assert.isDefined(finding);
      expect(finding.detail).toContain("unsupported");
    },
  );

  it.each(ACTIONS)(
    "answers unsupported for %s alone when the peer does not advertise it",
    async (method) => {
      await expect(
        resolveUnavailableMethodDegrade({
          registry: hostRpcRegistry,
          method,
          methodRegistry: hostRpcRegistry[method],
          clientCanonical: { major: 1, minor: 0 },
          clientManifest: { [method]: { major: 1, minor: 0 } },
          hostManifest: {},
          params:
            method === "environment.providers.renameProfile"
              ? { ...TARGET, label: "Chosen" }
              : TARGET,
          requestId: `req-${method}`,
          execute: () => Promise.reject(new Error("fallback must not run")),
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
    },
  );
});
