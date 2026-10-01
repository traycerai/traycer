import { describe, expect, it } from "vitest";
import {
  HOST_START_ADOPTION_ACK_WAIT_MS,
  HOST_START_ADOPTION_MAX_AGE_MS,
  HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS,
  LAUNCHCTL_CALL_TIMEOUT_MS,
  LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS,
  LAUNCHCTL_RECYCLE_TIMEOUT_MS,
  SUPERVISOR_LAUNCH_MARGIN_MS,
  SUPERVISOR_SPAWN_ACK_MARGIN_MS,
  SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS,
  SYSTEMCTL_JOB_TIMEOUT_MS,
  WINDOWS_ACCOUNT_SID_LOOKUP_TIMEOUT_MS,
  WINDOWS_INSTALL_CONTROLLER_RETURN_BOUND_MS,
  WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS,
  WINDOWS_RUN_SPAWN_EDGE_BOUND_MS,
  WINDOWS_TASK_CREATE_BUDGET_MS,
  WINDOWS_TASK_OWNERSHIP_READ_BOUND_MS,
} from "../../service/spawn-edge-bounds";
import {
  WINDOWS_PROCESS_KILL_TIMEOUT_MS,
  WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
  WINDOWS_SCHTASKS_END_TIMEOUT_MS,
  WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS,
  WINDOWS_SCHTASKS_RUN_TIMEOUT_MS,
  WINDOWS_START_SPAWN_POLL_MS,
  WINDOWS_START_SPAWN_VERIFY_MS,
} from "@traycer/protocol/host/lifecycle-constants";

// R4 §44: the Windows install bound now runs through the gated `/Create`
// step budget (§42/§43) rather than a bare create-timeout-plus-run
// composition, which widens it past every other platform's bound and makes
// Windows install - not macOS install - both the bound that sizes the window
// and the lease-end equality case.
//
// RED-FIRST against the pre-R4 worktree: `WINDOWS_ACCOUNT_SID_LOOKUP_TIMEOUT_MS`,
// `WINDOWS_TASK_OWNERSHIP_READ_BOUND_MS`, `WINDOWS_TASK_CREATE_BUDGET_MS` and
// `WINDOWS_INSTALL_CONTROLLER_RETURN_BOUND_MS` import as `undefined` there,
// `WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS` is still 75_000 (not 125_000), and
// every pin below derived from the new 175_250/185_250 window is wrong
// against the old 130_000/140_000 one.

// The Windows restart throw tail: `withStopIntent`'s `restart` decorator
// (service/index.ts ~:560-569) runs `retireIntentIfHostSurvived` ->
// `findLiveIncumbentHost` (host/incumbent-check.ts ~:52-86) INSIDE the
// controller call before rethrowing, on every Windows throw after `/Run`
// (registration-committed, so the lease wait follows the tail - see the
// leaf comment in `spawn-edge-bounds.ts`). Private literals in shared code,
// not exported, so declared here rather than imported; do not change the
// shared code to export them.
//
// `ACTIVITY_PROBE_TIMEOUT_MS`, clients/shared/host-client/host-activity-probe.ts:14
const WINDOWS_RESTART_ACTIVITY_PROBE_TIMEOUT_MS = 1_500;
// The async `tasklist` liveness probe's timeout, clients/shared/host-lock/process-identity.ts:1103-1107
const WINDOWS_RESTART_TASKLIST_LIVENESS_TIMEOUT_MS = 3_000;
// The `powershell` start-identity read's timeout (`WINDOWS_START_IDENTITY_TIMEOUT_MS`), clients/shared/host-lock/process-identity.ts:837
const WINDOWS_RESTART_POWERSHELL_START_TIME_TIMEOUT_MS = 5_000;
// The denied-read fallback's timeout, run after a start-identity read that
// came back empty against a recorded Windows identity
// (`observeProcessStartAsync`), clients/shared/host-lock/process-identity.ts:1036-1039
const WINDOWS_RESTART_DENIED_READ_FALLBACK_TIMEOUT_MS = 5_000;

// Every bound the window is derived from, so a change to any one of them
// cannot silently widen or narrow the window without a value pin here
// reddening first. Eight now, all from the leaf (`service/spawn-edge-bounds.ts`)
// rather than from the platform modules or from `host-start-adoption.ts`,
// which defines none of them. `WINDOWS_INSTALL_CONTROLLER_RETURN_BOUND_MS` is
// the eighth (R4): the install's `/Create` step budget plus the `/Run` gate's
// own read plus the run edge itself, which is now the one that wins.
const NAMED_SPAWN_EDGE_BOUNDS = [
  [
    "LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS",
    LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS,
  ],
  ["WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS", WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS],
  [
    "SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS",
    SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS,
  ],
  ["SYSTEMCTL_JOB_TIMEOUT_MS", SYSTEMCTL_JOB_TIMEOUT_MS],
  ["WINDOWS_RUN_SPAWN_EDGE_BOUND_MS", WINDOWS_RUN_SPAWN_EDGE_BOUND_MS],
  ["LAUNCHCTL_RECYCLE_TIMEOUT_MS", LAUNCHCTL_RECYCLE_TIMEOUT_MS],
  ["LAUNCHCTL_CALL_TIMEOUT_MS", LAUNCHCTL_CALL_TIMEOUT_MS],
  [
    "WINDOWS_INSTALL_CONTROLLER_RETURN_BOUND_MS",
    WINDOWS_INSTALL_CONTROLLER_RETURN_BOUND_MS,
  ],
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
    expect(HOST_START_ADOPTION_MAX_AGE_MS).toBe(175_250);
  });

  it("HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS is the max of all eight named bounds, and Windows install's controller-return bound is the one that wins", () => {
    expect(HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS).toBe(
      Math.max(...NAMED_SPAWN_EDGE_BOUNDS.map(([, value]) => value)),
    );
    expect(HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS).toBe(135_250);
    expect(HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS).toBe(
      WINDOWS_INSTALL_CONTROLLER_RETURN_BOUND_MS,
    );
  });

  it("value pins for every named bound", () => {
    expect(LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(90_000); // macOS install
    expect(WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(125_000); // Windows install (R4: through the create budget)
    expect(SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(62_000); // Linux install
    expect(SYSTEMCTL_JOB_TIMEOUT_MS).toBe(52_000); // Linux job
    expect(WINDOWS_RUN_SPAWN_EDGE_BOUND_MS).toBe(45_000); // Windows run
    expect(LAUNCHCTL_RECYCLE_TIMEOUT_MS).toBe(40_000); // macOS recycle
    expect(LAUNCHCTL_CALL_TIMEOUT_MS).toBe(10_000); // call
    expect(WINDOWS_INSTALL_CONTROLLER_RETURN_BOUND_MS).toBe(135_250); // Windows install controller-return
  });

  it("R4: the new Windows Task Scheduler bounds pin", () => {
    expect(WINDOWS_ACCOUNT_SID_LOOKUP_TIMEOUT_MS).toBe(15_000);
    expect(WINDOWS_TASK_OWNERSHIP_READ_BOUND_MS).toBe(
      WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS + WINDOWS_ACCOUNT_SID_LOOKUP_TIMEOUT_MS,
    );
    expect(WINDOWS_TASK_OWNERSHIP_READ_BOUND_MS).toBe(25_000);
    expect(WINDOWS_TASK_CREATE_BUDGET_MS).toBe(55_000);
  });

  it("SUPERVISOR_LAUNCH_MARGIN_MS and SUPERVISOR_SPAWN_ACK_MARGIN_MS pins (unchanged by R4)", () => {
    expect(SUPERVISOR_LAUNCH_MARGIN_MS).toBe(40_000);
    expect(SUPERVISOR_SPAWN_ACK_MARGIN_MS).toBe(10_000);
  });

  it("the macOS install bound is composed of six launchctl-call timeouts plus the install kickstart", () => {
    // bootout, bootstrap (edge 1), print, bootout, bootstrap (edge 2), print:
    // six LAUNCHCTL_CALL_TIMEOUT_MS, then the install kickstart itself (edge 3).
    expect(LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(
      6 * LAUNCHCTL_CALL_TIMEOUT_MS + 30_000,
    );
  });

  it("the Windows run bound is the run timeout plus the spawn-evidence verify window", () => {
    expect(WINDOWS_RUN_SPAWN_EDGE_BOUND_MS).toBe(
      WINDOWS_SCHTASKS_RUN_TIMEOUT_MS + WINDOWS_START_SPAWN_VERIFY_MS,
    );
    expect(WINDOWS_RUN_SPAWN_EDGE_BOUND_MS).toBe(45_000);
  });

  it("R4: the Windows install bound is the create budget plus the /Run gate's own read plus the Windows run bound", () => {
    expect(WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(
      WINDOWS_TASK_CREATE_BUDGET_MS +
        WINDOWS_TASK_OWNERSHIP_READ_BOUND_MS +
        WINDOWS_RUN_SPAWN_EDGE_BOUND_MS,
    );
    expect(WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(125_000);
  });

  it("the Linux install bound is the call timeout plus the systemctl job timeout", () => {
    expect(SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(
      10_000 + SYSTEMCTL_JOB_TIMEOUT_MS,
    );
    expect(SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(62_000);
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

  it("HOST_START_ADOPTION_ACK_WAIT_MS equals the launch margin plus the spawn-ack margin (50_000, unchanged by R4)", () => {
    expect(HOST_START_ADOPTION_ACK_WAIT_MS).toBe(
      SUPERVISOR_LAUNCH_MARGIN_MS + SUPERVISOR_SPAWN_ACK_MARGIN_MS,
    );
    expect(HOST_START_ADOPTION_ACK_WAIT_MS).toBe(50_000);
  });
});

describe("host-start adoption window — the lease-end invariant", () => {
  // A published lease can outlive the window itself, by at most
  // `SUPERVISOR_SPAWN_ACK_MARGIN_MS` (see `HOST_START_ADOPTION_MAX_AGE_MS`'s
  // doc comment in `spawn-edge-bounds.ts`): the ack wait starts when the
  // controller call RETURNS - no earlier than the launch it requested - so
  // the latest a lease can still legitimately be waited on is
  // (controller-return time) + `HOST_START_ADOPTION_ACK_WAIT_MS`. That must
  // never exceed `HOST_START_ADOPTION_MAX_AGE_MS + SUPERVISOR_SPAWN_ACK_MARGIN_MS`
  // (185_250, R4) - the safety cap the doc comment names directly ("a lease
  // can outlive the window, by at most SUPERVISOR_SPAWN_ACK_MARGIN_MS").
  //
  // What the rows below model, mirroring `HOST_START_ADOPTION_MAX_AGE_MS`'s
  // doc comment in `spawn-edge-bounds.ts` ("These are TIMER-MODEL bounds"):
  //
  //   - Every row is a TIMER-MODEL bound for a call holding its OWN
  //     capability - every awaited timeout at its ceiling, not a measured or
  //     typical cost.
  //   - An ADOPTED capability (`--attempt-adoption`) is NOT one of these
  //     rows and needs none: its authority re-check re-probes the parent's
  //     process identity on every post-edge check, uncached by design, so it
  //     can exceed a row by N checks x that probe's timeout - macOS 13 x 3s
  //     (`ps`), Windows 7 x 8s (`tasklist` + `powershell`). That excess is in
  //     the safe direction (a proof consumed after the window reads as
  //     expired and takes ordinary admission), which is exactly why the
  //     timer model deliberately does not widen a row to cover it.
  //   - R4: the Windows install row now reaches the cap exactly - it is the
  //     bound that sizes the window - not the macOS install row. Untimed
  //     local work (file writes, each child's exit after its timeout fires)
  //     is outside every row, so that call ends at <= 185.25s plus that
  //     fs/exit latency - a safe-direction late admission, the same way the
  //     adopted-capability excess above is.
  const LEASE_END_CAP_MS =
    HOST_START_ADOPTION_MAX_AGE_MS + SUPERVISOR_SPAWN_ACK_MARGIN_MS;

  it("the lease-end cap is 185_250 (R4), i.e. the window plus the spawn-ack margin", () => {
    expect(LEASE_END_CAP_MS).toBe(185_250);
  });

  it("Windows install: the create-budget controller-return bound plus the ack wait is the cap itself — the EQUALITY case (R4)", () => {
    // A failed verify polls once more, then queries Last Run Result, before
    // the controller call returns (`WINDOWS_START_SPAWN_POLL_MS` +
    // `WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS`), on top of the create-budget-gated
    // spawn-edge bound - `WINDOWS_INSTALL_CONTROLLER_RETURN_BOUND_MS` names
    // that sum directly. Lease end = that bound + ACK_WAIT_MS, which is
    // exactly window + ack margin, since this is now the bound the window is
    // sized by.
    const windowsInstallLeaseEndMs =
      WINDOWS_INSTALL_CONTROLLER_RETURN_BOUND_MS +
      HOST_START_ADOPTION_ACK_WAIT_MS;
    expect(windowsInstallLeaseEndMs).toBe(185_250);
    expect(windowsInstallLeaseEndMs).toBe(LEASE_END_CAP_MS);
  });

  it("macOS install: the kickstart-timeout controller return plus the ack wait, now UNDER the cap (R4)", () => {
    // On macOS, `installService`'s controller call returns right at the
    // spawn-edge bound - no extra query step - so the lease end is exactly
    // bound + ACK_WAIT_MS. R4 widened the window past this row: it no longer
    // reaches the cap, Windows install does (the row above).
    const macosInstallLeaseEndMs =
      LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS + HOST_START_ADOPTION_ACK_WAIT_MS;
    expect(macosInstallLeaseEndMs).toBe(140_000);
    expect(macosInstallLeaseEndMs).toBeLessThan(LEASE_END_CAP_MS);
  });

  it("Windows start/relaunchAfterRestart: the same poll-then-query-before-return shape off the run bound — lease end 105_250 (unchanged by R4)", () => {
    // `relaunchAfterRestart` (windows.ts ~:125) goes through
    // `runTaskAndVerifyStart` exactly like `start` does - same spawn-edge
    // bound, same one-poll-late-then-failed-verify-`/Query` shape before the
    // controller call returns - so one row covers both. `restart` gets its
    // OWN row below: unlike `start`/`relaunchAfterRestart`, a Windows
    // `restart` throw pays an extra retirement-probe tail before it
    // propagates. Unaffected by R4: this is the RUN bound, not the install
    // bound the create budget widened.
    const windowsRunLeaseEndMs =
      WINDOWS_RUN_SPAWN_EDGE_BOUND_MS +
      WINDOWS_START_SPAWN_POLL_MS +
      WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS +
      HOST_START_ADOPTION_ACK_WAIT_MS;
    expect(windowsRunLeaseEndMs).toBe(105_250);
    expect(windowsRunLeaseEndMs).toBeLessThanOrEqual(LEASE_END_CAP_MS);
  });

  it("Windows restart: the run-bound failure tail plus the stop-intent retirement probe, INSIDE the controller call — lease end 119_750 (unchanged by R4)", () => {
    // Every Windows throw after `/Run` is marked registration-committed, so
    // the lease wait follows the tail. `restart`'s `withStopIntent` decorator
    // (service/index.ts ~:560-569) runs `retireIntentIfHostSurvived` ->
    // `findLiveIncumbentHost` (host/incumbent-check.ts ~:52-86) on a throw,
    // BEFORE rethrowing - an activity probe plus a three-part process-identity
    // read (liveness, start identity, and the denied-read fallback when the
    // identity read comes back empty), all still inside the controller call
    // that the lease-end clock measures from. This is the RUN bound, not the
    // install bound the create budget widened.
    const windowsRestartTailMs =
      WINDOWS_RESTART_ACTIVITY_PROBE_TIMEOUT_MS +
      WINDOWS_RESTART_TASKLIST_LIVENESS_TIMEOUT_MS +
      WINDOWS_RESTART_POWERSHELL_START_TIME_TIMEOUT_MS +
      WINDOWS_RESTART_DENIED_READ_FALLBACK_TIMEOUT_MS;
    const windowsRestartLeaseEndMs =
      WINDOWS_RUN_SPAWN_EDGE_BOUND_MS +
      WINDOWS_START_SPAWN_POLL_MS +
      WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS +
      windowsRestartTailMs +
      HOST_START_ADOPTION_ACK_WAIT_MS;
    expect(windowsRestartTailMs).toBe(14_500);
    expect(windowsRestartLeaseEndMs).toBe(119_750);
    expect(windowsRestartLeaseEndMs).toBeLessThanOrEqual(LEASE_END_CAP_MS);
  });

  // The macOS and Linux restart paths' own throw tails (4.5s and 1.5s
  // respectively) need no row: neither is registration-committed at that
  // point, so both cancel the lease at the throw instead of extending it -
  // only a Windows throw after `/Run` is marked committed.

  it("Linux install: the controller call returns at the spawn-edge bound - no post-launch step any more - so lease end is bound + ACK_WAIT_MS = 112_000 (unchanged by R4)", () => {
    // Linger used to run AFTER `enable --now` and inside the controller
    // call's own return time, pushing the Linux install's post-launch cost
    // to 62s (the spawn-edge bound) + 30s (linger) + 50s (ack wait) = 142s,
    // over the (pre-R4) 140_000ms cap. Moving linger BEFORE the install edge
    // (see linux.ts `installService`'s doc comment) took it off the grant's
    // clock entirely, so the controller call now returns exactly at
    // SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS, the same shape macOS install
    // has (a query-before-return-free row) rather than the
    // query-before-return shape Windows has.
    const linuxInstallLeaseEndMs =
      SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS + HOST_START_ADOPTION_ACK_WAIT_MS;
    expect(linuxInstallLeaseEndMs).toBe(112_000);
    expect(linuxInstallLeaseEndMs).toBeLessThanOrEqual(LEASE_END_CAP_MS);
  });

  it("macOS start (plain kickstart): the ownership probe is pre-edge, so the controller call returns at the call timeout alone — lease end 60_000 (unchanged by R4)", () => {
    // `startService` (macos.ts ~:2717) probes ownership before its edge and
    // issues a plain `kickstartJob` (~:2029) after it - one
    // `LAUNCHCTL_CALL_TIMEOUT_MS` call, nothing else between the edge and the
    // controller call's return.
    const macosStartLeaseEndMs =
      LAUNCHCTL_CALL_TIMEOUT_MS + HOST_START_ADOPTION_ACK_WAIT_MS;
    expect(macosStartLeaseEndMs).toBe(60_000);
    expect(macosStartLeaseEndMs).toBeLessThanOrEqual(LEASE_END_CAP_MS);
  });

  it("macOS restart / relaunchAfterRestart (kickstart -k): the recycle timeout off the edge — lease end 90_000 (unchanged by R4)", () => {
    // A Desktop-managed restart's cooperative stand-down
    // (`restartDesktopManagedHost` ~:1946) is pre-edge, same as the ownership
    // probe above. `recycleJob` (~:2054) is `kickstart -k`, bounded by
    // `LAUNCHCTL_RECYCLE_TIMEOUT_MS` - and `relaunchServiceAfterRestart`
    // (~:2772) either recycles (this row, the larger of its two branches) or
    // falls through to a plain kickstart (the row above, dominated by this
    // one).
    const macosRestartLeaseEndMs =
      LAUNCHCTL_RECYCLE_TIMEOUT_MS + HOST_START_ADOPTION_ACK_WAIT_MS;
    expect(macosRestartLeaseEndMs).toBe(90_000);
    expect(macosRestartLeaseEndMs).toBeLessThanOrEqual(LEASE_END_CAP_MS);
  });

  it("Linux start / restart / relaunchAfterRestart: one systemctl job off the edge — lease end 102_000 (unchanged by R4)", () => {
    // `startService` and `restartService` (linux.ts) each issue exactly one
    // systemctl job after their spawn edge, bounded by
    // `SYSTEMCTL_JOB_TIMEOUT_MS`; `relaunchAfterRestart` picks one of the two,
    // never both, so one row covers all three.
    const linuxJobLeaseEndMs =
      SYSTEMCTL_JOB_TIMEOUT_MS + HOST_START_ADOPTION_ACK_WAIT_MS;
    expect(linuxJobLeaseEndMs).toBe(102_000);
    expect(linuxJobLeaseEndMs).toBeLessThanOrEqual(LEASE_END_CAP_MS);
  });

  // R4: two new rows, cancel-at-throw rather than wait-out-the-ack-margin
  // rows. Neither is registration-committed - the create budget's own
  // refusal, and the kept-disabled withdraw, both cancel the lease at the
  // point they end rather than waiting for an acknowledgement that is never
  // coming - so neither adds `HOST_START_ADOPTION_ACK_WAIT_MS` at all.

  it("R4: the create-budget failure cancels at its throw, so its lease ends by WINDOWS_TASK_CREATE_BUDGET_MS (55_000), well inside the cap", () => {
    expect(WINDOWS_TASK_CREATE_BUDGET_MS).toBeLessThanOrEqual(LEASE_END_CAP_MS);
    expect(WINDOWS_TASK_CREATE_BUDGET_MS).toBe(55_000);
  });

  it("R4: the kept-disabled install withdraws (no ack wait), so its lease also ends by 55_000", () => {
    // `installService` withdraws the spawn-edge lease instead of waiting it
    // out when the confirm-read finds the task disabled (`keepsDisabled`):
    // the install edge was already published, but nothing after it can ever
    // reach `/Run`, so its cost is bounded the same way the create budget's
    // own failure is - by the time it took to discover the disable, never by
    // the create budget's own ceiling plus an ack wait nobody will send.
    const keptDisabledLeaseEndMs = WINDOWS_TASK_CREATE_BUDGET_MS;
    expect(keptDisabledLeaseEndMs).toBe(55_000);
    expect(keptDisabledLeaseEndMs).toBeLessThanOrEqual(LEASE_END_CAP_MS);
  });

  // Every row above, by its controller-return bound (the lease end minus the
  // ack wait) and its lease end - the same eight named bounds the leaf
  // comment in `spawn-edge-bounds.ts` lists, by name. R4: Windows install is
  // first - the equality row.
  const windowsRestartTailMs =
    WINDOWS_RESTART_ACTIVITY_PROBE_TIMEOUT_MS +
    WINDOWS_RESTART_TASKLIST_LIVENESS_TIMEOUT_MS +
    WINDOWS_RESTART_POWERSHELL_START_TIME_TIMEOUT_MS +
    WINDOWS_RESTART_DENIED_READ_FALLBACK_TIMEOUT_MS;

  const LEASE_END_ROWS = [
    [
      "Windows install",
      WINDOWS_INSTALL_CONTROLLER_RETURN_BOUND_MS,
      WINDOWS_INSTALL_CONTROLLER_RETURN_BOUND_MS +
        HOST_START_ADOPTION_ACK_WAIT_MS,
    ],
    [
      "macOS install",
      LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS,
      LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS + HOST_START_ADOPTION_ACK_WAIT_MS,
    ],
    [
      "Windows restart",
      WINDOWS_RUN_SPAWN_EDGE_BOUND_MS +
        WINDOWS_START_SPAWN_POLL_MS +
        WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS +
        windowsRestartTailMs,
      WINDOWS_RUN_SPAWN_EDGE_BOUND_MS +
        WINDOWS_START_SPAWN_POLL_MS +
        WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS +
        windowsRestartTailMs +
        HOST_START_ADOPTION_ACK_WAIT_MS,
    ],
    [
      "Linux install",
      SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS,
      SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS + HOST_START_ADOPTION_ACK_WAIT_MS,
    ],
    [
      "Windows start/relaunchAfterRestart",
      WINDOWS_RUN_SPAWN_EDGE_BOUND_MS +
        WINDOWS_START_SPAWN_POLL_MS +
        WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS,
      WINDOWS_RUN_SPAWN_EDGE_BOUND_MS +
        WINDOWS_START_SPAWN_POLL_MS +
        WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS +
        HOST_START_ADOPTION_ACK_WAIT_MS,
    ],
    [
      "Linux start/restart/relaunchAfterRestart",
      SYSTEMCTL_JOB_TIMEOUT_MS,
      SYSTEMCTL_JOB_TIMEOUT_MS + HOST_START_ADOPTION_ACK_WAIT_MS,
    ],
    [
      "macOS restart/relaunchAfterRestart",
      LAUNCHCTL_RECYCLE_TIMEOUT_MS,
      LAUNCHCTL_RECYCLE_TIMEOUT_MS + HOST_START_ADOPTION_ACK_WAIT_MS,
    ],
    [
      "macOS start",
      LAUNCHCTL_CALL_TIMEOUT_MS,
      LAUNCHCTL_CALL_TIMEOUT_MS + HOST_START_ADOPTION_ACK_WAIT_MS,
    ],
  ] as const;

  it.each(LEASE_END_ROWS)(
    "%s: the controller-return bound fits inside HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS",
    (_name, controllerReturnBoundMs) => {
      // The premise `HOST_START_ADOPTION_MAX_AGE_MS`'s doc comment states:
      // a controller call returns "no earlier than the launch it requested,
      // and at most the bound above [HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS]
      // after the edge". Windows install's OWN bound is the one that composes
      // the max, so its row is the equality case here too.
      expect(controllerReturnBoundMs).toBeLessThanOrEqual(
        HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS,
      );
    },
  );

  it("the maximum lease end over every published controller call equals LEASE_END_CAP_MS, with Windows install as the equality case (R4)", () => {
    const maxLeaseEndMs = Math.max(
      ...LEASE_END_ROWS.map(([, , leaseEndMs]) => leaseEndMs),
    );
    expect(maxLeaseEndMs).toBe(LEASE_END_CAP_MS);
    const [windowsInstallName, , windowsInstallLeaseEndMs] = LEASE_END_ROWS[0];
    expect(windowsInstallName).toBe("Windows install");
    expect(windowsInstallLeaseEndMs).toBe(maxLeaseEndMs);
  });
});

describe("host-start adoption window — why the pre-edge Windows restart cost is off the grant's clock", () => {
  // The publish point sits AT the spawn edge (`service/spawn-edge.ts`), not
  // in front of it. Everything a controller call does BEFORE its first edge
  // - ownership probes, a Desktop host's cooperative stand-down, and on
  // Windows the whole `/End` + scan-then-kill ladder - runs off the grant's
  // clock entirely: the grant is not published until immediately before the
  // edge, so none of that pre-edge work is ever charged against the window.
  //
  // This is not a residual risk the window happens to tolerate - it is WHY a
  // window could be derived at all. A Windows restart's pre-edge cost alone
  // (240_000ms: `/End` plus four scans and three kills) is already larger
  // than the window (175_250ms, R4), so if the grant were published before
  // that ladder - as it was before this fix - no window wide enough to admit
  // the real worst case could exist without becoming absurdly large. Moving
  // the publish point to the edge is what makes the pre-edge cost irrelevant
  // to the window's size, rather than something the window has to
  // accommodate.
  it("the Windows restart pre-edge ladder (240_000ms) alone exceeds the window, which is exactly why it never has to fit inside it", () => {
    const windowsRestartPreEdgeMs =
      WINDOWS_SCHTASKS_END_TIMEOUT_MS +
      4 * WINDOWS_PROCESS_SCAN_TIMEOUT_MS +
      3 * WINDOWS_PROCESS_KILL_TIMEOUT_MS;
    expect(windowsRestartPreEdgeMs).toBe(240_000);
    expect(windowsRestartPreEdgeMs).toBeGreaterThan(
      HOST_START_ADOPTION_MAX_AGE_MS,
    );

    // Adding the run edge itself (245s -> 285s) does not change the
    // conclusion: the full pre-edge-plus-edge sum still does not "fit" by the
    // `fits()` predicate used for POST-edge bounds above, because that
    // predicate is not what governs pre-edge work at all - the grant simply
    // is not outstanding yet while any of this runs.
    const windowsRestartPreEdgePlusEdgeMs =
      windowsRestartPreEdgeMs + WINDOWS_RUN_SPAWN_EDGE_BOUND_MS;
    expect(windowsRestartPreEdgePlusEdgeMs).toBe(285_000);
    expect(
      fits(windowsRestartPreEdgePlusEdgeMs, HOST_START_ADOPTION_MAX_AGE_MS),
    ).toBe(false);
  });

  it("every actual post-edge bound the window IS sized by does fit it", () => {
    for (const [, bound] of NAMED_SPAWN_EDGE_BOUNDS) {
      expect(fits(bound, HOST_START_ADOPTION_MAX_AGE_MS)).toBe(true);
    }
  });
});
