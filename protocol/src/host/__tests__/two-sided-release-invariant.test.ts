import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { checkCompatibility } from "@traycer/protocol/framework/index";
import { buildManifestFromRegistry } from "@traycer/protocol/framework/rpc-manifest";
import { supportMatrix } from "./__fixtures__/support-matrix";

/**
 * Two-sided release invariant for the `/rpc` handshake (architecture
 * decision #15 / R4-D2): every supported app version can open a session to
 * every host >= the version floor, and a new capability must ride a
 * versioned `{ major, minor }` bump of an EXISTING method rather than a new
 * method name.
 *
 * `released-surface-compat.test.ts` guards the method-NAME half of that
 * invariant (nobody added/removed a name a supported peer still relies on).
 * This test guards the complementary, cross-VERSION half: given the support
 * matrix of still-supported historical manifests
 * (`__fixtures__/support-matrix.ts`), does `compatibility-checker.check()`
 * still return `{ ok: true }` for the CURRENT live `hostRpcRegistry` against
 * every one of them? A method-name mismatch would already fail here too
 * (`check()` is fail-closed on the name-set union), but the real value-add
 * is catching a version bump that silently drops a bridge a still-supported
 * peer needs - e.g. someone deletes an `upgradeFromPreviousVersion` entry or
 * a `downgradePathsFromLatest` entry - which a name-set-only diff would
 * never see.
 *
 * Two checks run per matrix entry, both using the CURRENT registry as
 * `myRegistry` (the support matrix only stores flat manifests, not full
 * historical registries with bridge functions - see the fixture header for
 * why that's the right scope):
 *
 * - "forward-compat": `myManifest = CURRENT`, `theirManifest = historical`.
 *   The real-world direction - does code running at HEAD actually still
 *   bridge down to a peer still advertising the historical manifest? This
 *   exercises CURRENT's own `downgradePathsFromLatest` / within-major
 *   upgrade chain for every method that has moved on since that release.
 * - "no-regression": `myManifest = historical`, `theirManifest = CURRENT`.
 *   Not a literal simulation of a real old peer (a real old peer would run
 *   its OWN historical registry, which this repo does not keep around) -
 *   it's a monotonicity guard. Because every method's version is assumed to
 *   only move forward across releases, `canBridgeFromMySide` trivially
 *   returns `true` here in the healthy case (the "older side never
 *   transforms" rule). It only fails if some method's CURRENT canonical
 *   version has actually regressed below the historical floor, which is
 *   exactly the bug class this direction exists to catch.
 *
 * This test only READS `hostRpcRegistry` and the committed fixture - it
 * never regenerates or writes anything. Regenerate the fixture via
 * `protocol/scripts/snapshot-support-matrix.ts` (see that script's header
 * and `RELEASE-INVARIANT.md` for the append procedure).
 */
describe("two-sided release invariant: current registry vs support matrix", () => {
  const currentManifest = buildManifestFromRegistry(hostRpcRegistry);

  it.each(supportMatrix)(
    "forward-compat: current registry bridges down to $version",
    ({ version, manifest }) => {
      const result = checkCompatibility(
        hostRpcRegistry,
        currentManifest,
        manifest,
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
        manifest,
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
