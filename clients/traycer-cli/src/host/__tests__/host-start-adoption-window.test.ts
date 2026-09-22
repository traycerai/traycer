import { describe, expect, it } from "vitest";
import {
  HOST_START_ADOPTION_ACK_WAIT_MS,
  HOST_START_ADOPTION_MAX_AGE_MS,
  HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS,
  SUPERVISOR_LAUNCH_MARGIN_MS,
  SUPERVISOR_SPAWN_ACK_MARGIN_MS,
} from "../host-start-adoption";
import {
  LAUNCHCTL_CALL_TIMEOUT_MS,
  LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS,
  LAUNCHCTL_RECYCLE_TIMEOUT_MS,
} from "../../service/platforms/macos";
import { SYSTEMCTL_JOB_TIMEOUT_MS } from "../../service/platforms/linux";
import { WINDOWS_RUN_SPAWN_EDGE_BOUND_MS } from "../../service/platforms/windows";
import {
  WINDOWS_PROCESS_KILL_TIMEOUT_MS,
  WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
  WINDOWS_SCHTASKS_END_TIMEOUT_MS,
  WINDOWS_SCHTASKS_RUN_TIMEOUT_MS,
  WINDOWS_START_SPAWN_VERIFY_MS,
} from "@traycer/protocol/host/lifecycle-constants";

// Every bound this window is derived from, so a change to any one of them
// cannot silently widen or narrow the window without a value pin here
// reddening first.
const NAMED_SPAWN_EDGE_BOUNDS = [
  ["LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS", LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS],
  ["SYSTEMCTL_JOB_TIMEOUT_MS", SYSTEMCTL_JOB_TIMEOUT_MS],
  ["WINDOWS_RUN_SPAWN_EDGE_BOUND_MS", WINDOWS_RUN_SPAWN_EDGE_BOUND_MS],
  ["LAUNCHCTL_RECYCLE_TIMEOUT_MS", LAUNCHCTL_RECYCLE_TIMEOUT_MS],
  ["LAUNCHCTL_CALL_TIMEOUT_MS", LAUNCHCTL_CALL_TIMEOUT_MS],
] as const;

// The one predicate every "fits inside the window" assertion below shares,
// so it is checked once, not re-typed at each call site.
function fits(bound: number, window: number): boolean {
  return bound + SUPERVISOR_LAUNCH_MARGIN_MS <= window;
}

describe("host-start adoption window — composition", () => {
  it("HOST_START_ADOPTION_MAX_AGE_MS is the spawn-edge bound plus the launch margin", () => {
    expect(HOST_START_ADOPTION_MAX_AGE_MS).toBe(
      HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS + SUPERVISOR_LAUNCH_MARGIN_MS,
    );
  });

  it("HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS is the max of the five named per-platform bounds", () => {
    expect(HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS).toBe(
      Math.max(...NAMED_SPAWN_EDGE_BOUNDS.map(([, value]) => value)),
    );
  });

  it("value pins: 120_000 / 80_000 / 40_000", () => {
    expect(HOST_START_ADOPTION_MAX_AGE_MS).toBe(120_000);
    expect(HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS).toBe(80_000);
    expect(SUPERVISOR_LAUNCH_MARGIN_MS).toBe(40_000);
  });

  it("the macOS install bound is composed of five launchctl-call timeouts plus the install kickstart", () => {
    // bootstrap, race re-probe, bootout, bootstrap again, post-race probe:
    // five LAUNCHCTL_CALL_TIMEOUT_MS, then the install kickstart itself.
    expect(LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(
      5 * LAUNCHCTL_CALL_TIMEOUT_MS + 30_000,
    );
  });

  it("the Windows bound is the run timeout plus the spawn-evidence verify window", () => {
    expect(WINDOWS_RUN_SPAWN_EDGE_BOUND_MS).toBe(
      WINDOWS_SCHTASKS_RUN_TIMEOUT_MS + WINDOWS_START_SPAWN_VERIFY_MS,
    );
    expect(WINDOWS_RUN_SPAWN_EDGE_BOUND_MS).toBe(45_000);
  });

  it.each(NAMED_SPAWN_EDGE_BOUNDS)(
    "%s fits inside the window with the launch margin added",
    (_name, bound) => {
      expect(fits(bound, HOST_START_ADOPTION_MAX_AGE_MS)).toBe(true);
    },
  );

  it("the ack-wait invariant: HOST_START_ADOPTION_ACK_WAIT_MS is at least the launch margin", () => {
    expect(HOST_START_ADOPTION_ACK_WAIT_MS).toBeGreaterThanOrEqual(
      SUPERVISOR_LAUNCH_MARGIN_MS,
    );
  });

  it("HOST_START_ADOPTION_ACK_WAIT_MS equals the launch margin plus the spawn-ack margin (50_000)", () => {
    expect(HOST_START_ADOPTION_ACK_WAIT_MS).toBe(
      SUPERVISOR_LAUNCH_MARGIN_MS + SUPERVISOR_SPAWN_ACK_MARGIN_MS,
    );
    expect(HOST_START_ADOPTION_ACK_WAIT_MS).toBe(50_000);
  });
});

describe("host-start adoption window — RED control on the OLD arrangement", () => {
  // These pin the actual regression this change fixes: under the OLD
  // arrangement (publish BEFORE the controller call, so every probe and
  // ownership check ahead of the actual spawn ran on the grant's clock), no
  // 60s window could admit the real worst-case field path - which is why the
  // fix moved the publish point instead of just widening the window. Say in
  // words: 60s and 72s WOULD fit a 120s window; they are judged against
  // their own OLD 60s window on purpose, because that is the window that was
  // actually in force when the bug shipped.
  const OLD_WINDOW_MS = 60_000;

  it("the old macOS field path (probe + probe + recycle = 60_000) does NOT fit the old 60s window", () => {
    const oldMacosFieldPathMs =
      LAUNCHCTL_CALL_TIMEOUT_MS +
      LAUNCHCTL_CALL_TIMEOUT_MS +
      LAUNCHCTL_RECYCLE_TIMEOUT_MS;
    expect(oldMacosFieldPathMs).toBe(60_000);
    expect(fits(oldMacosFieldPathMs, OLD_WINDOW_MS)).toBe(false);
    // The same sum WOULD fit the new 120s window - it just never got the
    // chance to, because it was measured against the window that existed
    // when the double-probe bug shipped.
    expect(fits(oldMacosFieldPathMs, HOST_START_ADOPTION_MAX_AGE_MS)).toBe(
      true,
    );
  });

  it("the old Linux install path (show-environment + daemon-reload + job timeout = 72_000) does NOT fit the old 60s window either", () => {
    const oldLinuxInstallPathMs = 10_000 + 10_000 + SYSTEMCTL_JOB_TIMEOUT_MS;
    expect(oldLinuxInstallPathMs).toBe(72_000);
    expect(fits(oldLinuxInstallPathMs, OLD_WINDOW_MS)).toBe(false);
    expect(fits(oldLinuxInstallPathMs, HOST_START_ADOPTION_MAX_AGE_MS)).toBe(
      true,
    );
  });

  it("the old Windows restart pre-edge sum does NOT fit even the NEW window - the reason no window could be derived without moving the publish point", () => {
    const oldWindowsRestartPreEdgeMs =
      WINDOWS_SCHTASKS_END_TIMEOUT_MS +
      4 * WINDOWS_PROCESS_SCAN_TIMEOUT_MS +
      3 * WINDOWS_PROCESS_KILL_TIMEOUT_MS +
      WINDOWS_RUN_SPAWN_EDGE_BOUND_MS;
    expect(fits(oldWindowsRestartPreEdgeMs, HOST_START_ADOPTION_MAX_AGE_MS)).toBe(
      false,
    );
  });

  it("every new post-edge bound DOES fit the new window", () => {
    for (const [, bound] of NAMED_SPAWN_EDGE_BOUNDS) {
      expect(fits(bound, HOST_START_ADOPTION_MAX_AGE_MS)).toBe(true);
    }
  });
});
