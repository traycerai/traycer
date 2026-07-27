import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createActivationJournal,
  type LifecycleActivationJournal,
  type LifecycleTransitionJournal,
  type ProbeMarker,
} from "@traycer-clients/shared/host-lifecycle";
import {
  createTransitionJournalStore,
  createActivationJournalStore,
  readLayer0Frame,
  readLiveProbeContext,
  readLiveProbeContextForServiceLabel,
  readProbeMarker,
  writeProbeMarkerAtomically,
} from "../lifecycle-probe";

// T6: unit tests for the CLI-side probe transport — frame parsing off the
// `stdio[3]` socket (`readLayer0Frame`), the marker read/write round trip,
// and `readLiveProbeContext`'s incumbent-bypass authorization check. Scoped
// to a temp data dir via a mocked `../store/paths` (same pattern as
// `store/__tests__/owned-temp.test.ts`) so nothing here ever touches a real
// `~/.traycer/host` tree.

let scopedRoot = "";

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    hostTransitionJournalPath: () => join(scopedRoot, "transition.json"),
    hostTransitionProbeMarkerPath: () =>
      join(scopedRoot, "transition-probe.json"),
    hostActivationJournalPath: () => join(scopedRoot, "activation.json"),
    hostPendingActivationPath: () =>
      join(scopedRoot, "pending-activation.json"),
    hostSubstratePath: () => join(scopedRoot, "substrate.json"),
    ensureHostHomeDir: async () => scopedRoot,
  };
});

beforeEach(async () => {
  scopedRoot = await mkdtemp(join(tmpdir(), "lifecycle-probe-test-"));
});

afterEach(async () => {
  await rm(scopedRoot, { recursive: true, force: true });
});

function writeFrame(stream: PassThrough, frame: object): void {
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  stream.write(Buffer.concat([header, payload]));
}

describe("readLayer0Frame", () => {
  it("parses a well-formed 'declined' frame delivered in one chunk", async () => {
    const stream = new PassThrough();
    const pending = readLayer0Frame(stream, 1_000);
    writeFrame(stream, {
      attemptId: "a1",
      layer0: "declined",
      incumbentEvidence: {
        kind: "pid-metadata",
        pid: 123,
        hostId: "h1",
        startedAt: "2026-07-27T00:00:00.000Z",
      },
    });
    const result = await pending;
    expect(result).toEqual({
      kind: "frame",
      frame: {
        attemptId: "a1",
        layer0: "declined",
        incumbentEvidence: {
          kind: "pid-metadata",
          pid: 123,
          hostId: "h1",
          startedAt: "2026-07-27T00:00:00.000Z",
        },
      },
    });
  });

  it("parses a frame split across multiple 'data' events (socket coalescing/splitting)", async () => {
    const stream = new PassThrough();
    const pending = readLayer0Frame(stream, 1_000);
    const payload = Buffer.from(
      JSON.stringify({ attemptId: "a2", layer0: "acquired" }),
      "utf8",
    );
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    const whole = Buffer.concat([header, payload]);
    // Split into 3-byte chunks to simulate a socket delivering partial frames.
    for (let offset = 0; offset < whole.length; offset += 3) {
      stream.write(whole.subarray(offset, offset + 3));
      await new Promise((resolveTick) => setImmediate(resolveTick));
    }
    const result = await pending;
    expect(result).toEqual({
      kind: "frame",
      frame: { attemptId: "a2", layer0: "acquired" },
    });
  });

  it("the os-error 'degraded' cause round-trips through the wire format", async () => {
    const stream = new PassThrough();
    const pending = readLayer0Frame(stream, 1_000);
    writeFrame(stream, {
      attemptId: "a3",
      layer0: "degraded",
      cause: {
        kind: "os-error",
        syscall: "flock",
        code: "ENOLCK",
        fsType: "apfs",
      },
      evidence: "kernel lifecycle lock acquisition was not determinable",
    });
    const result = await pending;
    expect(result).toEqual({
      kind: "frame",
      frame: {
        attemptId: "a3",
        layer0: "degraded",
        cause: {
          kind: "os-error",
          syscall: "flock",
          code: "ENOLCK",
          fsType: "apfs",
        },
        evidence: "kernel lifecycle lock acquisition was not determinable",
      },
    });
  });

  it("rejects a 'unavailable' frame - a shape the host has no way to emit must not decode as a verdict", async () => {
    const stream = new PassThrough();
    const pending = readLayer0Frame(stream, 1_000);
    // `unavailable` was a fourth arm carried only by the OSS client's
    // hand-written copy of the host's union; the host emits three. Now that
    // both sides import the declaration from `@traycer/protocol`, a frame
    // claiming this arm is either a corrupted stream or a foreign writer, and
    // either way must leave the probe inconclusive rather than be read as a
    // degraded-but-started verdict.
    writeFrame(stream, {
      attemptId: "a-unavailable",
      layer0: "unavailable",
      cause: "addon-load-failed",
      evidence: "native addon dlopen refused",
    });
    await expect(pending).resolves.toEqual({
      kind: "indeterminate",
      reason: "status-shape-invalid",
    });
  });

  it("parses a degraded network-lock frame without losing its durable diagnosis", async () => {
    const stream = new PassThrough();
    const pending = readLayer0Frame(stream, 1_000);
    writeFrame(stream, {
      attemptId: "a-network",
      layer0: "degraded",
      cause: "fs-unsupported",
      evidence: "known-network filesystem 'nfs'; lock is best-effort",
    });
    await expect(pending).resolves.toEqual({
      kind: "frame",
      frame: {
        attemptId: "a-network",
        layer0: "degraded",
        cause: "fs-unsupported",
        evidence: "known-network filesystem 'nfs'; lock is best-effort",
      },
    });
  });

  it("times out to indeterminate('status-timeout') when nothing is ever written", async () => {
    const stream = new PassThrough();
    const result = await readLayer0Frame(stream, 20);
    expect(result).toEqual({ kind: "indeterminate", reason: "status-timeout" });
  });

  it("stream end with no data => indeterminate('status-eof')", async () => {
    const stream = new PassThrough();
    const pending = readLayer0Frame(stream, 1_000);
    stream.end();
    expect(await pending).toEqual({
      kind: "indeterminate",
      reason: "status-eof",
    });
  });

  it("an invalid length prefix (absurdly large) => indeterminate('status-length-invalid'), never throws", async () => {
    const stream = new PassThrough();
    const pending = readLayer0Frame(stream, 1_000);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(10 * 1024 * 1024, 0); // far beyond MAX_LAYER0_FRAME_BYTES
    stream.write(header);
    expect(await pending).toEqual({
      kind: "indeterminate",
      reason: "status-length-invalid",
    });
  });

  it("malformed JSON payload => indeterminate('status-json-invalid')", async () => {
    const stream = new PassThrough();
    const pending = readLayer0Frame(stream, 1_000);
    const payload = Buffer.from("{not json", "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    stream.write(Buffer.concat([header, payload]));
    expect(await pending).toEqual({
      kind: "indeterminate",
      reason: "status-json-invalid",
    });
  });

  it("a well-formed but unrecognized frame shape => indeterminate('status-shape-invalid')", async () => {
    const stream = new PassThrough();
    const pending = readLayer0Frame(stream, 1_000);
    writeFrame(stream, { attemptId: "a4", layer0: "not-a-real-variant" });
    expect(await pending).toEqual({
      kind: "indeterminate",
      reason: "status-shape-invalid",
    });
  });
});

function baseJournal(
  overrides: Partial<LifecycleTransitionJournal>,
): LifecycleTransitionJournal {
  return {
    v: 1,
    transitionId: "t-1",
    probeNonce: "nonce-1",
    kind: "reclaim",
    from: "raw-fallback",
    to: "smappservice",
    phase: "reclaim-awaiting-probe",
    expectedIdentities: ["ai.traycer.host.fallback"],
    compensation: "reprovision-fallback",
    startedAt: "2026-07-27T00:00:00.000Z",
    probeDeadlineAt: null,
    governor: {
      lastAttemptedBuildId: null,
      lastAttemptedCDHash: null,
      failureClass: null,
      attemptCount: 0,
      nextEligibleAt: null,
      breaker: null,
      lastSustainedHealthAt: null,
    },
    terminal: null,
    ...overrides,
  };
}

function activationJournal(): LifecycleActivationJournal {
  return createActivationJournal({
    fromGeneration: "generation-from",
    toGeneration: "generation-to",
    governor: null,
  });
}

describe("activation journal store — durable temp+rename adapter", () => {
  it("round-trips a valid journal, rejects corruption, and writes/clears pending activation", async () => {
    const store = createActivationJournalStore("dev");
    const journal = activationJournal();

    await store.writeJournal(journal);
    await expect(store.readJournal()).resolves.toEqual({
      kind: "valid",
      journal,
    });

    await writeFile(join(scopedRoot, "activation.json"), "{not json", "utf8");
    await expect(store.readJournal()).resolves.toEqual({
      kind: "invalid",
      reason: "corrupt",
    });

    await store.writePendingActivation({
      toGeneration: "generation-to",
      requestedAt: "2026-07-27T00:00:00.000Z",
      cause: "host-busy",
    });
    await expect(
      readFile(join(scopedRoot, "pending-activation.json"), "utf8"),
    ).resolves.toContain('"toGeneration":"generation-to"');

    await store.clearPendingActivation();
    await expect(
      readFile(join(scopedRoot, "pending-activation.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const NOW = "2026-07-27T00:00:30.000Z";
const PROBE_INPUT = {
  transitionId: "t-1",
  probeNonce: "nonce-1",
  serviceLabel: "ai.traycer.host.fallback",
} as const;

describe("readLiveProbeContext — incumbent-bypass authorization", () => {
  it("returns the context when transitionId, probeNonce, and serviceLabel all match a write-ahead probe journal", async () => {
    const store = createTransitionJournalStore("dev");
    await store.writeJournal(baseJournal({}));

    await expect(
      readLiveProbeContext("dev", PROBE_INPUT, NOW),
    ).resolves.toEqual({
      kind: "authorised",
      context: PROBE_INPUT,
    });
  });

  it("refuses when the journal is a different transitionId", async () => {
    const store = createTransitionJournalStore("dev");
    await store.writeJournal(baseJournal({ transitionId: "t-other" }));

    await expect(
      readLiveProbeContext("dev", PROBE_INPUT, NOW),
    ).resolves.toEqual({
      kind: "unauthorised",
      reason: "transition-id-mismatch",
    });
  });

  it("refuses when the requested serviceLabel is not among expectedIdentities", async () => {
    const store = createTransitionJournalStore("dev");
    await store.writeJournal(baseJournal({}));

    await expect(
      readLiveProbeContext(
        "dev",
        { ...PROBE_INPUT, serviceLabel: "ai.traycer.host.agent" },
        NOW,
      ),
    ).resolves.toEqual({ kind: "unauthorised", reason: "label-not-expected" });
  });

  it("refuses when the journal has already reached a terminal phase ('done') — no live journal, no bypass", async () => {
    const store = createTransitionJournalStore("dev");
    await store.writeJournal(
      baseJournal({
        phase: "done",
        terminal: { outcome: "done", failureClass: null },
      }),
    );

    await expect(
      readLiveProbeContext("dev", PROBE_INPUT, NOW),
    ).resolves.toEqual({
      kind: "unauthorised",
      reason: "phase-not-awaiting-probe",
    });
  });

  it("reports an absent journal as knowledge ('no-journal'), not as ambiguity", async () => {
    await expect(
      readLiveProbeContext("dev", PROBE_INPUT, NOW),
    ).resolves.toEqual({ kind: "unauthorised", reason: "no-journal" });
  });

  it("derives one probe context from the immutable service label at the write-ahead awaiting phase", async () => {
    const store = createTransitionJournalStore("dev");
    await store.writeJournal(baseJournal({}));

    await expect(
      readLiveProbeContextForServiceLabel(
        "dev",
        "ai.traycer.host.fallback",
        NOW,
      ),
    ).resolves.toEqual({ kind: "authorised", context: PROBE_INPUT });
  });

  it("does not authorise a service before the write-ahead awaiting phase", async () => {
    const store = createTransitionJournalStore("dev");
    await store.writeJournal(
      baseJournal({
        phase: "reclaim-probing",
      }),
    );

    await expect(
      readLiveProbeContextForServiceLabel(
        "dev",
        "ai.traycer.host.fallback",
        NOW,
      ),
    ).resolves.toEqual({
      kind: "unauthorised",
      reason: "phase-not-awaiting-probe",
    });
  });
});

// Finding F4. A reclaim interrupted at `reclaim-awaiting-probe` (logout
// between the journal write and the next reconcile) strands the journal at
// that phase, and recovery is trigger-bounded, so nothing clears it. Without
// this bound, every login-time `host start --service-label <label>` re-enters
// probe mode -- which skips `findIncumbentHost` entirely -- and stacks
// another supervisor onto the live fallback host, forever. `probeDeadlineAt`
// is written in the SAME write that records the phase precisely to stop that;
// the reconciler enforced it, the login-time path (the one that grants the
// bypass) did not.
describe("probe authority is bounded by probeDeadlineAt", () => {
  const DEADLINE = "2026-07-27T00:01:00.000Z";

  it("authorises before the deadline", async () => {
    const store = createTransitionJournalStore("dev");
    await store.writeJournal(baseJournal({ probeDeadlineAt: DEADLINE }));

    await expect(
      readLiveProbeContextForServiceLabel(
        "dev",
        "ai.traycer.host.fallback",
        "2026-07-27T00:00:59.999Z",
      ),
    ).resolves.toMatchObject({ kind: "authorised" });
  });

  it("refuses AT the deadline, matching the reconciler's `now >= probeDeadlineAt` comparator exactly", async () => {
    const store = createTransitionJournalStore("dev");
    await store.writeJournal(baseJournal({ probeDeadlineAt: DEADLINE }));

    await expect(
      readLiveProbeContextForServiceLabel(
        "dev",
        "ai.traycer.host.fallback",
        DEADLINE,
      ),
    ).resolves.toEqual({
      kind: "unauthorised",
      reason: "probe-deadline-elapsed",
    });
  });

  it("refuses a stale awaiting-probe journal at a much later login, so the incumbent check is never skipped again", async () => {
    const store = createTransitionJournalStore("dev");
    await store.writeJournal(baseJournal({ probeDeadlineAt: DEADLINE }));

    await expect(
      readLiveProbeContextForServiceLabel(
        "dev",
        "ai.traycer.host.fallback",
        "2026-08-01T09:00:00.000Z",
      ),
    ).resolves.toEqual({
      kind: "unauthorised",
      reason: "probe-deadline-elapsed",
    });
    // The same stale journal via the explicit-context entrypoint, which is
    // the one a re-invoked probe supervisor uses.
    await expect(
      readLiveProbeContext("dev", PROBE_INPUT, "2026-08-01T09:00:00.000Z"),
    ).resolves.toEqual({
      kind: "unauthorised",
      reason: "probe-deadline-elapsed",
    });
  });

  it("leaves an unbounded journal (probeDeadlineAt: null) authorised — the bound is the field, not a default", async () => {
    const store = createTransitionJournalStore("dev");
    await store.writeJournal(baseJournal({ probeDeadlineAt: null }));

    await expect(
      readLiveProbeContextForServiceLabel(
        "dev",
        "ai.traycer.host.fallback",
        "2099-01-01T00:00:00.000Z",
      ),
    ).resolves.toMatchObject({ kind: "authorised" });
  });
});

// Finding F6. The CLI used to hand-roll a second `transition.json` parser
// that returned `T | null`, so a journal written by a NEWER desktop (v2) was
// indistinguishable from no journal and from corrupt bytes: the probe simply
// never ran, with no diagnosis anywhere. The plan is explicit that no boolean
// may collapse "could not know" into a value.
describe("journal decode keeps the evidence algebra intact", () => {
  it("distinguishes a newer schema version from an absent journal", async () => {
    await writeFile(
      join(scopedRoot, "transition.json"),
      JSON.stringify({ ...baseJournal({}), v: 2 }),
      "utf8",
    );

    await expect(
      readLiveProbeContextForServiceLabel(
        "dev",
        "ai.traycer.host.fallback",
        NOW,
      ),
    ).resolves.toEqual({
      kind: "indeterminate",
      cause: "journal-version-2",
    });
    await expect(
      createTransitionJournalStore("dev").readJournal(),
    ).resolves.toEqual({ kind: "invalid", reason: "unsupported-version: 2" });
  });

  it("distinguishes corrupt bytes from an absent journal", async () => {
    await writeFile(join(scopedRoot, "transition.json"), "{not json", "utf8");

    await expect(
      readLiveProbeContextForServiceLabel(
        "dev",
        "ai.traycer.host.fallback",
        NOW,
      ),
    ).resolves.toEqual({ kind: "indeterminate", cause: "corrupt" });
    await expect(
      createTransitionJournalStore("dev").readJournal(),
    ).resolves.toEqual({ kind: "invalid", reason: "corrupt" });
  });

  it("a valid v1 journal still round-trips through the shared decoder unchanged", async () => {
    const store = createTransitionJournalStore("dev");
    const journal = baseJournal({
      probeDeadlineAt: "2026-07-27T00:01:00.000Z",
    });
    await store.writeJournal(journal);

    await expect(store.readJournal()).resolves.toEqual({
      kind: "valid",
      journal,
    });
  });
});

function marker(overrides: Partial<ProbeMarker>): ProbeMarker {
  return {
    v: 1,
    transitionId: "t-1",
    probeNonce: "nonce-1",
    serviceLabel: "ai.traycer.host.fallback",
    supervisorPid: 5001,
    attestation: {
      serviceLabel: "ai.traycer.host.fallback",
      supervisorPid: 5001,
      capturedAt: "2026-07-27T00:00:01.000Z",
    },
    outcome: { kind: "terminal", reason: "probe-terminal" },
    ...overrides,
  };
}

describe("probe marker atomic write + read round trip", () => {
  it("writes and reads back an identical marker", async () => {
    await writeProbeMarkerAtomically("dev", marker({}));
    const readBack = await readProbeMarker("dev");
    expect(readBack).toEqual(marker({}));
  });

  it("returns null when no marker file exists", async () => {
    const readBack = await readProbeMarker("dev");
    expect(readBack).toBeNull();
  });

  it("round-trips an awaiting marker with its Layer 0 degradation diagnosis", async () => {
    const degradedMarker = marker({
      outcome: {
        kind: "awaiting-readiness",
        attemptId: "attempt-network",
        degradation: {
          cause: "fs-unsupported",
          evidence: "known-network filesystem 'nfs'; lock is best-effort",
        },
      },
    });
    await writeProbeMarkerAtomically("dev", degradedMarker);
    await expect(readProbeMarker("dev")).resolves.toEqual(degradedMarker);
  });

  it("returns null for a corrupt marker file rather than throwing", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(scopedRoot, { recursive: true });
    await writeFile(
      join(scopedRoot, "transition-probe.json"),
      "{not json",
      "utf8",
    );
    const readBack = await readProbeMarker("dev");
    expect(readBack).toBeNull();
  });

  it("a subsequent write fully replaces the prior marker (temp+rename, no merge)", async () => {
    await writeProbeMarkerAtomically(
      "dev",
      marker({ outcome: { kind: "terminal", reason: "first" } }),
    );
    await writeProbeMarkerAtomically(
      "dev",
      marker({ outcome: { kind: "terminal", reason: "second" } }),
    );
    const readBack = await readProbeMarker("dev");
    expect(readBack?.outcome).toEqual({ kind: "terminal", reason: "second" });
  });
});
