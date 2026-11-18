import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomically } from "../lifecycle-probe";

// T6: journal write ATOMICITY, demonstrated against the REAL N4 primitive
// (`writeJsonAtomically`, the one function `createTransitionJournalStore`
// uses for every `writeJournal`/`writeSubstrate` call — phase and governor
// travel in the same `LifecycleTransitionJournal` object, so a single call
// to this function is what makes "one temp+rename commits both" true).
//
// SCOPE, stated plainly because this file was previously named
// "…-ordering-guard" and tested no ordering at all: everything here is about
// a SINGLE write being all-or-nothing. It would not notice a `writeJournal`
// call moved to AFTER the mutation it must precede — that is the write-ahead
// invariant (I5/N4), and it lives in
// `lifecycle-probe-journal-write-ahead-ordering.test.ts`.
//
// Two things are proven:
//  1. The real writer never leaves a torn/partial file on disk, even when
//     interrupted (simulated crash) right before the commit-visible rename.
//  2. A REFERENCE two-step writer this test file owns (NOT production code —
//     no such writer exists in `lifecycle-probe.ts`) demonstrably DOES leave
//     a torn file under the equivalent crash timing — proving the
//     atomicity property the real writer has is load-bearing, not
//     incidental, and that this guard would catch a regression back to the
//     two-step class rev 3 rejected ("two separate files cannot be updated
//     atomically").

const mocks = vi.hoisted(() => ({ crashOnNextRename: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ) => {
      if (mocks.crashOnNextRename) {
        mocks.crashOnNextRename = false;
        throw new Error("SIMULATED_CRASH_BEFORE_RENAME");
      }
      return actual.rename(from, to);
    },
  };
});

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "journal-atomicity-"));
  mocks.crashOnNextRename = false;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type JournalSnapshot = {
  readonly phase: string;
  readonly governor: {
    readonly attemptCount: number;
    readonly breaker: string | null;
  };
};

const SNAPSHOT: JournalSnapshot = {
  phase: "fallback-evicting-agent",
  governor: { attemptCount: 3, breaker: "tripped" },
};

describe("writeJsonAtomically (real N4 writer) under a simulated crash before rename", () => {
  it("leaves NO file at all when interrupted before the commit-visible rename — never a torn phase-without-governor shape", async () => {
    const destination = join(dir, "transition.json");
    mocks.crashOnNextRename = true;
    await expect(writeJsonAtomically(destination, SNAPSHOT)).rejects.toThrow(
      "SIMULATED_CRASH_BEFORE_RENAME",
    );

    const readBack = await readFile(destination, "utf8").catch(() => null);
    expect(readBack).toBeNull();
  });

  it("cleans up its own temp file on the crash path — no leftover partial artifact for a reader to mistake for the journal", async () => {
    const destination = join(dir, "transition.json");
    mocks.crashOnNextRename = true;
    await expect(writeJsonAtomically(destination, SNAPSHOT)).rejects.toThrow();

    const entries = await readdir(dir);
    expect(entries).toEqual([]);
  });

  it("on an uninterrupted write, commits phase and governor together in one visible file", async () => {
    const destination = join(dir, "transition.json");
    await writeJsonAtomically(destination, SNAPSHOT);
    const readBack = JSON.parse(
      await readFile(destination, "utf8"),
    ) as JournalSnapshot;
    expect(readBack).toEqual(SNAPSHOT);
  });

  it("a second write fully replaces the first — no merge/append artifact from the temp-file scheme", async () => {
    const destination = join(dir, "transition.json");
    await writeJsonAtomically(destination, SNAPSHOT);
    const advanced: JournalSnapshot = {
      phase: "fallback-committing",
      governor: { attemptCount: 3, breaker: "tripped" },
    };
    await writeJsonAtomically(destination, advanced);
    const readBack = JSON.parse(
      await readFile(destination, "utf8"),
    ) as JournalSnapshot;
    expect(readBack).toEqual(advanced);
    const entries = await readdir(dir);
    expect(entries).toEqual(["transition.json"]);
  });
});

/**
 * Reference BROKEN writer this test file owns for contrast only — commits
 * phase and governor as two independent writes to the same destination, the
 * exact pattern N4 exists to rule out. Not exported; exists solely to prove
 * the failure mode the real writer avoids is real and observable, not a
 * strawman.
 *
 * Split into its two steps so the crash case below can interrupt THIS writer
 * between them. The crash case previously re-implemented step one inline and
 * then asserted the file it had just written existed, which demonstrated only
 * that writing a file and throwing leaves that file — it never exercised
 * `brokenTwoStepWrite` at all.
 */
async function brokenWriteStepOne(
  destination: string,
  snapshot: JournalSnapshot,
): Promise<void> {
  await writeFile(
    destination,
    JSON.stringify({ phase: snapshot.phase, governor: null }),
    "utf8",
  );
}

async function brokenWriteStepTwo(
  destination: string,
  snapshot: JournalSnapshot,
): Promise<void> {
  await writeFile(destination, JSON.stringify(snapshot), "utf8");
}

/**
 * Step two is injected so the crash case interrupts THIS writer rather than a
 * hand-rolled copy of its first half: both cases below run the same function,
 * differing only in whether step two completes or dies.
 */
async function brokenTwoStepWrite(
  destination: string,
  snapshot: JournalSnapshot,
  stepTwo: (destination: string, snapshot: JournalSnapshot) => Promise<void>,
): Promise<void> {
  await brokenWriteStepOne(destination, snapshot);
  await stepTwo(destination, snapshot);
}

const crashBeforeStepTwo = async (): Promise<void> => {
  throw new Error("SIMULATED_CRASH_BETWEEN_WRITES");
};

describe("reference broken two-step writer (test-owned contrast, not production code)", () => {
  it("a crash between its two writes leaves the phase advanced with the governor delta LOST — the ping-pong hazard N4 rules out", async () => {
    const destination = join(dir, "broken-transition.json");
    await expect(
      brokenTwoStepWrite(destination, SNAPSHOT, crashBeforeStepTwo),
    ).rejects.toThrow("SIMULATED_CRASH_BETWEEN_WRITES");

    const readBack = JSON.parse(
      await readFile(destination, "utf8"),
    ) as JournalSnapshot;
    // This is the defect made observable: phase reads as already-advanced,
    // but the governor delta that should have traveled with it (the
    // breaker that would prevent an immediate re-attempt) never arrived.
    expect(readBack.phase).toBe(SNAPSHOT.phase);
    expect(readBack.governor).toBeNull();
    expect(readBack.governor).not.toEqual(SNAPSHOT.governor);
  });

  it("with no crash, the broken writer still eventually commits both fields (the hazard is crash-window-dependent, not always visible)", async () => {
    const destination = join(dir, "broken-transition-no-crash.json");
    await brokenTwoStepWrite(destination, SNAPSHOT, brokenWriteStepTwo);
    const readBack = JSON.parse(
      await readFile(destination, "utf8"),
    ) as JournalSnapshot;
    expect(readBack).toEqual(SNAPSHOT);
  });

  it("the real writer, interrupted at the SAME point, leaves nothing at all — the contrast that makes the above meaningful", async () => {
    const broken = join(dir, "contrast-broken.json");
    const real = join(dir, "contrast-real.json");
    await expect(
      brokenTwoStepWrite(broken, SNAPSHOT, crashBeforeStepTwo),
    ).rejects.toThrow();
    mocks.crashOnNextRename = true;
    await expect(writeJsonAtomically(real, SNAPSHOT)).rejects.toThrow();

    // Same interruption, two outcomes: a half-committed record versus none.
    expect(await readFile(broken, "utf8").catch(() => null)).not.toBeNull();
    expect(await readFile(real, "utf8").catch(() => null)).toBeNull();
  });
});
