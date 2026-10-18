import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostCrashTelemetry } from "../crash-telemetry";

// A crash-looping host under a service manager: the supervisor relaunches the
// host MAX_CONSECUTIVE_RELAUNCHES times, exits with the child's code, and
// systemd / launchd starts a NEW supervisor process that does it again. Each
// "supervisor life" below is a fresh module instance (a fresh process in
// effect) over the same home directory, which is all the throttle has to
// remember a previous life by.

interface SentryExtras {
  readonly suppressedCount?: number;
}

interface SentryMessage {
  readonly message: string;
  readonly level: string;
  readonly extras: SentryExtras | undefined;
}

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const sentryMocks = vi.hoisted(() => ({
  messages: [] as SentryMessage[],
  pendingExtras: undefined as SentryExtras | undefined,
  flushes: [] as number[],
  /** When set, a flush with this timeout stays pending until released. */
  heldFlush: null as {
    timeout: number;
    releases: (() => void)[];
    onFlush?: () => void;
  } | null,
}));

vi.mock("@sentry/node", () => ({
  withScope: (
    fn: (scope: {
      setLevel(level: string): void;
      setFingerprint(fingerprint: readonly string[]): void;
      setTags(tags: Record<string, string>): void;
      setExtras(extras: Record<string, string | number | boolean>): void;
      setUser(user: { id: string }): void;
    }) => void,
  ) => {
    fn({
      setLevel: () => undefined,
      setFingerprint: () => undefined,
      setTags: () => undefined,
      setExtras: (extras) => {
        const { suppressedCount } = extras;
        sentryMocks.pendingExtras =
          typeof suppressedCount === "number" ? { suppressedCount } : {};
      },
      setUser: () => undefined,
    });
  },
  captureMessage: (message: string, level: string) => {
    sentryMocks.messages.push({
      message,
      level,
      extras: sentryMocks.pendingExtras,
    });
    sentryMocks.pendingExtras = undefined;
  },
  flush: (timeout: number) => {
    sentryMocks.flushes.push(timeout);
    const held = sentryMocks.heldFlush;
    if (held !== null && held.timeout === timeout) {
      return new Promise<boolean>((resolve) => {
        held.releases.push(() => {
          resolve(true);
        });
        held.onFlush?.();
      });
    }
    return Promise.resolve(true);
  },
}));

vi.mock("../../sentry-transport", () => ({
  destroySentryTransportRequests: () => 0,
}));

const pidMetadata = vi.hoisted(() => ({
  hostId: null as string | null,
}));

vi.mock("../pid-metadata", () => ({
  readHostPidMetadata: () =>
    Promise.resolve(
      pidMetadata.hostId === null
        ? null
        : {
            pid: 4243,
            hostId: pidMetadata.hostId,
            version: "1.5.1",
            websocketUrl: "ws://127.0.0.1:1",
            startedAt: "2026-10-17T00:00:00.000Z",
            processStartIdentity: null,
            processStartIdentityRead: "absent",
            layer0: null,
            layer0Slot: null,
          },
    ),
}));

const RELAUNCHES_PER_SUPERVISOR_LIFE = 5;
const HOUR_MS = 60 * 60 * 1000;

function crash(attemptId: string, exitCode: number): HostCrashTelemetry {
  return {
    environment: "production",
    attemptId,
    supervisorPid: 4242,
    childPid: 4243,
    hostVersion: "1.5.1",
    exitCode,
    signal: null,
    exitMeaning: null,
    hasDiagnosticReport: false,
    uptimeMs: 800,
    stopRequested: false,
    stderrEmpty: true,
    stderrFatal: "none",
    reportMemory: { heapLimitBytes: null, heapUsedBytes: null, rssBytes: null },
  };
}

function fullReports(): number {
  return sentryMocks.messages.filter(
    (entry) => !entry.message.endsWith("(repeated)"),
  ).length;
}

function summaries(): { suppressedCount: number }[] {
  const out: { suppressedCount: number }[] = [];
  for (const entry of sentryMocks.messages) {
    const count = entry.extras?.suppressedCount;
    if (entry.message.endsWith("(repeated)") && count !== undefined) {
      out.push({ suppressedCount: count });
    }
  }
  return out;
}

let home: string;
let nowMs: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "traycer-crash-restart-test-"));
  osHome.current = home;
  sentryMocks.messages.length = 0;
  sentryMocks.flushes.length = 0;
  sentryMocks.heldFlush = null;
  pidMetadata.hostId = null;
  nowMs = Date.UTC(2026, 9, 17, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(nowMs);
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
  osHome.current = "";
});

/** One supervisor life: a fresh module instance, then `crashes` host crashes. */
async function superviseLife(crashes: number, exitCode: number): Promise<void> {
  vi.resetModules();
  const mod = await import("../crash-telemetry");
  for (let index = 0; index < crashes; index += 1) {
    await mod.reportHostCrashToSentry(crash(`attempt-${index}`, exitCode));
    vi.advanceTimersByTime(30_000);
  }
  // The supervisor process ends: its timers go with it. `clearAllTimers`
  // resets the fake clock too, which would rewind Date to the real time, so
  // the time is put back.
  const keep = Date.now();
  vi.clearAllTimers();
  vi.setSystemTime(keep);
}

describe("host crash reports across supervisor restarts", () => {
  it("sends 3 full reports and then a count across two supervisor lives, not 3 per life", async () => {
    await superviseLife(RELAUNCHES_PER_SUPERVISOR_LIFE + 1, 1);
    expect(fullReports()).toBe(3);
    // The service manager restarts the supervisor 30 seconds later.
    await superviseLife(RELAUNCHES_PER_SUPERVISOR_LIFE + 1, 1);
    expect(fullReports()).toBe(3);
  });

  it("keeps the bound over many supervisor lives inside one window", async () => {
    for (let life = 0; life < 6; life += 1) {
      await superviseLife(RELAUNCHES_PER_SUPERVISOR_LIFE + 1, 1);
    }
    expect(fullReports()).toBe(3);
  });

  it("sends the count a supervisor left open when its window ends, even if the next life never crashes", async () => {
    await superviseLife(RELAUNCHES_PER_SUPERVISOR_LIFE + 1, 1);
    expect(summaries()).toEqual([]);
    // A later supervisor starts and resumes the open window; the host stays up.
    vi.resetModules();
    const mod = await import("../crash-telemetry");
    await mod.resumeHostCrashReports("production");
    vi.advanceTimersByTime(HOUR_MS);
    expect(summaries()).toEqual([{ suppressedCount: 3 }]);
    // Resuming again does not send it twice.
    await mod.resumeHostCrashReports("production");
    vi.advanceTimersByTime(HOUR_MS);
    expect(summaries()).toHaveLength(1);
  });

  it("sends an overdue count on resume and does not repeat it from the next life", async () => {
    await superviseLife(RELAUNCHES_PER_SUPERVISOR_LIFE + 1, 1);
    vi.advanceTimersByTime(3 * HOUR_MS);
    vi.resetModules();
    const mod = await import("../crash-telemetry");
    await mod.resumeHostCrashReports("production");
    vi.advanceTimersByTime(1);
    expect(summaries()).toEqual([{ suppressedCount: 3 }]);
    await superviseLife(1, 1);
    vi.advanceTimersByTime(2 * HOUR_MS);
    // 3 hours quiet: the new life's crash is reported in full again.
    expect(fullReports()).toBe(4);
    expect(summaries()).toHaveLength(1);
  });

  it("gives an overdue count sent on resume time to leave the machine before the resume resolves, and waits for nothing otherwise", async () => {
    await superviseLife(RELAUNCHES_PER_SUPERVISOR_LIFE + 1, 1);
    // Not yet due: nothing is sent, so nothing is flushed.
    vi.resetModules();
    let mod = await import("../crash-telemetry");
    sentryMocks.flushes.length = 0;
    await mod.resumeHostCrashReports("production");
    expect(summaries()).toEqual([]);
    expect(sentryMocks.flushes).toEqual([]);
    vi.clearAllTimers();

    // Overdue: sent at once, and the resume stays pending until the transport
    // flush for it (within its own timeout) has settled.
    vi.advanceTimersByTime(3 * HOUR_MS);
    vi.resetModules();
    mod = await import("../crash-telemetry");
    let signalFlush: () => void = () => undefined;
    const flushStarted = new Promise<void>((resolve) => {
      signalFlush = resolve;
    });
    const heldFlush = {
      timeout: mod.HOST_CRASH_TRANSPORT_TIMEOUT_MS,
      releases: [] as (() => void)[],
      onFlush: signalFlush,
    };
    sentryMocks.heldFlush = heldFlush;
    let resolved = false;
    const resuming = mod.resumeHostCrashReports("production").then(() => {
      resolved = true;
    });
    try {
      const flushObserved = await Promise.race([
        flushStarted.then(() => true),
        resuming.then(() => false),
      ]);
      expect(flushObserved).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(summaries()).toEqual([{ suppressedCount: 3 }]);
      expect(sentryMocks.flushes).toContain(
        mod.HOST_CRASH_TRANSPORT_TIMEOUT_MS,
      );
      expect(resolved).toBe(false);
    } finally {
      for (const release of heldFlush.releases) release();
      await resuming;
    }
    expect(resolved).toBe(true);
  });

  it("keeps a summary a timer sent just before a clean stop from being lost or sent again: the exit waits for its upload and its cleared state", async () => {
    vi.resetModules();
    const mod = await import("../crash-telemetry");
    for (
      let index = 0;
      index < RELAUNCHES_PER_SUPERVISOR_LIFE + 1;
      index += 1
    ) {
      await mod.reportHostCrashToSentry(crash(`attempt-${index}`, 1));
    }
    sentryMocks.heldFlush = {
      timeout: mod.HOST_CRASH_TRANSPORT_TIMEOUT_MS,
      releases: [],
    };
    vi.advanceTimersByTime(HOUR_MS);
    expect(summaries()).toEqual([{ suppressedCount: 3 }]);
    let settledEarly = false;
    const settling = mod.settleHostCrashThrottleWrites().then(() => {
      settledEarly = true;
    });
    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // The upload is still on its way, so the exit would still be waiting.
    expect(settledEarly).toBe(false);
    for (const release of sentryMocks.heldFlush.releases) release();
    await settling;

    const stateDir = join(home, ".traycer", "cli");
    const files = readdirSync(stateDir).filter((name) =>
      name.startsWith("host-crash-throttle"),
    );
    const text = readFileSync(join(stateDir, files[0]), "utf8");
    // Sent and a whole window quiet since: nothing is left to carry over.
    expect(text).not.toContain('"suppressedCount":3');
    expect(text).toBe('{"version":1,"kinds":{}}\n');
    vi.clearAllTimers();
  });

  it("keeps waiting for the write and upload a summary timer queues while the exit is already waiting", async () => {
    vi.resetModules();
    const mod = await import("../crash-telemetry");
    const held = {
      timeout: mod.HOST_CRASH_TRANSPORT_TIMEOUT_MS,
      releases: [] as (() => void)[],
    };
    sentryMocks.heldFlush = held;
    for (
      let index = 0;
      index < RELAUNCHES_PER_SUPERVISOR_LIFE + 1;
      index += 1
    ) {
      await mod.reportHostCrashToSentry(crash(`attempt-${index}`, 1));
    }
    const uploadsBefore = held.releases.length;
    let settledEarly = false;
    const settling = mod.settleHostCrashThrottleWrites().then(() => {
      settledEarly = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The summary timer fires while the exit is already waiting.
    vi.advanceTimersByTime(HOUR_MS);
    expect(held.releases.length).toBe(uploadsBefore + 1);
    for (const release of held.releases.slice(0, uploadsBefore)) release();
    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(settledEarly).toBe(false);
    held.releases[uploadsBefore]();
    await settling;
    expect(settledEarly).toBe(true);
    vi.clearAllTimers();
  });

  it("reports in full again once a kind has stayed quiet for a whole window", async () => {
    await superviseLife(RELAUNCHES_PER_SUPERVISOR_LIFE + 1, 1);
    expect(fullReports()).toBe(3);
    vi.advanceTimersByTime(2 * HOUR_MS);
    await superviseLife(1, 1);
    expect(fullReports()).toBe(4);
  });

  it("budgets a different kind of crash separately across lives", async () => {
    await superviseLife(RELAUNCHES_PER_SUPERVISOR_LIFE + 1, 1);
    await superviseLife(RELAUNCHES_PER_SUPERVISOR_LIFE + 1, 2);
    expect(fullReports()).toBe(6);
  });

  it("reports in full, without throwing, when the state file is torn or unreadable", async () => {
    await superviseLife(RELAUNCHES_PER_SUPERVISOR_LIFE + 1, 1);
    const stateDir = join(home, ".traycer", "cli");
    const files = readdirSync(stateDir).filter((name) =>
      name.startsWith("host-crash-throttle"),
    );
    expect(files).toHaveLength(1);
    writeFileSync(join(stateDir, files[0]), '{"version":1,"kinds":{"host-cr');
    sentryMocks.messages.length = 0;
    await expect(superviseLife(1, 1)).resolves.toBeUndefined();
    expect(fullReports()).toBe(1);
    // Foreign shapes are not state either.
    writeFileSync(join(stateDir, files[0]), '{"version":1,"kinds":[1,2]}');
    await expect(superviseLife(1, 1)).resolves.toBeUndefined();
  });

  it("reads a state file past the size cap as no state, without parsing it", async () => {
    await superviseLife(RELAUNCHES_PER_SUPERVISOR_LIFE + 1, 1);
    const stateDir = join(home, ".traycer", "cli");
    const files = readdirSync(stateDir).filter((name) =>
      name.startsWith("host-crash-throttle"),
    );
    // Valid JSON that would carry the held-back state, padded past 256 KiB.
    const text = readFileSync(join(stateDir, files[0]), "utf8");
    writeFileSync(join(stateDir, files[0]), `${text}${" ".repeat(300 * 1024)}`);
    sentryMocks.messages.length = 0;
    await superviseLife(1, 1);
    expect(fullReports()).toBe(1);
  });

  it("writes only the closed set of fields, with the host id and nothing else that identifies a person or a machine path", async () => {
    pidMetadata.hostId = "host-known-id";
    await superviseLife(RELAUNCHES_PER_SUPERVISOR_LIFE + 1, 1);
    const stateDir = join(home, ".traycer", "cli");
    const files = readdirSync(stateDir).filter((name) =>
      name.startsWith("host-crash-throttle"),
    );
    expect(files).toHaveLength(1);
    const text = readFileSync(join(stateDir, files[0]), "utf8");
    expect(text).not.toContain(home);

    const parsed: unknown = JSON.parse(text);
    if (!isKinds(parsed)) throw new Error("state file has no kinds");
    expect(Object.keys(parsed).sort()).toEqual(["kinds", "version"]);
    expect(Object.keys(parsed.kinds)).toHaveLength(1);
    const kind = Object.values(parsed.kinds)[0];
    expect(Object.keys(kind).sort()).toEqual([
      "lastCrashAt",
      "lastSuppressed",
      "reported",
      "suppressedCount",
      "windowStartedAt",
    ]);
    const held = kind.lastSuppressed;
    expect(held).not.toBeNull();
    expect(Object.keys(held ?? {}).sort()).toEqual([
      "fingerprint",
      "hostId",
      "level",
      "message",
      "tags",
    ]);
    expect(held?.hostId).toBe("host-known-id");
    expect(Object.keys(held?.tags ?? {}).sort()).toEqual([
      "arch",
      "cli_version",
      "crash_kind",
      "host_environment",
      "host_fatal",
      "host_output",
      "host_phase",
      "host_running_version",
      "host_version",
      "os_release",
      "platform",
      "stop_requested",
      "uptime_bucket",
    ]);
  });
});

interface StoredKind {
  readonly lastSuppressed: {
    readonly hostId: string | null;
    readonly tags: Record<string, string>;
  } | null;
}

function isKinds(value: unknown): value is {
  readonly kinds: Record<string, StoredKind>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "kinds" in value &&
    typeof value.kinds === "object" &&
    value.kinds !== null
  );
}
