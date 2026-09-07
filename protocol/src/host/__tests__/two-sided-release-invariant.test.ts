import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  checkCompatibility,
  splitConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/index";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { supportMatrix } from "./__fixtures__/support-matrix";

/**
 * Two-sided release invariant for the `/rpc` handshake (architecture decision #15 / R4-D2): every supported app version can open a session to every host >= the version floor, and a new capability must ride a versioned `{.
 * This test only READS `hostRpcRegistry` and the committed fixture - it never regenerates or writes anything.
 */
describe("two-sided release invariant: current registry vs support matrix", () => {
  // This invariant governs the FLOOR handshake - the required, name-set-fatal methods a still-supported peer relies on.
  // Restrict BOTH sides to the released floor so the check models the real floor-vs-floor handshake rather than flagging every additive method the historical peer never advertised.
  const floorNames = new Set(RELEASED_FLOOR_METHOD_NAMES);
  const floorOnly = (manifest: ConnectionManifest): ConnectionManifest =>
    Object.fromEntries(
      Object.entries(manifest).filter(([method]) => floorNames.has(method)),
    );
  const { manifest: currentManifest } = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
    SERVES_EVERY_INSTALLED_MAJOR,
  );

  it.each(supportMatrix)(
    "forward-compat: current registry bridges down to $version",
    ({ version, manifest }) => {
      const result = checkCompatibility(
        hostRpcRegistry,
        currentManifest,
        floorOnly(manifest),
        "host",
      );

      expect(
        result.ok,
        result.ok
          ? undefined
          : `current registry cannot bridge to ${version}: ${JSON.stringify(result.details, null, 2)}`,
      ).toBe(true);
    },
  );

  it.each(supportMatrix)(
    "no-regression: no method's canonical version has regressed below $version",
    ({ version, manifest }) => {
      const result = checkCompatibility(
        hostRpcRegistry,
        floorOnly(manifest),
        currentManifest,
        "client",
      );

      expect(
        result.ok,
        result.ok
          ? undefined
          : `a method regressed below its ${version} baseline: ${JSON.stringify(result.details, null, 2)}`,
      ).toBe(true);
    },
  );
});
