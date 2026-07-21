import { describe, expect, it, vi } from "vitest";
import type { HostPendingRevisionState } from "@traycer-clients/shared/platform/runner-host";
import {
  evaluateRegisterCycleDecision,
  type RegisterCycleDecisionInputs,
} from "../host-register-cycle-decision";

// The register-cycle state machine is pure: every environmental fact is an
// injected seam, so these cases exercise the precedence table and the
// launchctl-authority rule (Finding F) deterministically, without touching the
// filesystem, `launchctl`, or SMAppService.

const AGENT_LABEL = "ai.traycer.host.agent";
const IDENTITY = "production.1700000000000.abc1234";

const durablePersist: HostPendingRevisionState = {
  pending: true,
  durable: true,
  cause: "persisted",
  error: null,
};
const unpersisted: HostPendingRevisionState = {
  pending: true,
  durable: false,
  cause: "unpersisted",
  error: "EACCES: marker write denied",
};

// Defaults describe a healthy, current-generation, idle host: a live agent pid,
// a matching stamp, no marker/flag/action. That baseline is `skip-join`; each
// test flips exactly one fact.
function makeInputs(
  overrides: Partial<RegisterCycleDecisionInputs>,
): RegisterCycleDecisionInputs {
  return {
    force: false,
    environment: "production",
    agentLabel: AGENT_LABEL,
    identity: IDENTITY,
    cliActionInstalled: false,
    readAgentLabelPid: vi.fn().mockResolvedValue(4242),
    hasPendingRevisionMarker: vi.fn().mockResolvedValue(false),
    isPendingCycleFlagSet: vi.fn().mockReturnValue(false),
    registrationStampMatches: vi.fn().mockResolvedValue(true),
    isRegistrationIdentityApplied: vi.fn().mockReturnValue(false),
    probeBusy: vi.fn().mockResolvedValue(false),
    persistPendingCycle: vi.fn().mockResolvedValue(durablePersist),
    ...overrides,
  };
}

describe("evaluateRegisterCycleDecision", () => {
  it("skip-joins a viable current-generation spawn with nothing to apply", async () => {
    const decision = await evaluateRegisterCycleDecision(makeInputs({}));
    expect(decision).toEqual({ kind: "skip-join" });
  });

  it("cycles on force even when the host is current with a viable spawn", async () => {
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({ force: true }),
    );
    expect(decision).toEqual({ kind: "cycle", causes: [] });
  });

  it("cycles on a CLI `action === installed` transition", async () => {
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({ cliActionInstalled: true }),
    );
    expect(decision).toEqual({ kind: "cycle", causes: ["action-installed"] });
  });

  it("cycles on a pending-revision disk marker", async () => {
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({ hasPendingRevisionMarker: vi.fn().mockResolvedValue(true) }),
    );
    expect(decision).toEqual({ kind: "cycle", causes: ["pending-marker"] });
  });

  it("cycles on the in-memory pending-cycle flag (a deferral whose marker write failed)", async () => {
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({ isPendingCycleFlagSet: vi.fn().mockReturnValue(true) }),
    );
    expect(decision).toEqual({ kind: "cycle", causes: ["pending-flag"] });
  });

  it("cycles on a registration-stamp mismatch (app update / absent stamp)", async () => {
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({
        registrationStampMatches: vi.fn().mockResolvedValue(false),
      }),
    );
    expect(decision).toEqual({ kind: "cycle", causes: ["stamp-mismatch"] });
  });

  it("suppresses ONLY the stamp-mismatch cause when the in-launch applied latch is set", async () => {
    // A restamp write failed this launch, but the cycle succeeded: the latch
    // suppresses the stamp-mismatch reason so we do not re-cycle every ensure.
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({
        registrationStampMatches: vi.fn().mockResolvedValue(false),
        isRegistrationIdentityApplied: vi.fn().mockReturnValue(true),
      }),
    );
    expect(decision).toEqual({ kind: "skip-join" });
  });

  it("the applied latch does NOT suppress a needed no-agent repair", async () => {
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({
        registrationStampMatches: vi.fn().mockResolvedValue(false),
        isRegistrationIdentityApplied: vi.fn().mockReturnValue(true),
        readAgentLabelPid: vi.fn().mockResolvedValue(null),
      }),
    );
    expect(decision).toEqual({ kind: "cycle", causes: ["no-agent-spawn"] });
  });

  it("LANDMINE: a null launchctl agent pid is `noViableAgentSpawn` and cycles - no marker can substitute", async () => {
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({ readAgentLabelPid: vi.fn().mockResolvedValue(null) }),
    );
    expect(decision).toEqual({ kind: "cycle", causes: ["no-agent-spawn"] });
  });

  it("consults launchctl with the agent label", async () => {
    const readAgentLabelPid = vi.fn().mockResolvedValue(4242);
    await evaluateRegisterCycleDecision(makeInputs({ readAgentLabelPid }));
    expect(readAgentLabelPid).toHaveBeenCalledWith(AGENT_LABEL);
  });

  it("defers (persisted) when a needed cycle meets a busy host", async () => {
    const persistPendingCycle = vi.fn().mockResolvedValue(durablePersist);
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({
        cliActionInstalled: true,
        probeBusy: vi.fn().mockResolvedValue(true),
        persistPendingCycle,
      }),
    );
    expect(decision).toEqual({ kind: "defer-busy", cause: "action-installed" });
    expect(persistPendingCycle).toHaveBeenCalledWith(
      "production",
      "action-installed",
    );
  });

  it("defers UNPERSISTED when the busy deferral's marker write fails", async () => {
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({
        cliActionInstalled: true,
        probeBusy: vi.fn().mockResolvedValue(true),
        persistPendingCycle: vi.fn().mockResolvedValue(unpersisted),
      }),
    );
    expect(decision).toEqual({
      kind: "defer-busy-unpersisted",
      cause: "action-installed",
      error: "EACCES: marker write denied",
    });
  });

  it("persists the pending-cycle marker for the no-agent repair even on a busy host (round-3 counterexample)", async () => {
    // A reachable, busy, legacy-label host with a current stamp and no agent
    // pid still needs a cycle; the deferral must persist so the monitor applies
    // it at idle - without persist-every-cause nothing would wake the repair.
    const persistPendingCycle = vi.fn().mockResolvedValue(durablePersist);
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({
        readAgentLabelPid: vi.fn().mockResolvedValue(null),
        probeBusy: vi.fn().mockResolvedValue(true),
        persistPendingCycle,
      }),
    );
    expect(decision).toEqual({ kind: "defer-busy", cause: "no-agent-spawn" });
    expect(persistPendingCycle).toHaveBeenCalledWith(
      "production",
      "no-agent-spawn",
    );
  });

  it("force overrides busy - it never defers", async () => {
    const persistPendingCycle = vi.fn().mockResolvedValue(durablePersist);
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({
        force: true,
        cliActionInstalled: true,
        probeBusy: vi.fn().mockResolvedValue(true),
        persistPendingCycle,
      }),
    );
    expect(decision).toEqual({
      kind: "cycle",
      causes: ["action-installed"],
    });
    expect(persistPendingCycle).not.toHaveBeenCalled();
  });

  it("a busy host with nothing to apply skip-joins (busy is irrelevant without needCycle)", async () => {
    const probeBusy = vi.fn().mockResolvedValue(true);
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({ probeBusy }),
    );
    expect(decision).toEqual({ kind: "skip-join" });
    // Busy is only consulted when a cycle is actually needed.
    expect(probeBusy).not.toHaveBeenCalled();
  });

  it("joins multiple definition-change causes into the persisted cause string", async () => {
    const persistPendingCycle = vi.fn().mockResolvedValue(durablePersist);
    const decision = await evaluateRegisterCycleDecision(
      makeInputs({
        cliActionInstalled: true,
        readAgentLabelPid: vi.fn().mockResolvedValue(null),
        probeBusy: vi.fn().mockResolvedValue(true),
        persistPendingCycle,
      }),
    );
    expect(decision).toEqual({
      kind: "defer-busy",
      cause: "action-installed,no-agent-spawn",
    });
  });
});
