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
//   - a false "intent absent" relaunches a host the user just stopped.
//
// This header used to call that second cost "one unwanted relaunch, which the
// supervisor's budget and incumbent re-check then contain". Neither contains
// it: a replacement that stays healthy resets the budget and IS the incumbent.
// The bias is still the one above, but it is a real trade, not a free one.
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
  isStopIntentFresh,
  readStopIntent,
  readStopIntentIdentity,
  writeStopIntent,
} = await import("../stop-intent");

// A record this supervisor demonstrably never saw. Used to stand in for "the
// file changed since startup" without depending on what is on disk.
const FOREIGN_INTENT = {
  requestedAt: "2020-01-01T00:00:00.000Z",
  requestedByPid: 1,
} as const;

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
    // unbounded forward window makes that record permanent - nothing else would
    // retire it, since it stays "recent" for as long as the jump lasts. Every
    // automatic start that had not already seen the record would decline to
    // spawn until the clock caught up: the guard against a stop being undone,
    // holding the machine hostless, which is this ticket's own bug wearing the
    // fix's clothes.
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

describe("hasActionableStopIntent - file round trip", () => {
  it("is false with no file, true right after a write, false once cleared", async () => {
    // `null` identity throughout: this supervisor saw no record at startup, so
    // anything on disk afterwards is a request aimed at it.
    await expect(
      hasActionableStopIntent("production", Date.now(), null),
    ).resolves.toBe(false);

    await writeStopIntent("production", "restart");
    await expect(
      hasActionableStopIntent("production", Date.now(), null),
    ).resolves.toBe(true);

    await clearStopIntent("production");
    await expect(
      hasActionableStopIntent("production", Date.now(), null),
    ).resolves.toBe(false);
  });
});

describe("clearStopIntent", () => {
  it("is a no-op when nothing was recorded", async () => {
    await expect(clearStopIntent("production")).resolves.toBeUndefined();
    await expect(readFile(intentPath(), "utf8")).rejects.toThrow();
  });
});

describe("hasActionableStopIntent", () => {
  it("serves the record it saw at startup, whatever that record's stamp says", async () => {
    // Two cases that used to be answered by a timestamp cutoff, and are now one
    // case because they always WERE one case: this is the record our own start
    // answered.
    //
    // The second half is the one the cutoff got wrong. After a backward clock
    // correction a pre-existing record looks FUTURE-dated, so the cutoff read an
    // already-answered stop as aimed at this supervisor - which declines to
    // spawn and exits 0. No service manager answers exit 0, so the host stayed
    // down until the next logon instead of the intended five minutes.
    await writeStopIntent("production", "stop");
    const served = await readStopIntentIdentity("production");
    const now = Date.now();

    // Stamp older than "now" - the ordinary logon-inside-the-window shape.
    await expect(
      hasActionableStopIntent("production", now + 1_000, served),
    ).resolves.toBe(false);
    // Stamp NEWER than "now", i.e. future-dated by a backward clock step. Still
    // ours, still served: identity does not consult the clock.
    await expect(
      hasActionableStopIntent("production", now - 1_000, served),
    ).resolves.toBe(false);
  });

  it("honours a record it never saw even when the clock says it is older", async () => {
    // The backward-clock-step case, and the reason the cutoff cannot stand
    // alone. A machine that boots with a wrong RTC gets its correction seconds
    // after the logon task started this supervisor, so a stop issued NOW is
    // stamped EARLIER than our own start. The cutoff reads that as served, and
    // on win32 the orphaned supervisor then relaunches the host the user just
    // stopped - this ticket's bug, restored by its own guard.
    //
    // Identity settles it without consulting a clock: this is not the record we
    // saw at startup, so it is a request we have not answered.
    await writeStopIntent("production", "stop");
    const now = Date.now();

    await expect(
      hasActionableStopIntent("production", now, FOREIGN_INTENT),
    ).resolves.toBe(true);
  });

  it("ignores an intent that is past the staleness window", async () => {
    // Freshness short-circuits BOTH halves, so an unknown identity cannot
    // resurrect an expired record - the five-minute bound still caps how long
    // any of this can hold a spawn back.
    await writeStopIntent("production", "stop");
    const now = Date.now() + STOP_INTENT_STALE_MS + 1_000;

    await expect(
      hasActionableStopIntent("production", now, FOREIGN_INTENT),
    ).resolves.toBe(false);
  });

  it("reads an absent record as no intent", async () => {
    await expect(
      hasActionableStopIntent("production", Date.now(), null),
    ).resolves.toBe(false);
  });
});
