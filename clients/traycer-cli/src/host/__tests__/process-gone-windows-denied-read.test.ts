import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatWindowsProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import { hostHolderProcessGone, type HostHolderRecord } from "../holder-record";
import {
  publishedHostProcessGone,
  type HostPidMetadata,
} from "../pid-metadata";

// RED-FIRST, through the real spawn boundary - the same technique as
// `clients/shared/host-lock/__tests__/process-identity-windows-denied-
// read.test.ts`, duplicated here because these two CLI call sites
// (`hostHolderProcessGone`, `publishedHostProcessGone`) are their own module
// graph in their own vitest package. Both are fully synchronous, so only
// `execFileSync` needs faking.
//
// The scenario this proves: a Windows session-0 service (sshd is the
// canonical example) takes over the pid a dead installer or host process
// used to hold. The exact `Get-Process ... StartTime` read is denied for
// that pid from this security context, so before the fix these two "is the
// recorded owner provably gone" predicates could never tell a live
// impersonator from the process they used to watch - they read `false`
// forever. The fix's WMI fallback lets them answer `true`.

interface Win32Scenario {
  readonly pid: number;
  readonly livenessAlive: boolean;
  readonly fallback: { readonly deniedDmtf: string };
}

let scenario: Win32Scenario | null = null;

function scriptTextFromArgs(args: readonly string[]): string {
  const index = args.indexOf("-Command");
  const script = index >= 0 ? args[index + 1] : undefined;
  return script === undefined ? "" : script;
}

function isFallbackScript(script: string): boolean {
  return script.includes("get_StartTime()") || script.includes("Get-WmiObject");
}

function dispatchWin32Command(
  command: string,
  args: readonly string[],
): string {
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
    return `denied ${scenario.fallback.deniedDmtf}\r\n`;
  }
  // The exact-read script: always denied in this scenario, which is the
  // whole point of a session-0 service holding the pid.
  throw new Error("You cannot call a method on a null-valued expression.");
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (command: string, args: readonly string[]): string =>
      dispatchWin32Command(command, args),
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
  scenario = null;
});

afterEach(() => {
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM_DESCRIPTOR);
  scenario = null;
});

// Offset from this real test-runner's own pid - `isProcessAlive`'s liveness
// probe has no own-pid special case, but keeping every fixture pid clear of
// the real runner pid avoids the mock ever seeing a call this scenario
// didn't script.
const TEST_PID = process.pid + 776_655;

const RECORDED_ISO = "2026-05-06T07:08:09.1234567Z";
const RECORDED_TOKEN = formatWindowsProcessStartIdentity(RECORDED_ISO);
if (RECORDED_TOKEN === null) {
  throw new Error("fixture Windows token failed to format");
}

function holder(processStartIdentity: string | null): HostHolderRecord {
  return { pid: TEST_PID, processStartIdentity };
}

function pidMetadata(processStartIdentity: string | null): HostPidMetadata {
  return {
    pid: TEST_PID,
    hostId: "host-1",
    version: "1.0.0",
    websocketUrl: "ws://127.0.0.1:7100/rpc",
    startedAt: "2026-09-06T22:00:00.000Z",
    processStartIdentity,
    processStartIdentityRead:
      processStartIdentity === null ? "absent" : "present",
    layer0: null,
    layer0Slot: null,
  };
}

describe("hostHolderProcessGone: a Windows session-0 service that took over a dead holder's pid", () => {
  it("reports gone when the exact read is denied and WMI creation differs by more than 1 microsecond", () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      fallback: { deniedDmtf: "20260506070809.123458+000" },
    };

    expect(hostHolderProcessGone(holder(RECORDED_TOKEN))).toBe(true);
  });

  it("control: does not report gone when WMI creation matches the recorded token", () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      fallback: { deniedDmtf: "20260506070809.123456+000" },
    };

    expect(hostHolderProcessGone(holder(RECORDED_TOKEN))).toBe(false);
  });
});

describe("publishedHostProcessGone: the same session-0 takeover through pid.json", () => {
  it("reports gone when the exact read is denied and WMI creation differs by more than 1 microsecond", () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      fallback: { deniedDmtf: "20260506070809.123458+000" },
    };

    expect(publishedHostProcessGone(pidMetadata(RECORDED_TOKEN))).toBe(true);
  });

  it("control: does not report gone when WMI creation matches the recorded token", () => {
    scenario = {
      pid: TEST_PID,
      livenessAlive: true,
      fallback: { deniedDmtf: "20260506070809.123456+000" },
    };

    expect(publishedHostProcessGone(pidMetadata(RECORDED_TOKEN))).toBe(false);
  });
});
