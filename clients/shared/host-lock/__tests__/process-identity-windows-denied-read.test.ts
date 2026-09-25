import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatWindowsProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import {
  getPublishedProcessIdentityVerdict,
  readLiveProcessStartTimeMs,
  verifyProcessIdentity,
  verifyProcessIdentityAsync,
  type ProcessIdentityToken,
} from "../process-identity";

// RED-FIRST, through the real spawn boundary rather than a reader seam.
//
// These tests call ONLY `verifyProcessIdentity`, `verifyProcessIdentityAsync`,
// `getPublishedProcessIdentityVerdict` and `readLiveProcessStartTimeMs` - the
// four entry points that exist, unchanged in shape, on both sides of the
// Windows denied-read fix. On the pre-fix bytes an exact read that is DENIED
// (a session-0 service, an elevated holder read by an unelevated caller) has
// no fallback at all, so every one of these verdicts stays `"indeterminate"`
// forever. A test built on the NEW reader seams
// (`__setWindowsDeniedReadCreationReaderForTest` and friends) would fail on
// the pre-fix bytes with an IMPORT error - those seams do not exist yet -
// rather than a wrong verdict, so this file goes around the readers entirely
// and drives the real `tasklist` / `powershell` spawn `execFileSync` and
// `execFile` make, faked here.
//
// See `process-identity-windows-denied-read-seams.test.ts` for the
// post-fix-only seam-based coverage (the tolerance edge, the "no fallback for
// a non-Windows token" gate) - that file needs the new seams to exist, so it
// is deliberately kept out of the red-proof swap.

interface Win32Scenario {
  readonly pid: number;
  readonly livenessAlive: boolean;
  readonly exactRead: "denied" | { readonly iso: string };
  readonly fallback:
    | "unexpected"
    | "non-zero"
    | "readable"
    | { readonly deniedDmtf: string };
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

let scenario: Win32Scenario | null = null;
const calls: RecordedCall[] = [];

class SimulatedNonZeroExit extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Command failed");
    this.status = status;
  }
}

function scriptTextFromArgs(args: readonly string[]): string {
  const index = args.indexOf("-Command");
  const script = index >= 0 ? args[index + 1] : undefined;
  return script === undefined ? "" : script;
}

// The fallback script is `buildWindowsDeniedReadFallbackScript`'s text - it
// calls `.get_StartTime()` as a method and inspects a WMI row.
// `readWindowsProcessStartTimeMs` / the identity exact read use
// `.StartTime.ToUniversalTime()` (a property, never a method call) and never
// mention WMI, so the two are never ambiguous.
function isFallbackScript(script: string): boolean {
  return script.includes("get_StartTime()") || script.includes("Get-WmiObject");
}

function dispatchWin32Command(
  command: string,
  args: readonly string[],
): string {
  calls.push({ command, args: [...args] });
  if (scenario === null) {
    throw new Error("win32 scenario not configured for this test");
  }
  if (command === "tasklist") {
    return scenario.livenessAlive
      ? `"tasklist.exe","${String(scenario.pid)}","Services","0","10,000 K"\r\n`
      : "";
  }
  if (command !== "powershell") {
    throw new Error(`unexpected command in win32 scenario: ${command}`);
  }
  const script = scriptTextFromArgs(args);
  if (isFallbackScript(script)) {
    const fallback = scenario.fallback;
    if (fallback === "unexpected") {
      throw new Error(
        "the denied-read fallback script was not expected to run in this test",
      );
    }
    if (fallback === "non-zero") {
      throw new SimulatedNonZeroExit(3);
    }
    if (fallback === "readable") {
      return "readable\r\n";
    }
    return `denied ${fallback.deniedDmtf}\r\n`;
  }
  // The exact-read script: the property getter, never the fallback's method
  // call. A real denied read never throws from here - `.StartTime` on a
  // process this context cannot open returns `$null`, and `.ToUniversalTime()`
  // on `$null` is what actually raises - but the observable effect at this
  // boundary is the same either way: the child process exits non-zero and
  // `execFileSync`/`execFile` report a failure.
  if (scenario.exactRead === "denied") {
    throw new Error("You cannot call a method on a null-valued expression.");
  }
  return `${scenario.exactRead.iso}\r\n`;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (command: string, args: readonly string[]): string =>
      dispatchWin32Command(command, args),
    execFile: (
      command: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ): void => {
      try {
        callback(null, dispatchWin32Command(command, args), "");
      } catch (error) {
        callback(
          error instanceof Error ? error : new Error(String(error)),
          "",
          "",
        );
      }
    },
  };
});

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);
if (originalPlatformDescriptor === undefined) {
  throw new Error("process.platform has no own property descriptor");
}
const ORIGINAL_PLATFORM_DESCRIPTOR: PropertyDescriptor =
  originalPlatformDescriptor;

beforeEach(() => {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  calls.length = 0;
  scenario = null;
});

afterEach(() => {
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM_DESCRIPTOR);
  scenario = null;
});

// Offset from this real test-runner's own pid so a token pid can never
// collide with `process.pid` and trip `verifyProcessIdentity`'s own-process
// special case, which bypasses the spawn seam entirely.
const TEST_PID = process.pid + 424_242;

// The recorded token's 7th fractional digit is non-zero on purpose - WMI's
// CreationDate carries only six, so a reader that failed to truncate before
// comparing would see this pair as `different` even for the SAME instant.
const RECORDED_ISO = "2026-01-02T03:04:05.1234567Z";
const RECORDED_TOKEN = formatWindowsProcessStartIdentity(RECORDED_ISO);
if (RECORDED_TOKEN === null) {
  throw new Error("fixture Windows token failed to format");
}

function tokenFor(startIdentity: string | null): ProcessIdentityToken {
  return { pid: TEST_PID, startedAtMs: null, startIdentity };
}

function fallbackCalls(): readonly RecordedCall[] {
  return calls.filter(
    (call) =>
      call.command === "powershell" &&
      isFallbackScript(scriptTextFromArgs(call.args)),
  );
}

describe("verifyProcessIdentity (sync): Windows denied-read fallback", () => {
  it("the elevated holder: exact read denied, WMI creation matches within tolerance -> alive-same", () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: "denied",
      fallback: { deniedDmtf: "20260102030405.123456+000" },
    };

    expect(verifyProcessIdentity(tokenFor(RECORDED_TOKEN))).toBe("alive-same");
  });

  it("exact read denied, WMI creation 2 microseconds later -> alive-different", () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: "denied",
      fallback: { deniedDmtf: "20260102030405.123458+000" },
    };

    expect(verifyProcessIdentity(tokenFor(RECORDED_TOKEN))).toBe(
      "alive-different",
    );
  });

  it("exact read denied, fallback exits non-zero -> indeterminate (control: unchanged from today)", () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: "denied",
      fallback: "non-zero",
    };

    expect(verifyProcessIdentity(tokenFor(RECORDED_TOKEN))).toBe(
      "indeterminate",
    );
  });

  it("exact read succeeds -> compares exactly as before, and the fallback script is never spawned (control)", () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: { iso: RECORDED_ISO },
      fallback: "unexpected",
    };

    expect(verifyProcessIdentity(tokenFor(RECORDED_TOKEN))).toBe("alive-same");
    expect(fallbackCalls()).toHaveLength(0);
  });
});

describe("verifyProcessIdentityAsync: Windows denied-read fallback", () => {
  it("the elevated holder: exact read denied, WMI creation matches within tolerance -> alive-same", async () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: "denied",
      fallback: { deniedDmtf: "20260102030405.123456+000" },
    };

    await expect(
      verifyProcessIdentityAsync(tokenFor(RECORDED_TOKEN)),
    ).resolves.toBe("alive-same");
  });

  it("exact read denied, WMI creation 2 microseconds later -> alive-different", async () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: "denied",
      fallback: { deniedDmtf: "20260102030405.123458+000" },
    };

    await expect(
      verifyProcessIdentityAsync(tokenFor(RECORDED_TOKEN)),
    ).resolves.toBe("alive-different");
  });

  it("exact read denied, fallback exits non-zero -> indeterminate (control: unchanged from today)", async () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: "denied",
      fallback: "non-zero",
    };

    await expect(
      verifyProcessIdentityAsync(tokenFor(RECORDED_TOKEN)),
    ).resolves.toBe("indeterminate");
  });

  it("exact read succeeds -> compares exactly as before, and the fallback script is never spawned (control)", async () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: { iso: RECORDED_ISO },
      fallback: "unexpected",
    };

    await expect(
      verifyProcessIdentityAsync(tokenFor(RECORDED_TOKEN)),
    ).resolves.toBe("alive-same");
    expect(fallbackCalls()).toHaveLength(0);
  });
});

describe("getPublishedProcessIdentityVerdict: Windows denied-read fallback", () => {
  it("the elevated holder: exact read denied, WMI creation matches within tolerance -> current", async () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: "denied",
      fallback: { deniedDmtf: "20260102030405.123456+000" },
    };

    await expect(
      getPublishedProcessIdentityVerdict(TEST_PID, RECORDED_TOKEN),
    ).resolves.toBe("current");
  });

  it("exact read denied, WMI creation 2 microseconds later -> mismatch", async () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: "denied",
      fallback: { deniedDmtf: "20260102030405.123458+000" },
    };

    await expect(
      getPublishedProcessIdentityVerdict(TEST_PID, RECORDED_TOKEN),
    ).resolves.toBe("mismatch");
  });

  it("exact read denied, fallback exits non-zero -> indeterminate (control: unchanged from today)", async () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: "denied",
      fallback: "non-zero",
    };

    await expect(
      getPublishedProcessIdentityVerdict(TEST_PID, RECORDED_TOKEN),
    ).resolves.toBe("indeterminate");
  });

  it("exact read succeeds -> compares exactly as before, and the fallback script is never spawned (control)", async () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: { iso: RECORDED_ISO },
      fallback: "unexpected",
    };

    await expect(
      getPublishedProcessIdentityVerdict(TEST_PID, RECORDED_TOKEN),
    ).resolves.toBe("current");
    expect(fallbackCalls()).toHaveLength(0);
  });
});

describe("readLiveProcessStartTimeMs: falls back to WMI creation, floored to the millisecond", () => {
  const FIELDS_MS = Date.UTC(2026, 0, 2, 3, 4, 5);

  it("a creation time ending in microsecond 999 floors DOWN to the millisecond below", () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: "denied",
      fallback: { deniedDmtf: "20260102030405.999999+000" },
    };

    expect(readLiveProcessStartTimeMs(TEST_PID)).toBe(FIELDS_MS + 999);
  });

  it("a creation time ending in microsecond 000 is exactly that millisecond", () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      exactRead: "denied",
      fallback: { deniedDmtf: "20260102030405.000000+000" },
    };

    expect(readLiveProcessStartTimeMs(TEST_PID)).toBe(FIELDS_MS);
  });
});
