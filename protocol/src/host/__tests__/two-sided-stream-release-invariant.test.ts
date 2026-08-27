import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { streamSupportMatrix } from "./__fixtures__/stream-support-matrix";

/**
 * Two-sided release invariant for the `/stream` handshake - the streaming
 * counterpart of `two-sided-release-invariant.test.ts` (unary `/rpc`).
 *
 * `released-stream-surface-compat.test.ts` guards the method-NAME half (no
 * baselined name is ever dropped). This test guards the cross-VERSION half:
 * for the support matrix of still-supported historical `/stream` manifests
 * (`__fixtures__/stream-support-matrix.ts`), can the CURRENT live
 * `hostStreamRpcRegistry` still bridge to each baselined method in both
 * directions?
 *
 * Crucially, this is a PER-METHOD check, because that is how `/stream`
 * compatibility is enforced at runtime. There is no whole-manifest gate on a
 * live `/stream` connection: each subscribe calls
 * `checkStreamMethodCompatibility(registry, mine, theirs, role, method)` for
 * the single method being subscribed (`ws-stream-client.ts` ~L688 and the
 * host's stream-connection-handler). So the invariant is checked the same way:
 * for each `{ version, manifest }` baseline we iterate ONLY that baseline's
 * methods (`Object.keys(manifest)`) and assert each one still bridges. Methods
 * present only in today's registry are intentionally out of scope - a released
 * peer never subscribes to a method it has never heard of, and a newer peer
 * subscribing to a host-missing method degrades that one feature quietly
 * rather than breaking the connection.
 *
 * Two directions per baselined method, mirroring the runtime call sites:
 *   - forward-compat: today's registry (`role: "host"`) serving a client still
 *     on the baseline manifest.
 *   - no-regression: the baseline manifest (`role: "client"`) subscribing
 *     against today's registry - i.e. no method's canonical has regressed
 *     below its baseline.
 *
 * Canonical-major skew bridges when both peers' installed-major advertisements
 * intersect (`canBridgeStream` uses that intersection), while a legacy entry
 * with no `supportedMajors` still means its canonical major only. The frozen
 * fixture therefore keeps the host-v1.0.0 baseline useful: a future current
 * major can still bridge it when major 1 remains installed. If no major is
 * shared, the invariant fails and exposes a real release-compatibility break.
 *
 * This test only READS `hostStreamRpcRegistry` and the committed fixture -
 * it never regenerates or writes anything. Regenerate the fixture via
 * `protocol/scripts/snapshot-stream-support-matrix.ts` (see that script's
 * header and `RELEASE-INVARIANT.md` for the append procedure).
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
   * Degrade contract: a method name that a released baseline never advertised
   * (e.g. `resources.subscribe`, merged after `host-v1.0.0`) must not affect
   * the per-method result of any method the baseline DID advertise. This is the
   * concrete guarantee that makes new `/stream` method names additive: the
   * union differing between peers is irrelevant to a per-method subscribe. The
   * client-side quiet-degrade behaviour itself is pinned separately by
   * `clients/shared/host-transport/__tests__/ws-stream-client.test.ts`.
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
