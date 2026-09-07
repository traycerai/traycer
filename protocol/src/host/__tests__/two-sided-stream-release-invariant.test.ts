import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { streamSupportMatrix } from "./__fixtures__/stream-support-matrix";

/**
 * Two-sided release invariant for the `/stream` handshake - the streaming counterpart of `two-sided-release-invariant.test.ts` (unary `/rpc`).
 * This test only READS `hostStreamRpcRegistry` and the committed fixture - it never regenerates or writes anything.
 */
describe("two-sided release invariant: current stream registry vs stream support matrix", () => {
  const currentManifest = buildStreamManifest(
    hostStreamRpcRegistry,
    SERVES_EVERY_INSTALLED_MAJOR,
  );

  it.each(streamSupportMatrix)(
    "forward-compat: every $version method still bridges from today's registry",
    ({ version, manifest }) => {
      for (const method of Object.keys(manifest)) {
        const result = checkStreamMethodCompatibility(
          hostStreamRpcRegistry,
          currentManifest,
          manifest,
          "host",
          method,
        );

        expect(
          result.ok,
          result.ok
            ? undefined
            : `current stream registry cannot bridge "${method}" to ${version}: ${JSON.stringify(result.details, null, 2)}`,
        ).toBe(true);
      }
    },
  );

  it.each(streamSupportMatrix)(
    "no-regression: no $version method's canonical version has regressed",
    ({ version, manifest }) => {
      for (const method of Object.keys(manifest)) {
        const result = checkStreamMethodCompatibility(
          hostStreamRpcRegistry,
          manifest,
          currentManifest,
          "client",
          method,
        );

        expect(
          result.ok,
          result.ok
            ? undefined
            : `stream method "${method}" regressed below its ${version} baseline: ${JSON.stringify(result.details, null, 2)}`,
        ).toBe(true);
      }
    },
  );

  /**
   * Degrade contract: a method name that a released baseline never advertised (e.g.
   * `resources.subscribe`, merged after `host-v1.0.0`) must not affect the per-method result of any method the baseline DID advertise.
   */
  it.each(streamSupportMatrix)(
    "degrade contract: method names absent from $version do not affect its baselined methods",
    ({ manifest }) => {
      const currentOnlyMethods = Object.keys(currentManifest).filter(
        (method) => !Object.prototype.hasOwnProperty.call(manifest, method),
      );
      // The premise only holds if today's registry actually adds names the
      // baseline lacked; otherwise this test proves nothing about additivity.
      expect(currentOnlyMethods.length).toBeGreaterThan(0);

      for (const method of Object.keys(manifest)) {
        expect(
          checkStreamMethodCompatibility(
            hostStreamRpcRegistry,
            currentManifest,
            manifest,
            "host",
            method,
          ).ok,
          `baselined method "${method}" was affected by current-only names ${JSON.stringify(currentOnlyMethods)}`,
        ).toBe(true);
      }
    },
  );
});
