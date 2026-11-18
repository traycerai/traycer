import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CLI side: `serveMaintenanceLease`'s
// request handler (`host-maintenance-lease.ts:289-296`) catches EVERY error
// thrown while dispatching an `execute-root` request - including one from
// `superviseRootMaintenanceExecutor` rejecting with
// `maintenance executor exited (1, none)` (lines 616-629) for an actuator
// (D) that threw AFTER it had already been dispatched and may have mutated
// the install - and wraps it in exactly the same envelope,
// `kind: "refused"`, as a PRE-dispatch decline (an admission check failing
// before anything ran). The internal script's `executeRoot`
// (`desktop-install-cloud.js` ~4617-4626) reads only `response.kind ===
// "refused"` and always logs "the lease was established and nothing was
// executed" - a claim this envelope cannot support once dispatch has
// actually happened.
//
// `serveMaintenanceLease` is module-private (same as the completion suite
// above in this directory), so this is the same style of source-order pin:
// asserting the catch block that turns a dispatch error into a wire
// response does not collapse a post-dispatch failure into the identical
// `kind: "refused"` shape a pre-dispatch decline also produces.
const LEASE_SOURCE = readFileSync(
  new URL("../host-maintenance-lease.ts", import.meta.url),
  "utf8",
);

describe("serveMaintenanceLease distinguishes a post-dispatch actuator failure from a pre-dispatch refusal", () => {
  it('the execute-root dispatch catch does not answer every error with the same bare kind: "refused"', () => {
    const serveFn = LEASE_SOURCE.slice(
      LEASE_SOURCE.indexOf("async function serveMaintenanceLease("),
      LEASE_SOURCE.indexOf("async function superviseRootMaintenanceExecutor("),
    );
    expect(serveFn.length).toBeGreaterThan(200);

    const catchIdx = serveFn.indexOf("} catch (err) {");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBody = serveFn.slice(catchIdx, catchIdx + 300);

    // Today, every error - whether the executor never ran or it ran and
    // failed afterward - is written back as the identical
    // `kind: "refused"` envelope. A post-dispatch failure must be
    // distinguishable from a pre-dispatch refusal so the internal script's
    // "nothing was executed" claim is not made about work that may have run.
    expect(catchBody).not.toMatch(/kind:\s*"refused"/);
  });
});
