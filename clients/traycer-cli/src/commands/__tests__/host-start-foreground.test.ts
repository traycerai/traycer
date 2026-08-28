import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CLI audit CLI-012: `host start`'s foreground console must give an
// interactive user terminal feedback BEFORE the command does anything that
// can block (probe authority, incumbent check, target resolution, spawn) -
// and it must stay entirely silent for every caller that is not a person
// watching a terminal, so a service manager's own stdout or an NDJSON
// consumer's stream never gets the host log duplicated into it.
//
// Driven through the registered command (`buildProgram()` + `parseAsync`),
// with `runHostStart` and the tail follower stubbed so no real spawn/poll
// ever happens - matches `cli-entrypoint-registration.test.ts`'s convention
// for exercising the real commander wiring in-process.

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  startTailCalls: [] as string[],
  writes: [] as string[],
}));

// The foreground console writes synchronously through `writeStdoutSync` so its
// output survives the supervisor's bare `process.exit`; intercept that seam.
vi.mock("../../runner/std-write", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../runner/std-write")>();
  return {
    ...actual,
    writeStdoutSync: (chunk: Buffer) => {
      mocks.writes.push(chunk.toString("utf8"));
      mocks.order.push(`write:${chunk.toString("utf8")}`);
    },
  };
});

import type { RunHostStartDeps, RunHostStartOptions } from "../host-start";
import type { LogTail, LogTailOptions } from "../../host/log-tail";

vi.mock("../../commands/host-start", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../commands/host-start")>();
  return {
    ...actual,
    runHostStart: async (
      _opts: RunHostStartOptions,
      _injected: Partial<RunHostStartDeps>,
    ): Promise<void> => {
      mocks.order.push("runHostStart-called");
    },
  };
});

vi.mock("../../host/log-tail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../host/log-tail")>();
  return {
    ...actual,
    startLogTail: (options: LogTailOptions): LogTail => {
      mocks.startTailCalls.push(options.path);
      return { stop: () => undefined };
    },
  };
});

import { buildProgram } from "../../index";

function setIsTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

describe("host start - foreground console wiring", () => {
  let originalIsTty: boolean | undefined;

  beforeEach(() => {
    originalIsTty = process.stdout.isTTY;
    mocks.order = [];
    mocks.startTailCalls = [];
    mocks.writes = [];
  });

  afterEach(() => {
    setIsTty(originalIsTty);
  });

  it("writes the banner before runHostStart's first await on an interactive (TTY, no flags) invocation", async () => {
    setIsTty(true);

    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["host", "start"], { from: "user" });

    // No tail is ever started: there is no mirroring mode. Writing log volume
    // from the supervisor's own event loop blocks on a TTY and can stop Ctrl-C
    // reaching the host.
    expect(mocks.startTailCalls).toHaveLength(0);
    const runHostStartIndex = mocks.order.indexOf("runHostStart-called");
    expect(runHostStartIndex).toBeGreaterThan(0);
    // Everything before the mocked runHostStart call is the console's own
    // synchronous output - the real command's first await (probe authority,
    // incumbent check, target resolution, spawn) lives inside runHostStart,
    // so the banner strictly precedes all of it.
    const beforeRunHostStart = mocks.order.slice(0, runHostStartIndex);
    const banner = beforeRunHostStart
      .filter((entry) => entry.startsWith("write:"))
      .join("");
    expect(banner.length).toBeGreaterThan(0);
    expect(banner).toContain("Running the Traycer host in the foreground");
    expect(banner).toContain("Ctrl-C");
    expect(banner).toContain("traycer host service start");
    expect(banner).toContain("traycer host logs --follow");
  });

  it("a service-manager invocation produces no banner and starts no tail", async () => {
    // TTY true on purpose: serviceManaged must win over interactivity, per
    // resolveForegroundStartMode's ordering (foreground-console.test.ts pins
    // the pure decision; this pins it end-to-end through the real command).
    setIsTty(true);

    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(
      [
        "host",
        "start",
        "--service-label",
        "ai.traycer.host",
        "--transition-id",
        "transition-1",
        "--probe-nonce",
        "nonce-1",
      ],
      { from: "user" },
    );

    expect(mocks.startTailCalls).toHaveLength(0);
    expect(
      mocks.order.some((entry) => entry.includes("Running the Traycer host")),
    ).toBe(false);
  });

  it("a non-TTY invocation produces no banner and does not duplicate the host log into stdout", async () => {
    setIsTty(false);

    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["host", "start"], { from: "user" });

    expect(mocks.startTailCalls).toHaveLength(0);
    expect(
      mocks.order.some((entry) => entry.includes("Running the Traycer host")),
    ).toBe(false);
  });
});
