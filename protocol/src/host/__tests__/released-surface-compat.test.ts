import { describe, expect, it } from "vitest";
import { toJsonSchemas } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { releasedSurfaceBaseline } from "./__fixtures__/released-surface.baseline";

/**
 * Released wire-surface guard for the unary `/rpc` handshake contract.
 *
 * The per-method handshake (`compatibility-checker`) is fail-closed: a method
 * name present on only one peer, or a shipped `(method, major, minor)` whose
 * request/response schema changed in place, makes EVERY RPC fail against a peer
 * on the other version. Both happened in `1.0.1-rc.1` against the shipped
 * `host-v1.0.0`:
 *   - `worktree.readScriptsAtRef` was added as a NEW method name; and
 *   - `host.getRateLimitUsage@1.0` gained `accountContext` IN PLACE.
 *
 * `__fixtures__/released-surface.baseline.ts` is the `toJsonSchemas` snapshot of
 * the `host-v1.0.0` registry (regenerate with
 * `protocol/scripts/snapshot-released-surface.ts`). This test freezes that
 * surface so the same class of break can't merge silently again.
 *
 * Allowed without touching the baseline: a NEW `(major, minor)` of an EXISTING
 * method - additive evolution the handshake bridges (this is how
 * `listByWorkspacePaths` and `getRateLimitUsage` grew their `@1.1` lines).
 *
 * NOT allowed without an explicit, reviewed baseline regen (which is itself the
 * record of a coordinated decision to drop older peers): adding or removing a
 * method name, or mutating any shipped `(method, major, minor)` fingerprint.
 *
 * Note: `.strict()` vs non-strict is intentionally invisible here -
 * `toJsonSchemaFingerprint` records only `type`/`properties`/`required`, so
 * relaxing an empty `@1.0` request to allow a newer client's Zod-strip (as
 * `getRateLimitUsage@1.0` does) is a no-op on the wire and on this guard.
 */

type SurfaceLeaf = { readonly request: unknown; readonly response: unknown };
type Surface = Record<string, Record<string, Record<string, SurfaceLeaf>>>;

const current = toJsonSchemas(hostRpcRegistry);
const baseline: Surface = releasedSurfaceBaseline;

/**
 * Order-independent serialization: sorts object keys and array elements before
 * stringifying. A fingerprint's `properties` key order - and the order of its
 * `required` / enum-`values` / union-`variants` arrays - follows Zod
 * field-declaration order, none of which affects the wire shape. Comparing
 * canonical forms makes the guard flag a real add / remove / change while
 * ignoring a benign field reorder of a shipped schema.
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).sort().join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .sort()
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("released wire-surface compatibility (host-v1.0.0)", () => {
  it("keeps the shipped method-name set frozen", () => {
    // A method name only one peer advertises is a fatal handshake mismatch, so
    // the set must match the last release exactly. New capabilities ride a new
    // (major, minor) of an existing method - never a new method name.
    expect(Object.keys(current).sort()).toEqual(Object.keys(baseline).sort());
  });

  it("preserves every shipped (method, major, minor) request/response schema", () => {
    const drift: string[] = [];

    for (const method of Object.keys(baseline)) {
      const currentMajors = current[method];
      if (currentMajors === undefined) {
        drift.push(`${method}: missing from current registry`);
        continue;
      }
      for (const major of Object.keys(baseline[method])) {
        const currentMinors = currentMajors[Number(major)];
        if (currentMinors === undefined) {
          drift.push(`${method}@${major}.x: major line dropped`);
          continue;
        }
        for (const minor of Object.keys(baseline[method][major])) {
          const expected = baseline[method][major][minor];
          const actual = currentMinors[Number(minor)];
          if (actual === undefined) {
            drift.push(`${method}@${major}.${minor}: shipped version dropped`);
            continue;
          }
          if (canonicalize(actual.request) !== canonicalize(expected.request)) {
            drift.push(`${method}@${major}.${minor}: request schema changed`);
          }
          if (
            canonicalize(actual.response) !== canonicalize(expected.response)
          ) {
            drift.push(`${method}@${major}.${minor}: response schema changed`);
          }
        }
      }
    }

    expect(drift).toEqual([]);
  });
});
