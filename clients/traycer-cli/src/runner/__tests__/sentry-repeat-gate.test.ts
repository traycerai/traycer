import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  CLI_SENTRY_REPEAT_WINDOW_MS,
  cliSentryRepeatKey,
  cliSentryRepeatLedgerPath,
  decideRepeat,
  defaultRepeatGateIo,
  messageTemplate,
  parseLedger,
  recordCliFailureForSentry,
  type RepeatGateIo,
  type RepeatLedgerEntry,
} from "../sentry-repeat-gate";

// Mirrors the module's own private retention constant (not exported): entries
// older than this are dropped on every `decideRepeat` call regardless of
// their suppressed count.
const LEDGER_RETENTION_MS = 24 * 60 * 60 * 1000;

describe("messageTemplate", () => {
  // Real per-machine failure messages the runner has actually reported, each
  // with a variant that differs only in its per-event values (a uuid, exit
  // codes, a uid/username/codes). The two variants of a kind must fold to the
  // SAME template - that is what makes the kind repeat-detectable at all.
  const profileRemoved = (uuid: string): string =>
    `Profile "${uuid}" for provider "claude-code" was removed and can no longer be used.`;

  const systemdUnreachable = (showEnvCode: number, statusCode: number): string =>
    `the systemd user manager is not reachable, so the ai.traycer.host.service service cannot be installed: systemctl --user show-environment exited with code ${showEnvCode}: Failed to get environment: Process org.freedesktop.systemd1 exited with status ${statusCode}`;

  const launchctlBootstrapFailed = (
    uid: number,
    username: string,
    bootstrapCode: number,
    innerCode: number,
  ): string =>
    `launchctl bootstrap failed for ai.traycer.host: launchctl bootstrap gui/${uid} /Users/${username}/Library/LaunchAgents/ai.traycer.host.plist exited with code ${bootstrapCode}: Bootstrap failed: ${innerCode}: Input/output error`;

  const desktopOwnsRegistration =
    "service install: Traycer Desktop owns host registration on this machine (SMAppService); install it from Traycer Desktop instead";

  it("folds two profile-removed messages that differ only in the uuid to the same template", () => {
    const a = profileRemoved("464ec16b-b0ad-48bc-bddc-843e059a5813");
    const b = profileRemoved("9f8e7d6c-5b4a-3210-fedc-ba9876543210");

    expect(messageTemplate(a)).toBe(messageTemplate(b));
    expect(messageTemplate(a)).toContain("<q>");
    expect(messageTemplate(a)).not.toContain("464ec16b");
  });

  it("folds two systemd-unreachable messages that differ only in their exit codes to the same template", () => {
    const a = systemdUnreachable(1, 1);
    const b = systemdUnreachable(7, 9);

    expect(messageTemplate(a)).toBe(messageTemplate(b));
    expect(messageTemplate(a)).toContain("<n>");
  });

  it("folds two launchctl-bootstrap messages that differ only in uid, username and codes to the same template", () => {
    const a = launchctlBootstrapFailed(502, "alice", 5, 5);
    const b = launchctlBootstrapFailed(501, "bob", 9, 3);

    expect(messageTemplate(a)).toBe(messageTemplate(b));
    expect(messageTemplate(a)).toContain("<path>");
    expect(messageTemplate(a)).not.toContain("alice");
    expect(messageTemplate(a)).not.toContain("502");
  });

  it("leaves the constant Desktop-owns-registration message untouched", () => {
    expect(messageTemplate(desktopOwnsRegistration)).toBe(
      desktopOwnsRegistration,
    );
  });

  it("produces four different templates for the four different kinds", () => {
    const templates = new Set([
      messageTemplate(profileRemoved("464ec16b-b0ad-48bc-bddc-843e059a5813")),
      messageTemplate(systemdUnreachable(1, 1)),
      messageTemplate(launchctlBootstrapFailed(502, "alice", 5, 5)),
      messageTemplate(desktopOwnsRegistration),
    ]);

    expect(templates.size).toBe(4);
  });

  it("replaces a Windows path", () => {
    const message =
      "profile cache write failed: C:\\Users\\bob\\Downloads\\x is not writable";

    expect(messageTemplate(message)).toBe(
      "profile cache write failed: <path> is not writable",
    );
  });

  it("replaces an e-mail address", () => {
    const message = "notify user at test.user@example.com about the failure";

    expect(messageTemplate(message)).toBe(
      "notify user at <email> about the failure",
    );
  });

  it("caps the output length at 240", () => {
    const long = "x".repeat(300);

    expect(messageTemplate(long)).toHaveLength(240);
    expect(messageTemplate(long)).toBe("x".repeat(240));
  });
});

describe("cliSentryRepeatKey", () => {
  it("includes the code and the error's name", () => {
    expect(
      cliSentryRepeatKey("E_HOST_INSTALL_FAILED", new TypeError("boom"), "boom"),
    ).toBe("E_HOST_INSTALL_FAILED|TypeError|boom");
  });

  it("uses typeof for a non-Error thrown value", () => {
    expect(cliSentryRepeatKey("E_UNEXPECTED", "just a string", "just a string")).toBe(
      "E_UNEXPECTED|string|just a string",
    );
  });

  it("differs when the code differs, everything else held equal", () => {
    const err = new Error("boom");
    expect(cliSentryRepeatKey("CODE_A", err, "boom")).not.toBe(
      cliSentryRepeatKey("CODE_B", err, "boom"),
    );
  });
});

describe("decideRepeat", () => {
  it("reports on first occurrence with repeatsSinceLastReport 0, and records an entry with suppressed 0", () => {
    const nowMs = 1_000_000;

    const { decision, next } = decideRepeat(new Map(), "key-a", nowMs);

    expect(decision).toEqual({ kind: "report", repeatsSinceLastReport: 0 });
    expect(next.get("key-a")).toEqual({ windowStartMs: nowMs, suppressed: 0 });
  });

  it("suppresses repeats within the window, counting up 1, 2, 3", () => {
    const start = 1_000_000;
    const first = decideRepeat(new Map(), "key-b", start);
    expect(first.decision).toEqual({ kind: "report", repeatsSinceLastReport: 0 });

    const second = decideRepeat(first.next, "key-b", start + 1_000);
    expect(second.decision).toEqual({ kind: "suppress", repeatsInWindow: 1 });

    const third = decideRepeat(second.next, "key-b", start + 2_000);
    expect(third.decision).toEqual({ kind: "suppress", repeatsInWindow: 2 });

    const fourth = decideRepeat(third.next, "key-b", start + 3_000);
    expect(fourth.decision).toEqual({ kind: "suppress", repeatsInWindow: 3 });
  });

  it("reports again exactly at the window end, carrying the prior suppressed count and starting a fresh window", () => {
    const start = 1_000_000;
    const first = decideRepeat(new Map(), "key-c", start);
    const second = decideRepeat(first.next, "key-c", start + 1_000);
    expect(second.decision).toEqual({ kind: "suppress", repeatsInWindow: 1 });

    const atWindowEnd = start + CLI_SENTRY_REPEAT_WINDOW_MS;
    const third = decideRepeat(second.next, "key-c", atWindowEnd);

    expect(third.decision).toEqual({ kind: "report", repeatsSinceLastReport: 1 });
    expect(third.next.get("key-c")).toEqual({
      windowStartMs: atWindowEnd,
      suppressed: 0,
    });
  });

  it("reports when the clock has gone backwards relative to the stored window start", () => {
    const start = 1_000_000;
    const { next } = decideRepeat(new Map(), "key-d", start);

    const result = decideRepeat(next, "key-d", start - 1);

    expect(result.decision).toEqual({ kind: "report", repeatsSinceLastReport: 0 });
    expect(result.next.get("key-d")).toEqual({
      windowStartMs: start - 1,
      suppressed: 0,
    });
  });

  it("keeps different keys independent", () => {
    const start = 1_000_000;
    const first = decideRepeat(new Map(), "key-e", start);
    const second = decideRepeat(first.next, "key-f", start);

    expect(second.decision).toEqual({ kind: "report", repeatsSinceLastReport: 0 });
    expect(second.next.get("key-e")).toEqual({
      windowStartMs: start,
      suppressed: 0,
    });

    const third = decideRepeat(second.next, "key-e", start + 1_000);
    expect(third.decision).toEqual({ kind: "suppress", repeatsInWindow: 1 });
    expect(third.next.get("key-f")).toEqual({
      windowStartMs: start,
      suppressed: 0,
    });
  });

  it("drops entries older than the 24h retention window", () => {
    const nowMs = 1_000_000_000;
    const ledger = new Map<string, RepeatLedgerEntry>([
      [
        "stale-key",
        { windowStartMs: nowMs - LEDGER_RETENTION_MS - 1, suppressed: 5 },
      ],
    ]);

    const { next } = decideRepeat(ledger, "fresh-key", nowMs);

    expect(next.has("stale-key")).toBe(false);
    expect(next.has("fresh-key")).toBe(true);
  });

  it("caps the ledger at 100 entries: the new key plus the 99 most recent others", () => {
    const nowMs = 1_000_000_000;
    const ledger = new Map<string, RepeatLedgerEntry>();
    for (let i = 0; i < 150; i += 1) {
      ledger.set(`old-key-${i}`, {
        windowStartMs: nowMs - i * 1_000,
        suppressed: 0,
      });
    }

    const { next } = decideRepeat(ledger, "new-key", nowMs);

    expect(next.size).toBe(100);
    expect(next.has("new-key")).toBe(true);
    const survivingOthers = Array.from(next.keys()).filter(
      (key) => key !== "new-key",
    );
    const expectedSurvivors = Array.from(
      { length: 99 },
      (_unused, i) => `old-key-${i}`,
    );
    expect(new Set(survivingOthers)).toEqual(new Set(expectedSurvivors));
  });

  it("keeps the key being decided even when 100 other entries are more recent, and still suppresses inside its window", () => {
    const nowMs = 1_000_000_000;
    const currentWindowStart = nowMs - 30 * 60 * 1000; // 30 minutes ago
    const ledger = new Map<string, RepeatLedgerEntry>();
    ledger.set("current-key", { windowStartMs: currentWindowStart, suppressed: 2 });
    for (let i = 0; i < 100; i += 1) {
      ledger.set(`newer-key-${i}`, {
        windowStartMs: nowMs - i * 1_000,
        suppressed: 0,
      });
    }

    const { decision, next } = decideRepeat(ledger, "current-key", nowMs);

    expect(next.has("current-key")).toBe(true);
    expect(decision).toEqual({ kind: "suppress", repeatsInWindow: 3 });
    expect(next.size).toBe(100);
  });
});

describe("parseLedger", () => {
  it("returns an empty ledger for invalid JSON", () => {
    expect(parseLedger("not json")).toEqual(new Map());
  });

  it("returns an empty ledger for the wrong version", () => {
    const text = JSON.stringify({
      version: 2,
      entries: { a: { windowStartMs: 1, suppressed: 0 } },
    });

    expect(parseLedger(text)).toEqual(new Map());
  });

  it("returns an empty ledger when entries is not an object", () => {
    const text = JSON.stringify({ version: 1, entries: [] });

    expect(parseLedger(text)).toEqual(new Map());
  });

  it("drops malformed entries but keeps valid siblings", () => {
    const text = JSON.stringify({
      version: 1,
      entries: {
        valid: { windowStartMs: 100, suppressed: 2 },
        negativeWindow: { windowStartMs: -1, suppressed: 0 },
        negativeSuppressed: { windowStartMs: 100, suppressed: -1 },
        nonIntegerWindow: { windowStartMs: 1.5, suppressed: 0 },
        nonIntegerSuppressed: { windowStartMs: 100, suppressed: 1.5 },
        nonNumberWindow: { windowStartMs: "100", suppressed: 0 },
        notAnObject: "oops",
      },
    });

    const ledger = parseLedger(text);

    expect(ledger.size).toBe(1);
    expect(ledger.get("valid")).toEqual({ windowStartMs: 100, suppressed: 2 });
  });
});

function fakeRepeatGateIo(overrides: Partial<RepeatGateIo>): RepeatGateIo {
  return {
    now: () => 1_000_000,
    read: async () => null,
    write: async () => {},
    ...overrides,
  };
}

describe("recordCliFailureForSentry", () => {
  it("reports on a missing ledger, and the written value round-trips through parseLedger", async () => {
    const writes: { path: string; value: object }[] = [];
    const io = fakeRepeatGateIo({
      read: async () => null,
      write: async (path, value) => {
        writes.push({ path, value });
      },
    });

    const decision = await recordCliFailureForSentry("dev", "key-x", io);

    expect(decision).toEqual({ kind: "report", repeatsSinceLastReport: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(cliSentryRepeatLedgerPath("dev"));
    const roundTripped = parseLedger(JSON.stringify(writes[0].value));
    expect(roundTripped.get("key-x")).toEqual({
      windowStartMs: 1_000_000,
      suppressed: 0,
    });
  });

  it("reports with repeatsSinceLastReport 0 and writes nothing when the read fails", async () => {
    const writeMock: Mock<(path: string, value: object) => Promise<void>> =
      vi.fn(async () => {});
    const io = fakeRepeatGateIo({
      read: async () => {
        throw new Error("disk error");
      },
      write: writeMock,
    });

    const decision = await recordCliFailureForSentry("dev", "key-y", io);

    expect(decision).toEqual({ kind: "report", repeatsSinceLastReport: 0 });
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("still returns the decision, without throwing, when the write fails", async () => {
    const io = fakeRepeatGateIo({
      read: async () => null,
      write: async () => {
        throw new Error("disk full");
      },
    });

    const decision = await recordCliFailureForSentry("dev", "key-z", io);

    expect(decision).toEqual({ kind: "report", repeatsSinceLastReport: 0 });
  });

  it("passes cliSentryRepeatLedgerPath(environment) to both read and write", async () => {
    const readPaths: string[] = [];
    const writePaths: string[] = [];
    const io = fakeRepeatGateIo({
      read: async (path) => {
        readPaths.push(path);
        return null;
      },
      write: async (path) => {
        writePaths.push(path);
      },
    });

    await recordCliFailureForSentry("production", "key-w", io);

    const expectedPath = cliSentryRepeatLedgerPath("production");
    expect(readPaths).toEqual([expectedPath]);
    expect(writePaths).toEqual([expectedPath]);
  });
});

describe("defaultRepeatGateIo.read", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sentry-repeat-gate-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null for a missing file", async () => {
    const missing = join(dir, "does-not-exist.json");

    await expect(defaultRepeatGateIo.read(missing)).resolves.toBeNull();
  });
});
