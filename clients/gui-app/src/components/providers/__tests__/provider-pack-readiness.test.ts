import { describe, expect, it } from "vitest";
import type {
  ProviderCliState,
  ProviderManagedInstallErrorReason,
  ProviderManagedInstallState,
} from "@traycer/protocol/host/provider-schemas";
import { providerManagedInstallErrorReasonSchema } from "@traycer/protocol/host/provider-schemas";
import {
  providerPackPreparingByHarnessId,
  providerPackPreparingFromInstallState,
  providerPackPreparingLabel,
  providerPackPreparingShortLabel,
  providerPackRetryable,
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
    [
      "absent (still shipping bundled bytes pre-cutover)",
      { status: "absent" as const },
    ],
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
    const failed = (
      reason: "disk-full" | "network" | "verification" | "unknown",
    ) =>
      providerPackPreparingLabel(
        { kind: "error", percent: null, retryAtMs: null, reason },
        "Claude Code",
      );
    expect(failed("disk-full")).toContain("disk space");
    expect(failed("network")).toContain("back online");
    expect(failed("verification")).toContain("failed verification");
    expect(failed("unknown")).toContain("retry");
    // A stuck install must never read like a slow one.
    for (const reason of [
      "disk-full",
      "network",
      "verification",
      "unknown",
    ] as const) {
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

/**
 * `unrepairable` is the only reason that is not a "try again" (see
 * `providerManagedInstallErrorReasonSchema`): the bytes verified against their
 * signed digest and were defective anyway, so the registry holds the identical
 * blob fleet-wide and no reinstall can change the outcome.
 *
 * The failure these two describes exist to catch is a QUIET one - the enum
 * grows, the new member lands in `providerPackErrorDetail`'s deliberately
 * fail-open `default:` arm, and the user is told to "retry to try again" for a
 * build that can never work. Nothing throws, nothing logs; the copy is just
 * wrong forever. So both assertions are on the PROPERTY (no retry is promised,
 * no retry is offered) rather than on a string this file also authored.
 */
const detailFor = (reason: ProviderManagedInstallErrorReason): string =>
  providerPackPreparingLabel(
    { kind: "error", percent: null, retryAtMs: null, reason },
    "Claude Code",
  );

describe("the terminal `unrepairable` reason", () => {
  it("never tells the user to retry a build that can never work", () => {
    const copy = detailFor("unrepairable");
    // The whole point. `default:` returns "retry to try again." and every
    // other reason's copy contains "retry" or "Retry" on purpose - only this
    // one must not, in any casing.
    expect(copy).not.toMatch(/retry/i);
    // ...and it is not the fail-open fallback wearing different words: the
    // `unknown` arm is the closest neighbour that DOES route to a retry, so a
    // copy identical to it would mean the new `case` never ran.
    expect(copy).not.toBe(detailFor("unknown"));
    // Still the failed line, not a progress phrase.
    expect(copy).toContain("Claude Code setup failed");
    expect(copy).not.toContain("Preparing");
  });

  it("is the only reason whose surface may not offer a retry", () => {
    expect(
      providerPackRetryable({
        kind: "error",
        percent: null,
        retryAtMs: null,
        reason: "unrepairable",
      }),
    ).toBe(false);
    // Enumerated, not sampled: every other member of the closed enum stays
    // retryable, because for those a user-initiated `providers.ensurePack` is
    // the user's only way to clear the backoff. An exclusion that grew to cover
    // one of these would strand a recoverable failure with no action at all.
    for (const reason of [
      "disk-full",
      "network",
      "verification",
      "unknown",
    ] as const) {
      expect(
        providerPackRetryable({
          kind: "error",
          percent: null,
          retryAtMs: null,
          reason,
        }),
      ).toBe(true);
    }
    // A download in flight has nothing to retry either, and for the opposite
    // reason - it has not failed.
    expect(
      providerPackRetryable({
        kind: "downloading",
        percent: 42,
        retryAtMs: null,
        reason: null,
      }),
    ).toBe(false);
  });

  it("withholds the retry for a host that cannot verify the registry", () => {
    // The trap that made `providerPackRetryable` an allow-list. Under the old
    // exclusion form (`reason !== "unrepairable"`) this new member was
    // retryable BY DEFAULT - the rail would draw a button whose click reaches
    // `providers.ensurePack` on a host with no install machinery at all.
    // Offered-then-failed, reintroduced by a one-line vocabulary addition.
    expect(
      providerPackRetryable({
        kind: "error",
        percent: null,
        retryAtMs: null,
        reason: "trust-unavailable",
      }),
    ).toBe(false);
  });

  it("forces a retryability decision for every reason the protocol defines", () => {
    // Enumerating the CLOSED SET from the schema itself, not a hand-copied
    // list: the failure mode this whole allow-list exists for is a new member
    // silently inheriting a default. A member added to the protocol without a
    // deliberate choice here fails this test rather than shipping a button
    // that does nothing.
    const decided = new Set<ProviderManagedInstallErrorReason>([
      "disk-full",
      "network",
      "verification",
      "unknown",
      "live-owner-stalled",
      "unrepairable",
      "trust-unavailable",
    ]);
    const nonRetryable = new Set<ProviderManagedInstallErrorReason>([
      "unrepairable",
      "trust-unavailable",
    ]);

    for (const reason of providerManagedInstallErrorReasonSchema.options) {
      expect(decided.has(reason)).toBe(true);
      expect(
        providerPackRetryable({
          kind: "error",
          percent: null,
          retryAtMs: null,
          reason,
        }),
      ).toBe(!nonRetryable.has(reason));
    }
  });
});

/**
 * The other pole. `live-owner-stalled` means a SIBLING Traycer process on this
 * machine holds the pack's download lease and stopped advancing its progress
 * token, so this host stopped waiting behind it. It is fully retryable, with a
 * real `retryAtMs` - the exact opposite of `unrepairable`, and the two arrived
 * in the same change on purpose: they are the two ends of what `reason` is for.
 *
 * Before it existed this condition was reported as `unknown`, which is the
 * bucket for a failure the host could NOT classify. This one it classifies
 * precisely, so the assertions below are about the copy not misdirecting: not
 * the network (nothing about the registry failed), and not the fallback.
 */
describe("the retryable `live-owner-stalled` reason", () => {
  it("blames the sibling process, not the user's connection", () => {
    const copy = detailFor("live-owner-stalled");
    // The misdirection this member exists to prevent. Reported as `network`
    // (the neighbouring plausible arm) the user is sent to check a connection
    // that is fine; reported as `unknown` they are told nothing at all.
    expect(copy).not.toMatch(/online|connection|network/i);
    expect(copy).not.toBe(detailFor("network"));
    expect(copy).not.toBe(detailFor("unknown"));
    // It names what actually happened, in the user's terms.
    expect(copy).toContain("another Traycer process on this device");
    // Still the failed line, not a progress phrase.
    expect(copy).toContain("Claude Code setup failed");
    expect(copy).not.toContain("Preparing");
  });

  it("keeps the retry - this failure is a genuine try-again", () => {
    // Paired with the `unrepairable` test above deliberately: same enum, same
    // function, opposite answers. A gate that only ever said "no retry" would
    // pass that test and strand this one with no action at all.
    expect(detailFor("live-owner-stalled")).toMatch(/retry/i);
    expect(
      providerPackRetryable({
        kind: "error",
        percent: null,
        // The wire's own distinction: a real future retry time, where
        // `unrepairable` always travels with null.
        retryAtMs: 1_700_000_000_000,
        reason: "live-owner-stalled",
      }),
    ).toBe(true);
  });
});
