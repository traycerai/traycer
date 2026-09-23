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
  WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS,
  WINDOWS_RUN_SPAWN_EDGE_BOUND_MS,
} from "../../service/spawn-edge-bounds";
import {
  WINDOWS_PROCESS_KILL_TIMEOUT_MS,
  WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
  WINDOWS_SCHTASKS_END_TIMEOUT_MS,
  WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS,
  WINDOWS_SCHTASKS_RUN_TIMEOUT_MS,
  WINDOWS_START_SPAWN_VERIFY_MS,
} from "@traycer/protocol/host/lifecycle-constants";

// Every bound the window is derived from, so a change to any one of them
// cannot silently widen or narrow the window without a value pin here
// reddening first. All seven now come from the leaf
// (`service/spawn-edge-bounds.ts`) rather than from the platform modules or
// from `host-start-adoption.ts`, which no longer defines any of them.
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
    expect(HOST_START_ADOPTION_MAX_AGE_MS).toBe(130_000);
  });

  it("HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS is the max of all seven named per-platform bounds", () => {
    expect(HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS).toBe(
      Math.max(...NAMED_SPAWN_EDGE_BOUNDS.map(([, value]) => value)),
    );
    expect(HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS).toBe(90_000);
  });

  it("value pins for every named bound", () => {
    expect(LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(90_000); // macOS install
    expect(WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(75_000); // Windows install
    expect(SYSTEMCTL_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(62_000); // Linux install
    expect(SYSTEMCTL_JOB_TIMEOUT_MS).toBe(52_000); // Linux job
    expect(WINDOWS_RUN_SPAWN_EDGE_BOUND_MS).toBe(45_000); // Windows run
    expect(LAUNCHCTL_RECYCLE_TIMEOUT_MS).toBe(40_000); // macOS recycle
    expect(LAUNCHCTL_CALL_TIMEOUT_MS).toBe(10_000); // call
  });

  it("SUPERVISOR_LAUNCH_MARGIN_MS and SUPERVISOR_SPAWN_ACK_MARGIN_MS pins", () => {
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

  it("the Windows install bound is the create timeout plus the Windows run bound", () => {
    expect(WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(
      30_000 + WINDOWS_RUN_SPAWN_EDGE_BOUND_MS,
    );
    expect(WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS).toBe(75_000);
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

  it("HOST_START_ADOPTION_ACK_WAIT_MS equals the launch margin plus the spawn-ack margin (50_000)", () => {
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
  // (140_000) - the safety cap the doc comment names directly ("a lease can
  // outlive the window, by at most SUPERVISOR_SPAWN_ACK_MARGIN_MS").
  const LEASE_END_CAP_MS =
    HOST_START_ADOPTION_MAX_AGE_MS + SUPERVISOR_SPAWN_ACK_MARGIN_MS;

  it("the lease-end cap is 140_000, i.e. the window plus the spawn-ack margin", () => {
    expect(LEASE_END_CAP_MS).toBe(140_000);
  });

  it("macOS install: the kickstart-timeout controller return is the spawn-edge bound itself, so lease end is bound + launch margin + ack margin — the EQUALITY case", () => {
    // On macOS, `installService`'s controller call returns right at the
    // spawn-edge bound - no extra query step - so the lease end is exactly
    // bound + ACK_WAIT_MS, which is exactly window + ack margin, since
    // ACK_WAIT_MS = launch margin + ack margin and window = bound + launch
    // margin. This is the platform whose bound composes the max, so it is
    // the one that reaches the cap exactly rather than merely fitting under it.
    const macosInstallLeaseEndMs =
      LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS +
      SUPERVISOR_LAUNCH_MARGIN_MS +
      SUPERVISOR_SPAWN_ACK_MARGIN_MS;
    expect(macosInstallLeaseEndMs).toBe(
      LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS + HOST_START_ADOPTION_ACK_WAIT_MS,
    );
    expect(macosInstallLeaseEndMs).toBe(140_000);
    expect(macosInstallLeaseEndMs).toBe(LEASE_END_CAP_MS);
  });

  it("Windows install: a failed verify adds one Last-Run-Result query before the controller call returns — lease end 135_000", () => {
    // Unlike macOS, a Windows install whose `/Run` verify fails queries Last
    // Run Result (`WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS`) before the controller
    // call returns, so the controller-return time is the install bound PLUS
    // that query, not the bound alone.
    const windowsInstallLeaseEndMs =
      WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS +
      WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS +
      HOST_START_ADOPTION_ACK_WAIT_MS;
    expect(windowsInstallLeaseEndMs).toBe(135_000);
    expect(windowsInstallLeaseEndMs).toBeLessThanOrEqual(LEASE_END_CAP_MS);
  });

  it("Windows start/restart: the same query-before-return shape off the run bound — lease end 105_000", () => {
    const windowsRunLeaseEndMs =
      WINDOWS_RUN_SPAWN_EDGE_BOUND_MS +
      WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS +
      HOST_START_ADOPTION_ACK_WAIT_MS;
    expect(windowsRunLeaseEndMs).toBe(105_000);
    expect(windowsRunLeaseEndMs).toBeLessThanOrEqual(LEASE_END_CAP_MS);
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
  // than the window (130_000ms), so if the grant were published before that
  // ladder - as it was before this fix - no window wide enough to admit the
  // real worst case could exist without becoming absurdly large. Moving the
  // publish point to the edge is what makes the pre-edge cost irrelevant to
  // the window's size, rather than something the window has to accommodate.
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
