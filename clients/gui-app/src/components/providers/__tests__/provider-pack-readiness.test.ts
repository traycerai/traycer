import { describe, expect, it } from "vitest";
import type {
  ProviderCliCandidate,
  ProviderCliState,
  ProviderManagedInstallErrorReason,
  ProviderManagedInstallState,
} from "@traycer/protocol/host/provider-schemas";
import { providerManagedInstallErrorReasonSchema } from "@traycer/protocol/host/provider-schemas";
import {
  providerPackBlocksExecution,
  providerPackPreparingByHarnessId,
  providerPackPreparingForProvider,
  providerPackPreparingLabel,
  providerPackPreparingShortLabel,
  providerPackRetryable,
  type ProviderPackPreparing,
} from "@/components/providers/provider-pack-readiness";

function providerState(
  providerId: ProviderCliState["providerId"],
  managedInstallState: ProviderManagedInstallState | null | undefined,
): ProviderCliState {
  return providerStateWith(providerId, managedInstallState, {
    candidates: [],
    availabilityPending: false,
  });
}

function providerStateWith(
  providerId: ProviderCliState["providerId"],
  managedInstallState: ProviderManagedInstallState | null | undefined,
  fallback: {
    readonly candidates: readonly ProviderCliCandidate[];
    readonly availabilityPending: boolean;
  },
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [...fallback.candidates],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: fallback.availabilityPending,
    profiles: [],
    managedInstallState,
    versionVisibility: null,
    advisory: null,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
    },
  };
}

function candidate(
  kind: ProviderCliCandidate["kind"],
  available: boolean,
): ProviderCliCandidate {
  return {
    kind,
    path: available ? `/usr/local/bin/${kind}` : "",
    version: null,
    available,
    versionPending: false,
  };
}

// The copy and retryability assertions below all describe the BLOCKING voice -
// a provider with nothing to fall back on. These builders pin
// `fallbackRunnable: false` in one place so that stays deliberate rather than
// incidental; the non-blocking voice has its own describe block.
function blockingDownload(percent: number | null): ProviderPackPreparing {
  return {
    kind: "downloading",
    percent,
    retryAtMs: null,
    reason: null,
    fallbackRunnable: false,
  };
}

function blockingFailure(
  reason: ProviderManagedInstallErrorReason,
  retryAtMs: number | null,
): ProviderPackPreparing {
  return {
    kind: "error",
    percent: null,
    retryAtMs,
    reason,
    fallbackRunnable: false,
  };
}

// Asserting through a null-rejecting helper rather than a `!`: a case that
// stopped producing a state at all would otherwise pass every "does not block"
// assertion below for entirely the wrong reason.
function blocksExecution(preparing: ProviderPackPreparing | null): boolean {
  if (preparing === null) {
    throw new Error("expected a preparing state, got null");
  }
  return providerPackBlocksExecution(preparing);
}

describe("providerPackPreparingForProvider: which states say anything", () => {
  // The three quiet answers, each for a different reason - see the function's
  // own doc comment. Getting any of these wrong locks users out of a provider
  // the host would happily spawn, which is strictly worse than the bug this
  // gate exists to fix.
  it.each([
    ["a null state (old host / unmanaged store)", null],
    ["installed", { status: "installed" as const }],
    [
      "absent (still shipping bundled bytes pre-cutover)",
      { status: "absent" as const },
    ],
  ])("stays quiet on %s", (_label, state) => {
    expect(
      providerPackPreparingForProvider(providerState("claude-code", state)),
    ).toBeNull();
  });

  it("stays quiet when the key is absent on an old wire", () => {
    expect(
      providerPackPreparingForProvider(providerState("claude-code", undefined)),
    ).toBeNull();
  });

  it("reports downloading and preserves the percent", () => {
    expect(
      providerPackPreparingForProvider(
        providerState("claude-code", { status: "downloading", percent: 42 }),
      ),
    ).toEqual(blockingDownload(42));
  });

  // N13: a live sibling host owns the transfer, so there is no observable byte
  // count. Null must survive to the renderer as null - coercing it to 0 would
  // render a stalled-looking 0% bar for a download that is actually moving.
  it("reports downloading with a null percent and keeps it null", () => {
    expect(
      providerPackPreparingForProvider(
        providerState("claude-code", { status: "downloading", percent: null }),
      ),
    ).toEqual(blockingDownload(null));
  });

  it("reports error and carries the reason and retry time through", () => {
    expect(
      providerPackPreparingForProvider(
        providerState("claude-code", {
          status: "error",
          reason: "disk-full",
          message: "ENOSPC",
          retryAtMs: 1_700_000_000_000,
        }),
      ),
    ).toEqual(blockingFailure("disk-full", 1_700_000_000_000));
  });
});

/**
 * The gate's actual question. `providers.list` reports a managed pack's
 * lifecycle; it does NOT report whether the provider can run, and reading the
 * second off the first is what dimmed every provider on the machine behind
 * `Preparing… 0%` during boot convergence - which enqueues every enabled pack
 * at once, on hosts whose bundled binaries were sitting right there.
 *
 * The host is the reference implementation and these tests are written against
 * it: `resolveProviderCli` only throws `preparing` after custom, managed, PATH
 * and bundled have all missed. A client stricter than that is a client
 * refusing turns the host would have run.
 */
describe("fallback awareness: preparing vs unable to run", () => {
  it.each([
    ["a bundled binary", "bundled" as const],
    ["a PATH-discovered binary", "path" as const],
    ["a custom path the user configured", "custom" as const],
  ])("does not block a download behind %s", (_label, kind) => {
    const preparing = providerPackPreparingForProvider(
      providerStateWith(
        "claude-code",
        { status: "downloading", percent: 0 },
        { candidates: [candidate(kind, true)], availabilityPending: false },
      ),
    );
    expect(preparing).not.toBeNull();
    // Still REPORTED - a surface that wants to show background progress can.
    expect(preparing?.kind).toBe("downloading");
    // ...but it takes nothing away.
    expect(preparing?.fallbackRunnable).toBe(true);
    expect(blocksExecution(preparing)).toBe(false);
  });

  it("blocks when every candidate is unavailable", () => {
    // The case the gated-and-labelled design was built for, and the one that
    // becomes normal after the bundled binaries stop shipping: nothing on disk
    // to fall back to, so the turn genuinely cannot run.
    const preparing = providerPackPreparingForProvider(
      providerStateWith(
        "claude-code",
        { status: "downloading", percent: 0 },
        {
          candidates: [candidate("bundled", false), candidate("path", false)],
          availabilityPending: false,
        },
      ),
    );
    expect(preparing?.fallbackRunnable).toBe(false);
    expect(blocksExecution(preparing)).toBe(true);
  });

  it("blocks a failed pack only when it has nowhere to fall back to", () => {
    // A failure is not special here. The user's Claude Code on PATH does not
    // stop working because a managed copy hit ENOSPC.
    const withFallback = providerPackPreparingForProvider(
      providerStateWith(
        "claude-code",
        {
          status: "error",
          reason: "disk-full",
          message: "ENOSPC",
          retryAtMs: null,
        },
        { candidates: [candidate("path", true)], availabilityPending: false },
      ),
    );
    expect(blocksExecution(withFallback)).toBe(false);

    const alone = providerPackPreparingForProvider(
      providerState("claude-code", {
        status: "error",
        reason: "disk-full",
        message: "ENOSPC",
        retryAtMs: null,
      }),
    );
    expect(blocksExecution(alone)).toBe(true);
  });

  it("does not block while the shell probe is still settling", () => {
    // `availabilityPending` means `candidates` UNDER-reports: the PATH probe
    // has not finished. The execute path awaits that same probe before it
    // decides, so a binary this snapshot cannot see yet is one the host would
    // spawn. Fail open for the poll tick rather than dim a working provider.
    const preparing = providerPackPreparingForProvider(
      providerStateWith(
        "claude-code",
        { status: "downloading", percent: 0 },
        { candidates: [], availabilityPending: true },
      ),
    );
    expect(blocksExecution(preparing)).toBe(false);
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
      providerPackPreparingLabel(blockingDownload(42), "Claude Code"),
    ).toBe("Preparing Claude Code… 42%");
    expect(providerPackPreparingShortLabel(blockingDownload(42))).toBe(
      "Preparing… 42%",
    );
  });

  it("omits the percent entirely when it is unknown, rather than saying 0%", () => {
    expect(
      providerPackPreparingLabel(blockingDownload(null), "Claude Code"),
    ).toBe("Preparing Claude Code…");
    expect(providerPackPreparingShortLabel(blockingDownload(null))).toBe(
      "Preparing…",
    );
  });

  it("gives a failed pack distinct copy per reason, never a progress phrase", () => {
    const failed = (
      reason: "disk-full" | "network" | "verification" | "unknown",
    ) =>
      providerPackPreparingLabel(blockingFailure(reason, null), "Claude Code");
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
      providerPackPreparingShortLabel(blockingFailure("network", null)),
    ).toBe("Setup failed");
  });
});

/**
 * The non-blocking voice. These strings go in front of a user whose provider
 * WORKS - the pack is downloading or failed behind a bundled/PATH/custom
 * binary the host will happily spawn. Softening the blocking copy would not
 * have been enough: "Claude Code setup failed" is simply false there, and
 * "Preparing Claude Code…" announces a wait that is not happening.
 *
 * The shared strings name the managed copy's update only - never the
 * provider's readiness, and never a download percentage the user is not
 * waiting on.
 */
describe("labels for an install that blocks nothing", () => {
  const runnable = (
    kind: ProviderPackPreparing["kind"],
    percent: number | null,
  ): ProviderPackPreparing => ({
    kind,
    percent,
    retryAtMs: null,
    reason: kind === "error" ? "network" : null,
    fallbackRunnable: true,
  });

  it("names a background managed download without a percentage", () => {
    expect(
      providerPackPreparingLabel(runnable("downloading", 42), "Claude Code"),
    ).toBe("Updating Claude Code in background");
    expect(
      providerPackPreparingLabel(runnable("downloading", null), "Claude Code"),
    ).toBe("Updating Claude Code in background");
    expect(providerPackPreparingShortLabel(runnable("downloading", 42))).toBe(
      "Updating in background",
    );
    expect(providerPackPreparingShortLabel(runnable("downloading", null))).toBe(
      "Updating in background",
    );
  });

  it("names a non-blocking managed failure without the blocking setup line", () => {
    expect(
      providerPackPreparingLabel(runnable("error", null), "Claude Code"),
    ).toBe(
      "Claude Code update failed - the download could not be reached. Retry when you're back online.",
    );
    expect(providerPackPreparingShortLabel(runnable("error", null))).toBe(
      "Update failed",
    );
  });

  it("never borrows the gating copy or a percentage", () => {
    for (const preparing of [
      runnable("downloading", 42),
      runnable("downloading", null),
      runnable("error", null),
    ]) {
      const label = providerPackPreparingLabel(preparing, "Claude Code");
      // "Preparing X…" is the disabled composer's line; "X setup failed" is the
      // dead-provider line. Neither describes a provider the user can run.
      expect(label).not.toContain("Preparing Claude Code");
      expect(label).not.toContain("Claude Code setup failed");
      expect(label).not.toMatch(/%/);
      const short = providerPackPreparingShortLabel(preparing);
      expect(short).not.toBe("Setup failed");
      expect(short).not.toContain("Preparing");
      expect(short).not.toMatch(/%/);
    }
  });
});

/**
 * `unrepairable` is a terminal non-retryable reason (see
 * `providerManagedInstallErrorReasonSchema`): the bytes verified against their
 * signed digest and were defective anyway, so the registry holds the identical
 * blob fleet-wide and no reinstall can change the outcome. The exhaustive
 * allow-list test below covers the broader default-deny policy.
 *
 * The failure these two describes exist to catch is a QUIET one - the enum
 * grows, the new member lands in `providerPackErrorDetail`'s deliberately
 * fail-open `default:` arm, and the user is told to "retry to try again" for a
 * build that can never work. Nothing throws, nothing logs; the copy is just
 * wrong forever. So both assertions are on the PROPERTY (no retry is promised,
 * no retry is offered) rather than on a string this file also authored.
 */
const detailFor = (reason: ProviderManagedInstallErrorReason): string =>
  providerPackPreparingLabel(blockingFailure(reason, null), "Claude Code");

describe("the terminal `unrepairable` reason", () => {
  it("never tells the user to retry a build that can never work", () => {
    const copy = detailFor("unrepairable");
    // This terminal reason's detail must never promise a retry, in any casing.
    expect(copy).not.toMatch(/retry/i);
    // ...and it is not the fail-open fallback wearing different words: the
    // `unknown` arm is the closest neighbour that DOES route to a retry, so a
    // copy identical to it would mean the new `case` never ran.
    expect(copy).not.toBe(detailFor("unknown"));
    // Still the failed line, not a progress phrase.
    expect(copy).toContain("Claude Code setup failed");
    expect(copy).not.toContain("Preparing");
  });

  it("is non-retryable, like every reason outside the allow-list", () => {
    expect(providerPackRetryable(blockingFailure("unrepairable", null))).toBe(
      false,
    );
    // A download in flight has nothing to retry either, and for the opposite
    // reason - it has not failed.
    expect(providerPackRetryable(blockingDownload(42))).toBe(false);
  });

  it("withholds the retry for a host that cannot verify the registry", () => {
    // The trap that made `providerPackRetryable` an allow-list. Under the old
    // exclusion form (`reason !== "unrepairable"`) this new member was
    // retryable BY DEFAULT - the rail would draw a button whose click reaches
    // `providers.ensurePack` on a host with no install machinery at all.
    // Offered-then-failed, reintroduced by a one-line vocabulary addition.
    expect(
      providerPackRetryable(blockingFailure("trust-unavailable", null)),
    ).toBe(false);
  });

  it("default-denies retry for every protocol reason outside the explicit allow-list", () => {
    // Enumerating the CLOSED SET from the schema itself, not a hand-copied
    // member list: a new protocol reason that is not on the allow-list must
    // stay non-retryable. That is the load-bearing default-deny property -
    // stronger than naming one terminal reason, and constructible without
    // casts.
    const retryable = new Set<ProviderManagedInstallErrorReason>([
      "disk-full",
      "network",
      "verification",
      "live-owner-stalled",
      "unknown",
    ]);

    for (const reason of providerManagedInstallErrorReasonSchema.options) {
      expect(providerPackRetryable(blockingFailure(reason, null))).toBe(
        retryable.has(reason),
      );
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
    // It names what actually happened, in the user's terms - and names the
    // STORE rather than the machine, because the lease record carries no
    // machine identity and "on this device" is false in the one topology that
    // makes this reason common.
    expect(copy).toContain("another Traycer process using this Traycer folder");
    expect(copy).not.toContain("on this device");
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
      providerPackRetryable(
        // The wire's own distinction: a real future retry time, where
        // `unrepairable` always travels with null.
        blockingFailure("live-owner-stalled", 1_700_000_000_000),
      ),
    ).toBe(true);
  });
});
