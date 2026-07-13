import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "./__fixtures__/released-method-names";

/**
 * Released method-name guard for the unary `/rpc` handshake's FLOOR channel.
 *
 * The per-method handshake (`compatibility-checker`) is fail-closed on the
 * floor METHOD-NAME SET: a floor method name present on only one peer is a
 * fatal `Incompatible methods` error that makes EVERY RPC fail against a peer
 * on the other version. That is exactly how `1.0.1-rc.1` broke against the
 * shipped `host-v1.0.0` - `worktree.readScriptsAtRef` was added as a NEW
 * floor method name.
 *
 * So the floor method-name set is frozen to the last release a peer in the
 * field may still be running (`__fixtures__/released-method-names.ts`, a
 * snapshot of `host-v1.0.0`; regenerate with
 * `protocol/scripts/snapshot-released-method-names.ts`). A new FLOOR
 * capability must ride a new `{ major, minor }` of an EXISTING floor method,
 * never a new method name.
 *
 * This does NOT apply to methods registered outside `RELEASED_FLOOR_METHOD_NAMES`
 * (`released-floor.ts`) with a declared `degrade` policy (`{ kind:
 * "unsupported" }` or `"fallback"`, see `capability-manifest.ts`). Those ride
 * the separate `optionalManifest` channel, which the WS handshake negotiates
 * non-fatally - an old peer just lacks the capability. Their wire-compat is
 * instead checked by `released-baseline-compat.test.ts` (`checkOptionalUnary`
 * in `surface-compat.ts` classifies an optional method missing from an old
 * baseline as advisory when its degrade is `unsupported`, blocking only when
 * it declares no degrade story or the declared fallback is unreachable).
 *
 * ROLE: this test is a FAST LOCAL TRIPWIRE only. The authoritative gate is the
 * `protocol-compat` CI workflow, which dumps every released baseline's surface
 * from its immutable git tag (`protocol/scripts/compat/`) - a baseline no PR
 * can edit. Editing the fixture here does NOT change what CI verifies (that
 * edit-the-fixture path is exactly how `terminal.defaultCwd` shipped
 * handshake-incompatible in #227), and the fixture file itself is tripwired:
 * changing it requires the `protocol-compat-override` label.
 *
 * Scope: this guards only the handshake-fatal class (floor name-set mismatch).
 * It does NOT freeze per-method schemas - the CI gate covers those
 * (same-version wire-schema rules with reviewed exceptions in
 * `compat-exceptions.json`).
 *
 * When this fails for a floor method, fold the capability into an existing
 * method and version it (see `worktree.listByWorkspacePaths@1.1` /
 * `worktree.listBindingsForEpic@1.1`). A genuinely new capability that can
 * tolerate an old-host degrade belongs on the optional channel instead (see
 * `agent.listProviderProfiles` / `agent.getProviderProfileRateLimits` /
 * `agent.configure` in `host/registry.ts` for the template).
 */
describe("released method-name set (host-v1.0.0) is frozen", () => {
  it("still registers every baselined floor method name", () => {
    const current = new Set(Object.keys(hostRpcRegistry));
    for (const method of releasedMethodNames) {
      expect(current.has(method)).toBe(true);
    }
  });

  it("keeps the released floor method-name set byte-identical to the baseline", () => {
    expect([...RELEASED_FLOOR_METHOD_NAMES].sort()).toEqual(
      [...releasedMethodNames].sort(),
    );
  });

  it("registers every non-floor method with a degrade policy", () => {
    const floorMethods = new Set(RELEASED_FLOOR_METHOD_NAMES);
    const registry = hostRpcRegistry as Readonly<
      Record<string, { readonly degrade?: unknown }>
    >;
    for (const method of Object.keys(hostRpcRegistry)) {
      if (floorMethods.has(method)) {
        continue;
      }
      expect(registry[method].degrade).toBeDefined();
    }
  });
});
