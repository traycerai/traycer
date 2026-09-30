import { stat } from "node:fs";
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
  stackSite,
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

  const systemdUnreachable = (
    showEnvCode: number,
    statusCode: number,
  ): string =>
    `the systemd user manager is not reachable, so the ai.traycer.host.service service cannot be installed: systemctl --user show-environment exited with code ${showEnvCode}: Failed to get environment: Process org.freedesktop.systemd1 exited with status ${statusCode}`;

  const launchctlBootstrapFailed = (
    uid: number,
    username: string,
    bootstrapCode: number,
    innerCode: number,
  ): string =>
    `launchctl bootstrap failed for ai.traycer.host: launchctl bootstrap gui/${uid} /Users/${username}/Library/LaunchAgents/ai.traycer.host.plist exited with code ${bootstrapCode}: Bootstrap failed: ${innerCode}: Input/output error`;

  // The message `service install.ts` in `src/service/platforms/macos.ts`
  // (~line 1128) actually produces, when Desktop's SMAppService agent owns
  // host registration on this machine. Interpolates the agent label, the
  // path launchd loaded it from, and the raw CLI label.
  const desktopOwnsRegistration = (
    agentLabelId: string,
    loadedPath: string,
    rawLabelId: string,
  ): string =>
    `service install: Traycer Desktop owns host registration on this machine (SMAppService agent '${agentLabelId}' loaded from ${loadedPath}); installing the raw '${rawLabelId}' LaunchAgent would run a second host beside it. If you only need the host running again, run 'traycer host restart' (it starts the Desktop-managed host). To move host management to the CLI instead, re-run with --takeover (the running host is stopped cooperatively first), or relaunch the Traycer app to let it repair its own host.`;

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

  it("folds two Desktop-owns-registration messages that differ only in the agent label and the loaded path to the same template", () => {
    const a = desktopOwnsRegistration(
      "ai.traycer.host.agent",
      "/Library/LaunchDaemons/ai.traycer.host.agent.plist",
      "ai.traycer.host",
    );
    const b = desktopOwnsRegistration(
      "ai.traycer.host.agent.dev",
      "/Users/alice/Library/LaunchAgents/ai.traycer.host.agent.dev.plist",
      "ai.traycer.host.dev",
    );

    expect(messageTemplate(a)).toBe(messageTemplate(b));
  });

  it("produces four different templates for the four different kinds", () => {
    const templates = new Set([
      messageTemplate(profileRemoved("464ec16b-b0ad-48bc-bddc-843e059a5813")),
      messageTemplate(systemdUnreachable(1, 1)),
      messageTemplate(launchctlBootstrapFailed(502, "alice", 5, 5)),
      messageTemplate(
        desktopOwnsRegistration(
          "ai.traycer.host.agent",
          "/Library/LaunchDaemons/ai.traycer.host.agent.plist",
          "ai.traycer.host",
        ),
      ),
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

  // A single quote opens a quoted span only after start-of-string or a
  // non-word character, so an apostrophe inside a word ("host's",
  // "Desktop's") is left as plain text rather than swallowed as `'<q>'`.
  it("leaves apostrophes inside words as text, while still folding a genuinely quoted value", () => {
    // The varying cause sits BETWEEN the two apostrophes - "host's" ...
    // "Desktop's" - which is exactly where the round-1 regex
    // (`/'[^']*'/g`, with no non-word-character anchor) collapsed it: it
    // opened a quoted span at the FIRST apostrophe and closed it at the
    // SECOND, swallowing everything between as `'<q>'` regardless of what
    // varied there. A variant that only changed text AFTER the second
    // apostrophe would still differ under that old regex too, so it would
    // not have caught the bug - this pair only differs in the part the old
    // regex ate.
    const econnrefused =
      "the running host's RPC endpoint is unreachable (ECONNREFUSED); Desktop's agent will restart it";
    const pidFileStale =
      "the running host's RPC endpoint is unreachable (the pid file names a process that is not the host); Desktop's agent will restart it";

    expect(messageTemplate(econnrefused)).not.toBe(
      messageTemplate(pidFileStale),
    );
    expect(messageTemplate(econnrefused)).toContain("host's");
    expect(messageTemplate(econnrefused)).toContain("Desktop's");
  });

  it("still folds a quoted property name after a non-word character", () => {
    const message = "Cannot read properties of undefined (reading 'version')";

    expect(messageTemplate(message)).toBe(
      "Cannot read properties of undefined (reading '<q>')",
    );
  });
});

describe("stackSite", () => {
  function throwHelper(): never {
    throw new Error("boom");
  }

  function throwFromCallSiteA(): unknown {
    try {
      throwHelper();
    } catch (error) {
      return error;
    }
  }

  function throwFromCallSiteB(): unknown {
    try {
      throwHelper();
    } catch (error) {
      return error;
    }
  }

  it("gives the same site for the same throw site hit twice from one call site", () => {
    // Both errors are minted by calling `throwFromCallSiteA()` from this
    // SAME line inside the loop - unlike two separate top-level statements,
    // which would each add their own distinct call-site frame.
    const errors: unknown[] = [];
    for (let i = 0; i < 2; i += 1) {
      errors.push(throwFromCallSiteA());
    }

    expect(stackSite(errors[0])).toBe(stackSite(errors[1]));
    expect(stackSite(errors[0])).not.toBe("-");
  });

  it("gives a different site for a different throw site", () => {
    const fromA = throwFromCallSiteA();
    const fromB = throwFromCallSiteB();

    expect(stackSite(fromA)).not.toBe(stackSite(fromB));
  });

  it("contains no path separator", () => {
    const error = throwFromCallSiteA();

    expect(stackSite(error)).not.toMatch(/[\\/]/);
  });

  it('returns "-" for a non-Error', () => {
    expect(stackSite("just a string")).toBe("-");
    expect(stackSite(undefined)).toBe("-");
  });

  it('returns "-" for an Error whose stack has no parseable frames', () => {
    const error = new Error("boom");
    error.stack = "no frames in here at all";

    expect(stackSite(error)).toBe("-");
  });

  // Whether Node's own event-loop frame (`processTicksAndRejections`) or the
  // module-entry frame shows up in a captured stack depends on timing and the
  // Node version, not on where the CLI's own code threw - so both must be
  // skipped, and skipping them must not change the site two otherwise-
  // identical CLI frame lists produce.
  it("skips Node's own frames: a stack with them inserted gives the SAME site as one without, and neither position leaks through", () => {
    const withNodeFrames = new Error("boom");
    withNodeFrames.stack = [
      "Error: boom",
      "    at throwHelper (/app/src/runner/thing.ts:10:5)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
      "    at callSite (/app/src/runner/thing.ts:20:9)",
      "    at Object.<anonymous> (/app/src/runner/thing.ts:30:3)",
      "    at node:internal/main/run_main_module:33:47",
    ].join("\n");

    const withoutNodeFrames = new Error("boom");
    withoutNodeFrames.stack = [
      "Error: boom",
      "    at throwHelper (/app/src/runner/thing.ts:10:5)",
      "    at callSite (/app/src/runner/thing.ts:20:9)",
      "    at Object.<anonymous> (/app/src/runner/thing.ts:30:3)",
    ].join("\n");

    const site = stackSite(withNodeFrames);
    expect(site).toBe(stackSite(withoutNodeFrames));
    expect(site).not.toContain("104:5");
    expect(site).not.toContain("33:47");
  });

  it('returns "-" when the only positioned frames are Node\'s own', () => {
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
      "    at node:internal/main/run_main_module:33:47",
    ].join("\n");

    expect(stackSite(error)).toBe("-");
  });

  // The shape that exercises the Node-frame filter. This suite runs on Node,
  // where resuming an `await` from inside a `fs.stat` callback (a real libuv
  // completion) puts `process.processTicksAndRejections (node:internal/...)`
  // on the captured stack only when something else, here a
  // `process.nextTick`, was queued from that same callback first. Without the
  // filter the two variants' sites differ by that frame's position; with it
  // they are equal.
  it("gives the same site whether or not a process.nextTick was queued alongside the fs.stat completion that resumed the await", async () => {
    async function throwAfterStat(queueNextTickToo: boolean): Promise<never> {
      await new Promise<void>((resolve) => {
        stat(import.meta.dirname, () => {
          if (queueNextTickToo) {
            process.nextTick(() => {});
          }
          resolve();
        });
      });
      throw new Error("x");
    }

    const sites: string[] = [];
    for (const queueNextTickToo of [false, true]) {
      try {
        await throwAfterStat(queueNextTickToo);
      } catch (error) {
        sites.push(stackSite(error));
      }
    }

    expect(sites[0]).toBe(sites[1]);
    expect(sites[0]).not.toBe("-");
  });
});

describe("cliSentryRepeatKey", () => {
  function throwHelper(): never {
    throw new TypeError("boom");
  }

  function throwFromSiteA(): unknown {
    try {
      throwHelper();
    } catch (error) {
      return error;
    }
  }

  function throwFromSiteB(): unknown {
    try {
      throwHelper();
    } catch (error) {
      return error;
    }
  }

  it("includes the code, the error's name and its stack site", () => {
    const err = throwFromSiteA();
    expect(cliSentryRepeatKey("E_HOST_INSTALL_FAILED", err, "boom")).toBe(
      `E_HOST_INSTALL_FAILED|TypeError|${stackSite(err)}|boom`,
    );
  });

  it("uses typeof for a non-Error thrown value", () => {
    expect(
      cliSentryRepeatKey("E_UNEXPECTED", "just a string", "just a string"),
    ).toBe("E_UNEXPECTED|string|-|just a string");
  });

  it("differs when the code differs, everything else held equal", () => {
    const err = throwFromSiteA();
    expect(cliSentryRepeatKey("CODE_A", err, "boom")).not.toBe(
      cliSentryRepeatKey("CODE_B", err, "boom"),
    );
  });

  // The fix this module exists for: two distinct throw sites whose messages
  // fold to the SAME template (e.g. two different
  // `Cannot read properties of undefined (reading '<q>')` failures) must
  // still produce different keys, or one looping failure hides the other.
  it("gives different keys for two different throw sites sharing the same code and message template", () => {
    const fromA = throwFromSiteA();
    const fromB = throwFromSiteB();

    expect(
      cliSentryRepeatKey(
        "E_UNEXPECTED",
        fromA,
        "Cannot read properties of undefined (reading 'version')",
      ),
    ).not.toBe(
      cliSentryRepeatKey(
        "E_UNEXPECTED",
        fromB,
        "Cannot read properties of undefined (reading 'attemptId')",
      ),
    );
  });

  it("gives the same key for the same throw site and the same message", () => {
    const errors: unknown[] = [];
    for (let i = 0; i < 2; i += 1) {
      errors.push(throwFromSiteA());
    }

    expect(cliSentryRepeatKey("E_UNEXPECTED", errors[0], "boom")).toBe(
      cliSentryRepeatKey("E_UNEXPECTED", errors[1], "boom"),
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
    expect(first.decision).toEqual({
      kind: "report",
      repeatsSinceLastReport: 0,
    });

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

    expect(third.decision).toEqual({
      kind: "report",
      repeatsSinceLastReport: 1,
    });
    expect(third.next.get("key-c")).toEqual({
      windowStartMs: atWindowEnd,
      suppressed: 0,
    });
  });

  it("reports when the clock has gone backwards relative to the stored window start", () => {
    const start = 1_000_000;
    const { next } = decideRepeat(new Map(), "key-d", start);

    const result = decideRepeat(next, "key-d", start - 1);

    expect(result.decision).toEqual({
      kind: "report",
      repeatsSinceLastReport: 0,
    });
    expect(result.next.get("key-d")).toEqual({
      windowStartMs: start - 1,
      suppressed: 0,
    });
  });

  it("keeps different keys independent", () => {
    const start = 1_000_000;
    const first = decideRepeat(new Map(), "key-e", start);
    const second = decideRepeat(first.next, "key-f", start);

    expect(second.decision).toEqual({
      kind: "report",
      repeatsSinceLastReport: 0,
    });
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
    ledger.set("current-key", {
      windowStartMs: currentWindowStart,
      suppressed: 2,
    });
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

  it("returns a report decision unchanged, without throwing, when the write fails", async () => {
    const io = fakeRepeatGateIo({
      read: async () => null,
      write: async () => {
        throw new Error("disk full");
      },
    });

    const decision = await recordCliFailureForSentry("dev", "key-z", io);

    expect(decision).toEqual({ kind: "report", repeatsSinceLastReport: 0 });
  });

  // A suppress decision cannot be remembered if the write that would have
  // recorded it fails - the next run would read the SAME on-disk window and
  // suppress again, silently, forever. So a write failure downgrades a
  // suppress to a fresh report instead of returning it unchanged; a report
  // decision (the case above) has nothing to lose from the same failure and
  // is returned as-is.
  it("downgrades a suppress decision to a fresh report when the write fails", async () => {
    const nowMs = 1_000_000;
    const openWindowLedger = JSON.stringify({
      version: 1,
      entries: {
        "key-suppress": {
          windowStartMs: nowMs - 10 * 60 * 1000,
          suppressed: 2,
        },
      },
    });
    const io = fakeRepeatGateIo({
      now: () => nowMs,
      read: async () => openWindowLedger,
      write: async () => {
        throw new Error("disk full");
      },
    });

    const decision = await recordCliFailureForSentry("dev", "key-suppress", io);

    expect(decision).toEqual({ kind: "report", repeatsSinceLastReport: 0 });
  });

  it("control: the same ledger with a write that succeeds gives the real suppress decision", async () => {
    const nowMs = 1_000_000;
    const openWindowLedger = JSON.stringify({
      version: 1,
      entries: {
        "key-suppress": {
          windowStartMs: nowMs - 10 * 60 * 1000,
          suppressed: 2,
        },
      },
    });
    const io = fakeRepeatGateIo({
      now: () => nowMs,
      read: async () => openWindowLedger,
      write: async () => {},
    });

    const decision = await recordCliFailureForSentry("dev", "key-suppress", io);

    expect(decision).toEqual({ kind: "suppress", repeatsInWindow: 3 });
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
