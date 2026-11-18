/**
 * Writer-driven holder conformance (design §1.5, the drift guard for the
 * whole lock-holder projection). This is deliberately NOT a hand-written
 * fixture: it acquires a REAL `update-attempt.lock` through the production
 * acquisition path, reads back the bytes that path actually wrote, feeds
 * them through `parseAttemptLockHolder`, and asserts field-for-field
 * agreement with the `LockMetadata` the lock handle exposes. A rename in the
 * lock format then fails THIS test, instead of silently degrading every
 * reader (host included) to permanent `indeterminate`.
 *
 * Cold-review F6: the identity/start-time assertions must be non-vacuous.
 * `null === null` proves nothing about a parser that read a misspelled or
 * removed key, so the identity case below forces a deterministic non-null
 * value (the writer records `process.pid`'s own stamp, and the test process
 * is by definition alive) rather than accepting whatever the platform probe
 * happened to return. Supplemental liveness (`supervisedProcessGroupId`,
 * `retainOnPublisherDeath`) is driven through the real rebind path so drift
 * in either key is caught too, including the plain-vs-supplemental branch
 * those fields select.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseAttemptLockHolder,
  attemptHolderUsesPlainIdentityProbe,
  type AttemptLockHolder,
} from "@traycer/protocol/config/host-update-attempt-liveness";
import {
  acquireUpdateAttemptLock,
  type UpdateAttemptLockHandle,
} from "../lock";
import {
  rebindUpdateMutationCapabilityLiveness,
  withUpdateContender,
} from "../contender";
import { updateAttemptLockPath } from "../paths";

const dirs: string[] = [];
const handles: UpdateAttemptLockHandle[] = [];

afterEach(async () => {
  await Promise.all(
    handles.splice(0).map((handle) => handle.release().catch(() => undefined)),
  );
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "holder-conformance-"));
  dirs.push(dir);
  return dir;
}

describe("parseAttemptLockHolder vs the real writer's LockMetadata", () => {
  it("recovers every identity field the production acquisition path wrote, verbatim", async () => {
    const dir = await freshDir();
    const acquired = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "holder-conformance-test",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    handles.push(acquired.handle);

    const bytes = await readFile(acquired.handle.path, "utf8");
    const holder = parseAttemptLockHolder(bytes);
    expect(holder).not.toBeNull();
    if (holder === null) return;

    const metadata = acquired.handle.metadata;

    // Field-for-field agreement with the LockMetadata the writer's own
    // handle exposes — not a fixture's idea of what it should have written.
    expect(holder.pid).toBe(metadata.pid);
    expect(holder.token).toBe(metadata.token);

    // `supervisedProcessGroupId: undefined` on the writer's metadata maps to
    // `null` on the reader's projection — absence stated as a fact, not
    // omitted as a key.
    expect(metadata.supervisedProcessGroupId).toBeUndefined();
    expect(holder.supervisedProcessGroupId).toBeNull();

    // `retainOnPublisherDeath` absent on the writer's metadata maps to
    // `false` on the reader's projection.
    expect(metadata.retainOnPublisherDeath).toBeUndefined();
    expect(holder.retainOnPublisherDeath).toBe(false);

    // An ordinary acquisition (no supervised group, no retain flag) must be
    // judgeable by the plain publisher-identity probe.
    expect(attemptHolderUsesPlainIdentityProbe(holder)).toBe(true);
  });

  it("recovers process.pid's own identity stamp verbatim — deterministic, not null===null", async (ctx) => {
    const dir = await freshDir();
    const acquired = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "holder-conformance-identity",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    handles.push(acquired.handle);

    const metadata = acquired.handle.metadata;
    // The writer stamped THIS process — the one running the test — so a
    // failure here means the platform's own start-identity probe could not
    // read its own creation stamp. That is the one case the design calls a
    // supported outcome; every other outcome must be exact.
    if (
      metadata.processStartIdentity === null ||
      metadata.processStartedAtMs === null
    ) {
      ctx.skip();
      return;
    }

    const bytes = await readFile(acquired.handle.path, "utf8");
    const holder = parseAttemptLockHolder(bytes);
    expect(holder).not.toBeNull();
    if (holder === null) return;

    // Non-vacuous: both sides are guaranteed non-null past the skip guard
    // above, so this is an exact string/number comparison, not
    // `null === null`. A parser reading a misspelled or removed key would
    // fail here.
    expect(typeof holder.processStartIdentity).toBe("string");
    expect(holder.processStartIdentity).toBe(metadata.processStartIdentity);
    expect(typeof holder.processStartedAtMs).toBe("number");
    expect(holder.processStartedAtMs).toBe(metadata.processStartedAtMs);
  });

  it("pid and token from a second, independent acquisition also agree field-for-field", async () => {
    const dir = await freshDir();
    const acquired = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "holder-conformance-test-second",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    handles.push(acquired.handle);

    const bytes = await readFile(acquired.handle.path, "utf8");
    const holder = parseAttemptLockHolder(bytes);
    expect(holder).not.toBeNull();
    if (holder === null) return;

    expect(holder.pid).toBe(process.pid);
    expect(holder.token).toBe(acquired.handle.metadata.token);
    expect(typeof holder.token).toBe("string");
  });

  it("a populated supplemental-liveness rebind survives the parser and flips the plain-probe branch", async () => {
    const dir = await freshDir();
    let capturedHolder: AttemptLockHolder | null = null;

    // Drives the REAL rebind path a supervisor uses to publish supplemental
    // liveness, rather than hand-writing a lock file with these keys. A
    // rename of either key in the writer breaks this test instead of
    // silently degrading every reader to the conservative supplemental arm
    // (or worse, the wrong one).
    const outcome = await withUpdateContender(
      {
        hostHomeDir: dir,
        reason: "holder-conformance-supplemental",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "legacy-update-shadow",
      },
      async (capability) => {
        await rebindUpdateMutationCapabilityLiveness(capability, process.pid, {
          // The test process's own pid is a stand-in "detached group" id —
          // valid shape-wise (a positive safe integer), which is all the
          // parser or the plain-vs-supplemental branch inspects.
          supervisedProcessGroupId: process.pid,
          retainOnPublisherDeath: true,
        });
        const bytes = await readFile(updateAttemptLockPath(dir), "utf8");
        capturedHolder = parseAttemptLockHolder(bytes);
        return "checked";
      },
    );

    expect(outcome).toEqual({ kind: "ran", result: "checked" });
    expect(capturedHolder).not.toBeNull();
    if (capturedHolder === null) return;
    const holder: AttemptLockHolder = capturedHolder;
    expect(holder.supervisedProcessGroupId).toBe(process.pid);
    expect(holder.retainOnPublisherDeath).toBe(true);
    // The populated branch must flip the plain-vs-supplemental decision —
    // this is the arm that routes a projection to `indeterminate` instead
    // of judging liveness by the publisher's identity alone. An unprotected
    // key here would silently change interruption decisions.
    expect(attemptHolderUsesPlainIdentityProbe(holder)).toBe(false);
  });

  // Release must key retention on the OUTSTANDING PUBLICATION, never on the
  // publisher's pid. The rule previously read `current.pid !== meta.pid && (
  // group || retain)`, where the pid comparison stood in for "the publication
  // has not been handed back yet". That proxy held only while a supervising
  // parent never published its own pid mid-session. The maintenance lease now
  // does exactly that - it publishes the executing process across an
  // in-process action - so a handback that fails before its rename leaves the
  // parent published with the group flags still set, and the pid-keyed rule
  // then UNLINKED a lock whose actuator group was still alive.
  const lockExists = async (dir: string): Promise<boolean> => {
    try {
      await readFile(updateAttemptLockPath(dir), "utf8");
      return true;
    } catch {
      return false;
    }
  };

  it("retains the lock on release when the group publication is outstanding, even though the publisher IS the acquiring process", async () => {
    const dir = await freshDir();
    const outcome = await withUpdateContender(
      {
        hostHomeDir: dir,
        reason: "holder-conformance-retain-self-published",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "legacy-update-shadow",
      },
      async (capability) => {
        // Publisher == this process (what the lease's in-process swap does),
        // AND the supervised group is still bound. This is the combination the
        // old pid-keyed rule could not represent.
        await rebindUpdateMutationCapabilityLiveness(capability, process.pid, {
          supervisedProcessGroupId: process.pid,
          retainOnPublisherDeath: true,
        });
        return "published";
      },
    );
    expect(outcome).toEqual({ kind: "ran", result: "published" });
    // The contender's `finally` has already run its release by here.
    expect(await lockExists(dir)).toBe(true);
  });

  it("CONTROL: releases normally once the publication is handed back empty", async () => {
    // The control that keeps the assertion above from being vacuous: release
    // DOES unlink on the ordinary path, so a surviving file there is the
    // retention rule firing and not release being inert in this rig. An empty
    // publication is exactly what `restoreHolder` writes at clean completion.
    const dir = await freshDir();
    const outcome = await withUpdateContender(
      {
        hostHomeDir: dir,
        reason: "holder-conformance-release-after-handback",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "legacy-update-shadow",
      },
      async (capability) => {
        await rebindUpdateMutationCapabilityLiveness(capability, process.pid, {
          supervisedProcessGroupId: process.pid,
          retainOnPublisherDeath: true,
        });
        // Hand back: clears both flags, which is what authorizes release.
        await rebindUpdateMutationCapabilityLiveness(
          capability,
          process.pid,
          {},
        );
        return "handed-back";
      },
    );
    expect(outcome).toEqual({ kind: "ran", result: "handed-back" });
    expect(await lockExists(dir)).toBe(false);
  });

  it("supplemental liveness absent (the common case) keeps the plain-probe branch — the control for the case above", async () => {
    const dir = await freshDir();
    let capturedHolder: AttemptLockHolder | null = null;

    const outcome = await withUpdateContender(
      {
        hostHomeDir: dir,
        reason: "holder-conformance-plain-control",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "legacy-update-shadow",
      },
      async (capability) => {
        await rebindUpdateMutationCapabilityLiveness(
          capability,
          process.pid,
          {},
        );
        const bytes = await readFile(updateAttemptLockPath(dir), "utf8");
        capturedHolder = parseAttemptLockHolder(bytes);
        return "checked";
      },
    );

    expect(outcome).toEqual({ kind: "ran", result: "checked" });
    expect(capturedHolder).not.toBeNull();
    if (capturedHolder === null) return;
    const holder: AttemptLockHolder = capturedHolder;
    expect(holder.supervisedProcessGroupId).toBeNull();
    expect(holder.retainOnPublisherDeath).toBe(false);
    expect(attemptHolderUsesPlainIdentityProbe(holder)).toBe(true);
  });
});
