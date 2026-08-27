import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// TWO SOURCE-ORDER SUITES AND ONE BEHAVIOURAL ONE, labelled so the difference
// is not something a reader has to infer.
//
// `superviseRootMaintenanceExecutor` is module-private and its completion
// bookkeeping only becomes observable by spawning a real supervisor process
// that spawns a real detached actuator. Standing that up would be a new test
// harness around privileged process-group machinery — more new surface than
// the defect it guards, in a round whose point is convergence. So the
// completion-sentinel property below is pinned as SOURCE TEXT: it would not
// catch a behavioural regression arriving by another route, and is not offered
// as though it would.
//
// `assertPathHelpersBoundToTarget` is different: it is a pure function of the
// environment and the filesystem, so its guard is exercised for real at the
// bottom of this file.
const LEASE_SOURCE = readFileSync(
  join(import.meta.dirname, "..", "host-maintenance-lease.ts"),
  "utf8",
);

describe("root maintenance executor completion is a box, not a value sentinel", () => {
  const supervisor = LEASE_SOURCE.slice(
    LEASE_SOURCE.indexOf("async function superviseRootMaintenanceExecutor("),
    LEASE_SOURCE.indexOf("async function executeAction("),
  );

  it("slices a non-empty supervisor body (guards both indexOf anchors)", () => {
    expect(supervisor.length).toBeGreaterThan(500);
    expect(supervisor).toContain("const finish =");
    expect(supervisor).toContain('child.once("close"');
  });

  it("never uses `undefined` to mean 'no completion frame arrived'", () => {
    // `JSON.stringify({ value: undefined })` drops the key, so an executor that
    // completes with nothing sends exactly the shape the old sentinel read as
    // "never completed" — and a clean exit 0 was then reported as
    // `maintenance executor exited (0, none)`.
    expect(supervisor).not.toMatch(/completedValue\s*!==\s*undefined/);
    expect(supervisor).not.toMatch(/completedValue/);
  });

  it("boxes the completion and tests the box for null", () => {
    expect(supervisor).toMatch(
      /let completed: \{ readonly value: unknown \} \| null = null;/,
    );
    expect(supervisor).toMatch(/completed = \{ value \};/);
    expect(supervisor).toMatch(/completion !== null && event\.code === 0/);
    // Resolving `completion.value` rather than the box is what keeps an
    // actuator's own `null` — the Linux platform install's "left for the
    // developer to install by hand" — reaching the caller intact.
    expect(supervisor).toMatch(/resolve\(completion\.value\)/);
  });

  it("subscribes to close/error before the first await — Node emits them once, never replayed", () => {
    // The defect this guards: with the first subscription sitting AFTER the
    // liveness rebind (a filesystem round trip), an executor that failed to
    // exec, or died immediately, could emit `error`/`close` into no listener
    // at all before the subscription landed — the `error` became an uncaught
    // event that killed this process mid-lease.
    const errorIdx = supervisor.indexOf('child.once("error"');
    const closeIdx = supervisor.indexOf('child.once("close"');
    const stdinErrorIdx = supervisor.indexOf('child.stdin.on("error"');
    const firstAwaitIdx = supervisor.indexOf(
      "await rebindUpdateMutationCapabilityLiveness",
    );
    expect(errorIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(-1);
    expect(stdinErrorIdx).toBeGreaterThan(-1);
    expect(firstAwaitIdx).toBeGreaterThan(-1);
    expect(errorIdx).toBeLessThan(firstAwaitIdx);
    expect(closeIdx).toBeLessThan(firstAwaitIdx);
    expect(stdinErrorIdx).toBeLessThan(firstAwaitIdx);
  });

  it("reconciles an early death once the promise body owns settlement", () => {
    // The executor can have terminated while the liveness rebind above was in
    // flight; nothing between the subscriptions and this point could act on
    // that evidence, so the promise body re-checks it once it is the thing
    // holding `onTermination`.
    expect(supervisor).toContain("if (termination !== null) onTermination();");
  });

  it("recordTermination keeps only the first evidence", () => {
    // A failed spawn emits `error` and then `close`; the error names the
    // cause while that close would otherwise overwrite it with a bare null
    // code. Guard must live INSIDE `recordTermination`, not merely somewhere
    // in the file.
    const recordIdx = supervisor.indexOf("const recordTermination =");
    const nextEventSubscriptionIdx = supervisor.indexOf('child.once("error"');
    expect(recordIdx).toBeGreaterThan(-1);
    expect(nextEventSubscriptionIdx).toBeGreaterThan(recordIdx);
    const guardIdx = supervisor.indexOf("if (termination !== null) return;");
    expect(guardIdx).toBeGreaterThan(recordIdx);
    expect(guardIdx).toBeLessThan(nextEventSubscriptionIdx);
  });
});

describe("assertPathHelpersBoundToTarget", () => {
  // Behavioural, via the module's public entry point. The guard runs before
  // anything else in `runHostMaintenanceLease`, so a refusal surfaces as a
  // rejected promise with nothing else having happened.
  const SEALED = "TRAYCER_ROOT_MAINTENANCE_HOME";

  async function runLease(sealed: string | undefined): Promise<unknown> {
    const previous = process.env[SEALED];
    if (sealed === undefined) delete process.env[SEALED];
    else process.env[SEALED] = sealed;
    try {
      const { runHostMaintenanceLease } =
        await import("../host-maintenance-lease");
      return await runHostMaintenanceLease(
        "production",
        "uninstall-maintenance",
        {
          hostHomeDir: "/nonexistent-probe-home/.traycer/host",
          serviceUid: 0,
        },
      ).then(
        () => null,
        (error: unknown) => error,
      );
    } finally {
      if (previous === undefined) delete process.env[SEALED];
      else process.env[SEALED] = previous;
    }
  }

  it("refuses when the sealed target names a different account than the path helpers resolve", async () => {
    // A directory that exists (so `realpathSync` succeeds) but is not this
    // process's home — the win32 shape, where `os.homedir()` ignores the `HOME`
    // the root script sets and the binding silently does not take.
    const error = await runLease("/tmp");
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/different account|sealed target/);
  });

  it("refuses rather than proceeds when the sealed target cannot be canonicalized", async () => {
    const error = await runLease("/nonexistent-sealed-home-probe");
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /could not confirm its target home/,
    );
  });

  it("does NOT refuse an ordinary invocation with no sealed target", async () => {
    // The positive control, and the one that matters most: the guard is scoped
    // to the root-script path. An unscoped refusal would break every ordinary
    // `host maintenance-lease` call, and the two assertions above would still
    // pass.
    const error = await runLease(undefined);
    if (error instanceof Error) {
      expect(error.message).not.toMatch(
        /different account|sealed target|could not confirm its target home/,
      );
    }
  });
});
