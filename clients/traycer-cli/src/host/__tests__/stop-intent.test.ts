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
  hasFreshStopIntent,
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

  it("never throws when the destination cannot be written", async () => {
    // A stop that cannot record its intent must still stop. Point the path at
    // a location whose parent is a FILE, so the atomic write's mkdir fails.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    mocks.hostHome.current = join(blocker, "nested");

    await expect(
      writeStopIntent("production", "stop"),
    ).resolves.toBeUndefined();
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
