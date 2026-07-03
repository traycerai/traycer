import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  buildStreamManifest,
  checkStreamCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { streamSupportMatrix } from "./__fixtures__/stream-support-matrix";

/**
 * Two-sided release invariant for the `/stream` handshake - the streaming
 * counterpart of `two-sided-release-invariant.test.ts` (unary `/rpc`).
 *
 * `released-stream-surface-compat.test.ts` guards the method-NAME half of
 * the invariant. This test guards the complementary, cross-VERSION half:
 * given the support matrix of still-supported historical `/stream` manifests
 * (`__fixtures__/stream-support-matrix.ts`), does
 * `checkStreamCompatibility()` still return `{ ok: true }` for the CURRENT
 * live `hostStreamRpcRegistry` against every one of them?
 *
 * One real difference from the unary check, inherited from
 * `checkStreamCompatibility` itself (`stream-compat.ts`'s `canBridgeStream`):
 * v1 stream clients RECONNECT on a mismatched major rather than bridging
 * across majors (no `downgradePathsFromLatest` equivalent for streams). So
 * unlike the unary "forward-compat"/"no-regression" pair, a stream method
 * that bumped MAJOR since a historical baseline would correctly report
 * incompatible here (that is the intended v1 stream behaviour - a major
 * bump is a reconnect event, not a silent break) rather than a bug this test
 * should paper over. Today no stream method has bumped major since
 * `host-v1.0.0` (only additive minor bumps: `terminal.subscribe` -> 1.2,
 * `chat.subscribe` -> 1.1), so both directions are green; if a future major
 * bump makes this test fail, that failure is doing its job - it means the
 * two-sided invariant's stream half needs the SAME release-coordination
 * `released-stream-method-names.ts`-style decision as a name change would,
 * not a silent merge.
 *
 * This test only READS `hostStreamRpcRegistry` and the committed fixture -
 * it never regenerates or writes anything. Regenerate the fixture via
 * `protocol/scripts/snapshot-stream-support-matrix.ts` (see that script's
 * header and `RELEASE-INVARIANT.md` for the append procedure).
 */
describe("two-sided release invariant: current stream registry vs stream support matrix", () => {
  const currentManifest = buildStreamManifest(hostStreamRpcRegistry);

  it.each(streamSupportMatrix)(
    "forward-compat: current stream registry bridges down to $version",
    ({ version, manifest }) => {
      const result = checkStreamCompatibility(
        hostStreamRpcRegistry,
        currentManifest,
        manifest,
        "host",
      );

      expect(
        result.ok,
        result.ok
          ? undefined
          : `current stream registry cannot bridge to ${version}: ${JSON.stringify(result.details, null, 2)}`,
      ).toBe(true);
    },
  );

  it.each(streamSupportMatrix)(
    "no-regression: no stream method's canonical version has regressed below $version",
    ({ version, manifest }) => {
      const result = checkStreamCompatibility(
        hostStreamRpcRegistry,
        manifest,
        currentManifest,
        "client",
      );

      expect(
        result.ok,
        result.ok
          ? undefined
          : `a stream method regressed below its ${version} baseline: ${JSON.stringify(result.details, null, 2)}`,
      ).toBe(true);
    },
  );
});
