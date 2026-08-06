import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stop intent is the ONE thing standing between the supervisor's relaunch loop
// and it resurrecting a host the user just stopped. Its correctness is mostly
// about biases, and they are deliberately asymmetric:
//
//   - a false "intent present" leaves the machine with NO host (the crash goes
//     unrecovered), so a torn/garbled/unknown record must read as ABSENT;
//   - a false "intent absent" costs one unwanted relaunch, which the
//     supervisor's budget and incumbent re-check then contain.
//
// Same direction as `findLiveIncumbentHost`: never strand the machine hostless.

const mocks = vi.hoisted(() => ({
  hostHome: { current: "" },
}));

vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  return {
    ...actual,
    hostStopIntentPath: () => join(mocks.hostHome.current, "stop-intent.json"),
  };
});

const {
  STOP_INTENT_STALE_MS,
  clearStopIntent,
  hasActionableStopIntent,
  hasFreshStopIntent,
  isStopIntentAlreadyServed,
  isStopIntentFresh,
  readStopIntent,
  writeStopIntent,
} = await import("../stop-intent");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "traycer-stop-intent-"));
  mocks.hostHome.current = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const intentPath = (): string => join(dir, "stop-intent.json");

describe("writeStopIntent", () => {
  it("records the reason and the requesting pid", async () => {
    await writeStopIntent("production", "install-swap");

    const intent = await readStopIntent("production");
    expect(intent).not.toBeNull();
    expect(intent?.reason).toBe("install-swap");
    expect(intent?.requestedByPid).toBe(process.pid);
    expect(intent?.v).toBe(1);
    expect(Number.isNaN(Date.parse(intent?.requestedAt ?? ""))).toBe(false);
  });

  it("reports failure instead of throwing when the destination cannot be written", async () => {
    // Point the path at a location whose parent is a FILE, so the atomic
    // write's mkdir fails.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    mocks.hostHome.current = join(blocker, "nested");

    // Not a throw - the caller decides what an unrecorded intent means, and
    // that answer is platform-dependent. But it must not read as success:
    // on win32 this record is the only thing that stops the supervisor
    // relaunching the host the caller is about to kill.
    await expect(writeStopIntent("production", "stop")).resolves.toBe(false);
  });

  it("reports success when the record lands", async () => {
    await expect(writeStopIntent("production", "stop")).resolves.toBe(true);
  });
});

describe("readStopIntent", () => {
  it("returns null when no intent has been recorded", async () => {
    await expect(readStopIntent("production")).resolves.toBeNull();
  });

  it("returns null for a torn write rather than guessing", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(intentPath(), '{"v":1,"requested', "utf8");

    await expect(readStopIntent("production")).resolves.toBeNull();
  });

  it.each([
    [
      "a future schema version",
      {
        v: 2,
        requestedAt: new Date().toISOString(),
        requestedByPid: 1,
        reason: "stop",
      },
    ],
    [
      "an unknown reason",
      {
        v: 1,
        requestedAt: new Date().toISOString(),
        requestedByPid: 1,
        reason: "because",
      },
    ],
    ["a missing timestamp", { v: 1, requestedByPid: 1, reason: "stop" }],
    [
      "a non-numeric pid",
      {
        v: 1,
        requestedAt: new Date().toISOString(),
        requestedByPid: "1",
        reason: "stop",
      },
    ],
  ])("returns null for %s", async (_label, payload) => {
    await mkdir(dir, { recursive: true });
    await writeFile(intentPath(), JSON.stringify(payload), "utf8");

    await expect(readStopIntent("production")).resolves.toBeNull();
  });
});

describe("isStopIntentFresh", () => {
  const at = (requestedAt: string) =>
    ({ v: 1, requestedAt, requestedByPid: 1, reason: "stop" }) as const;

  it("is fresh inside the staleness window", () => {
    const now = Date.parse("2026-08-05T12:00:00.000Z");
    const intent = at(
      new Date(now - (STOP_INTENT_STALE_MS - 1_000)).toISOString(),
    );

    expect(isStopIntentFresh(intent, now)).toBe(true);
  });

  it("expires past the window so a half-finished stop cannot wedge recovery forever", () => {
    const now = Date.parse("2026-08-05T12:00:00.000Z");
    const intent = at(
      new Date(now - (STOP_INTENT_STALE_MS + 1_000)).toISOString(),
    );

    expect(isStopIntentFresh(intent, now)).toBe(false);
  });

  it("treats a future-dated stamp as fresh (clock skew is not a licence to relaunch)", () => {
    const now = Date.parse("2026-08-05T12:00:00.000Z");
    const intent = at(new Date(now + 60_000).toISOString());

    expect(isStopIntentFresh(intent, now)).toBe(true);
  });

  it("expires a stamp dated FAR in the future, so a backward clock jump cannot wedge recovery", () => {
    // The window has to be symmetric. A VM resuming, or NTP correcting a bad
    // clock, leaves an already-written intent dated hours ahead - and an
    // unbounded forward window makes that record permanent, because it is also
    // newer than every later supervisor's invocation cutoff, so
    // `isStopIntentAlreadyServed` can never retire it either. Every automatic
    // start would decline to spawn until the clock caught up: the guard against
    // a stop being undone, holding the machine hostless, which is this
    // ticket's own bug wearing the fix's clothes.
    const now = Date.parse("2026-08-05T12:00:00.000Z");
    const intent = at(
      new Date(now + (STOP_INTENT_STALE_MS + 1_000)).toISOString(),
    );

    expect(isStopIntentFresh(intent, now)).toBe(false);
  });

  it("treats an unparseable timestamp as stale rather than blocking recovery", () => {
    expect(isStopIntentFresh(at("not-a-date"), Date.now())).toBe(false);
  });
});

describe("hasFreshStopIntent", () => {
  it("is false with no file, true right after a write", async () => {
    await expect(hasFreshStopIntent("production", Date.now())).resolves.toBe(
      false,
    );

    await writeStopIntent("production", "restart");

    await expect(hasFreshStopIntent("production", Date.now())).resolves.toBe(
      true,
    );
  });

  it("is false again once the intent is cleared", async () => {
    await writeStopIntent("production", "restart");
    await clearStopIntent("production");

    await expect(hasFreshStopIntent("production", Date.now())).resolves.toBe(
      false,
    );
  });
});

describe("clearStopIntent", () => {
  it("is a no-op when nothing was recorded", async () => {
    await expect(clearStopIntent("production")).resolves.toBeUndefined();
    await expect(readFile(intentPath(), "utf8")).rejects.toThrow();
  });
});

describe("isStopIntentAlreadyServed", () => {
  const intentAt = (requestedAt: string) =>
    ({
      v: 1 as const,
      requestedAt,
      requestedByPid: 4242,
      reason: "stop" as const,
    }) as const;

  it("treats intent older than the supervisor's start as served", () => {
    const startedAt = Date.parse("2026-08-06T12:00:00.000Z");
    expect(
      isStopIntentAlreadyServed(
        intentAt("2026-08-06T11:59:59.000Z"),
        startedAt,
      ),
    ).toBe(true);
  });

  it("treats intent at or after the supervisor's start as aimed at it", () => {
    const startedAt = Date.parse("2026-08-06T12:00:00.000Z");
    // Exactly equal counts as NOT served: a stop written in the same
    // millisecond we started must win, because the costly direction here is
    // fighting a deliberate stop.
    expect(
      isStopIntentAlreadyServed(
        intentAt("2026-08-06T12:00:00.000Z"),
        startedAt,
      ),
    ).toBe(false);
    expect(
      isStopIntentAlreadyServed(
        intentAt("2026-08-06T12:00:01.000Z"),
        startedAt,
      ),
    ).toBe(false);
  });

  it("treats an unparseable stamp as served rather than blocking recovery", () => {
    // Same bias as everywhere else in this module: a garbled byte must not be
    // able to hold a machine hostless.
    expect(isStopIntentAlreadyServed(intentAt("not-a-date"), Date.now())).toBe(
      true,
    );
  });
});

describe("hasActionableStopIntent", () => {
  it("ignores a fresh intent that predates the supervisor", async () => {
    // The logon-inside-the-freshness-window case: stopping the host and
    // logging back in must not leave the new supervisor unable to recover its
    // own child's first crash.
    await writeStopIntent("production", "stop");
    const now = Date.now();

    await expect(
      hasActionableStopIntent("production", now, now + 1_000),
    ).resolves.toBe(false);
    // Still FRESH - it is the cutoff, not staleness, doing the work here.
    await expect(hasFreshStopIntent("production", now)).resolves.toBe(true);
  });

  it("honours an intent written after the supervisor started", async () => {
    await writeStopIntent("production", "stop");
    const now = Date.now();

    await expect(
      hasActionableStopIntent("production", now, now - 60_000),
    ).resolves.toBe(true);
  });

  it("ignores an intent that is past the staleness window", async () => {
    await writeStopIntent("production", "stop");
    const now = Date.now() + STOP_INTENT_STALE_MS + 1_000;

    await expect(hasActionableStopIntent("production", now, 0)).resolves.toBe(
      false,
    );
  });

  it("reads an absent record as no intent", async () => {
    await expect(
      hasActionableStopIntent("production", Date.now(), 0),
    ).resolves.toBe(false);
  });
});
