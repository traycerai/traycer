import { describe, expect, it } from "vitest";
import type {
  ProviderCliState,
  ProviderManagedInstallState,
} from "@traycer/protocol/host/provider-schemas";
import {
  providerPackPreparingByHarnessId,
  providerPackPreparingFromInstallState,
  providerPackPreparingLabel,
  providerPackPreparingShortLabel,
} from "@/components/providers/provider-pack-readiness";

function providerState(
  providerId: ProviderCliState["providerId"],
  managedInstallState: ProviderManagedInstallState | null,
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
    managedInstallState,
    versionVisibility: null,
    advisory: null,
  };
}

describe("providerPackPreparingFromInstallState: which states gate", () => {
  // The three not-gated answers, each for a different reason - see the
  // function's own doc comment. Getting any of these wrong locks users out of
  // a provider the host would happily spawn, which is strictly worse than the
  // bug this gate exists to fix.
  it.each([
    ["a null state (old host / unmanaged store)", null],
    ["an undefined state (key absent on an old wire)", undefined],
    ["installed", { status: "installed" as const }],
    ["absent (still shipping bundled bytes pre-cutover)", { status: "absent" as const }],
  ])("does not gate on %s", (_label, state) => {
    expect(providerPackPreparingFromInstallState(state)).toBeNull();
  });

  it("gates on downloading and preserves the percent", () => {
    expect(
      providerPackPreparingFromInstallState({
        status: "downloading",
        percent: 42,
      }),
    ).toEqual({
      kind: "downloading",
      percent: 42,
      retryAtMs: null,
      reason: null,
    });
  });

  // N13: a live sibling host owns the transfer, so there is no observable byte
  // count. Null must survive to the renderer as null - coercing it to 0 would
  // render a stalled-looking 0% bar for a download that is actually moving.
  it("gates on downloading with a null percent and keeps it null", () => {
    expect(
      providerPackPreparingFromInstallState({
        status: "downloading",
        percent: null,
      }),
    ).toEqual({
      kind: "downloading",
      percent: null,
      retryAtMs: null,
      reason: null,
    });
  });

  it("gates on error and carries the reason and retry time through", () => {
    expect(
      providerPackPreparingFromInstallState({
        status: "error",
        reason: "disk-full",
        message: "ENOSPC",
        retryAtMs: 1_700_000_000_000,
      }),
    ).toEqual({
      kind: "error",
      percent: null,
      retryAtMs: 1_700_000_000_000,
      reason: "disk-full",
    });
  });
});

describe("providerPackPreparingByHarnessId", () => {
  it("keys by GUI harness id, not provider id, and omits ready providers", () => {
    const map = providerPackPreparingByHarnessId([
      providerState("claude-code", { status: "downloading", percent: 10 }),
      providerState("codex", { status: "installed" }),
      providerState("amp", null),
    ]);

    // `claude-code` (wire) -> `claude` (GUI). A map keyed by the wire id would
    // silently never match the rail, which reads harness ids.
    expect([...map.keys()]).toEqual(["claude"]);
    expect(map.get("claude")?.percent).toBe(10);
  });
});

describe("preparing labels", () => {
  it("shows a percent when one is known", () => {
    expect(
      providerPackPreparingLabel(
        { kind: "downloading", percent: 42, retryAtMs: null, reason: null },
        "Claude Code",
      ),
    ).toBe("Preparing Claude Code… 42%");
    expect(
      providerPackPreparingShortLabel({
        kind: "downloading",
        percent: 42,
        retryAtMs: null,
        reason: null,
      }),
    ).toBe("Preparing… 42%");
  });

  it("omits the percent entirely when it is unknown, rather than saying 0%", () => {
    expect(
      providerPackPreparingLabel(
        { kind: "downloading", percent: null, retryAtMs: null, reason: null },
        "Claude Code",
      ),
    ).toBe("Preparing Claude Code…");
    expect(
      providerPackPreparingShortLabel({
        kind: "downloading",
        percent: null,
        retryAtMs: null,
        reason: null,
      }),
    ).toBe("Preparing…");
  });

  it("gives a failed pack distinct copy per reason, never a progress phrase", () => {
    const failed = (reason: "disk-full" | "network" | "verification" | "unknown") =>
      providerPackPreparingLabel(
        { kind: "error", percent: null, retryAtMs: null, reason },
        "Claude Code",
      );
    expect(failed("disk-full")).toContain("disk space");
    expect(failed("network")).toContain("back online");
    expect(failed("verification")).toContain("failed verification");
    expect(failed("unknown")).toContain("retry");
    // A stuck install must never read like a slow one.
    for (const reason of ["disk-full", "network", "verification", "unknown"] as const) {
      expect(failed(reason)).not.toContain("Preparing");
    }
    expect(
      providerPackPreparingShortLabel({
        kind: "error",
        percent: null,
        retryAtMs: null,
        reason: "network",
      }),
    ).toBe("Setup failed");
  });
});
