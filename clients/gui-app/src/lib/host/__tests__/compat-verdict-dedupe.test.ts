import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ClientCompatibilityRequirement } from "@traycer/protocol/framework/index";
import { useHostCompatibilityAuthorityReport } from "@/lib/host/compatibility-state";
import { transportEvidenceRelay } from "@/lib/host/transport-evidence";
import type { HostCompatibility } from "@/lib/host/compatibility-state";
import type { SelectionIncompatibility } from "@traycer-clients/shared/host-selection/selection-authority-contract";

/**
 * The SECOND dedupe layer between a compat probe and the UI.
 *
 * `useHostCompatibilityAuthorityReport` reports a verdict at most once per
 * distinct key, and the key used to be
 * `hostId | code | hostVersion | probedOnSessionId`. On the epoch path the
 * middle two are constant - a fatal frame carries method canonicals rather
 * than version strings, so `hostVersion` is null by design, and the code is a
 * bare `INCOMPATIBLE` - which left the session anchor as the only thing that
 * could distinguish two structurally different epoch verdicts.
 *
 * The anchor covers the COMMON case, and that is why this layer is the second
 * line rather than the first: a host that updates gets a new session, hence a
 * new key. `leaseEquals` is the one that actually gates delivery. The two
 * cases the anchor does not cover are both real, though, and are what these
 * specs pin: a null-anchored transport, and a requirement recovered within one
 * session after an earlier one failed to parse.
 */

afterEach(cleanup);

function requirement(
  overrides: Partial<ClientCompatibilityRequirement>,
): ClientCompatibilityRequirement {
  return {
    minimumCompatibilityEpoch: 2,
    observedCompatibilityEpoch: 1,
    failure: "below-minimum",
    observedClientKind: "desktop",
    observedClientAppVersion: "1.1.10",
    observedClientAppVersionStatus: "valid",
    minimumKnownClientAppVersion: "1.2.0-rc.2",
    upgradeChannel: "rc",
    ...overrides,
  };
}

/**
 * An `incompatible` verdict whose fatal carries (or omits) the structured
 * requirement.
 *
 * `incompatibleMethods: null` is what makes `describeCompatVerdictForAuthority`
 * produce a BARE `INCOMPATIBLE` code with no blocking suffix - the exact shape
 * that made the old key non-discriminating. A manifest rejection would carry a
 * blocking reason and get a suffixed code, which is why this defect only ever
 * bit the epoch path.
 */
function incompatible(
  clientCompatibilityRequirement: ClientCompatibilityRequirement | undefined,
): HostCompatibility {
  return {
    status: "incompatible",
    retry: () => undefined,
    error: new HostRpcError({
      code: "INCOMPATIBLE",
      message: "too old",
      requestId: "req-1",
      method: "host.status",
      fatalDetails: {
        code: "INCOMPATIBLE",
        reason: "This Traycer client is too old for this host.",
        incompatibleMethods: null,
        upgradeGuidance: {
          clientShouldUpgrade: true,
          hostShouldUpgrade: false,
        },
        retryable: false,
        ...(clientCompatibilityRequirement === undefined
          ? {}
          : { clientCompatibilityRequirement }),
      },
    }),
  };
}

/**
 * The argument `reportCompatVerdict` takes, spelled out so the spy below is
 * typed. `ReturnType<typeof vi.spyOn>` degrades `.mock.calls` to `any`, and
 * every read off it becomes an unsafe access - the same reason
 * `compatibility-state.test.ts` names its own `CompatVerdictReport`.
 */
type CompatVerdictReport = {
  readonly hostId: string;
  readonly probedOnSessionId: string | null;
  readonly hostVersion: string | null;
  readonly incompatibility: SelectionIncompatibility | null;
};

type CompatReportSpy = MockInstance<(input: CompatVerdictReport) => void>;

/** Reported requirements, in order, for `host-a`. */
function reportedRequirements(
  spy: CompatReportSpy,
): (ClientCompatibilityRequirement | null)[] {
  const out: (ClientCompatibilityRequirement | null)[] = [];
  for (const [input] of spy.mock.calls) {
    if (input.hostId !== "host-a") continue;
    out.push(input.incompatibility?.clientCompatibility ?? null);
  }
  return out;
}

function driveVerdicts(
  verdicts: readonly HostCompatibility[],
): (ClientCompatibilityRequirement | null)[] {
  const spy: CompatReportSpy = vi.spyOn(
    transportEvidenceRelay,
    "reportCompatVerdict",
  );
  spy.mockClear();
  try {
    const { rerender } = renderHook(
      ({ compatibility }: { compatibility: HostCompatibility }) => {
        useHostCompatibilityAuthorityReport(compatibility, "host-a");
      },
      { initialProps: { compatibility: verdicts[0] } },
    );
    for (const compatibility of verdicts.slice(1)) {
      rerender({ compatibility });
    }
    return reportedRequirements(spy);
  } finally {
    spy.mockRestore();
  }
}

describe("compat verdict dedupe and the client-compatibility requirement", () => {
  it("reports a null -> structured transition on the same session", () => {
    // A requirement that failed to parse dropped to null
    // (`parseClientCompatibility` is deliberately lossy rather than fatal),
    // and a well-formed one follows on the SAME session - so the anchor is
    // unchanged and cannot discriminate. Without the requirement in the key
    // the second verdict is swallowed and the dialog stays on the generic
    // `update-host` variant.
    const reported = driveVerdicts([
      incompatible(undefined),
      incompatible(requirement({})),
    ]);
    expect(reported).toHaveLength(2);
    expect(reported[0]).toBeNull();
    expect(reported[1]).toEqual(requirement({}));
  });

  it("reports a RAISED FLOOR on the same session", () => {
    const reported = driveVerdicts([
      incompatible(requirement({})),
      incompatible(
        requirement({
          minimumCompatibilityEpoch: 3,
          minimumKnownClientAppVersion: "1.3.0",
          upgradeChannel: "stable",
        }),
      ),
    ]);
    expect(reported).toHaveLength(2);
    expect(reported[1]?.minimumKnownClientAppVersion).toBe("1.3.0");
  });

  it("STILL dedupes an identical verdict re-rendered", () => {
    // The other half. This hook runs in a dialog that re-renders on every
    // lease delivery in the app, so a key that changed per render would flood
    // the authority with duplicate verdicts - each of which it ranks and
    // stores.
    const first = incompatible(requirement({}));
    const second = incompatible(requirement({}));
    const reported = driveVerdicts([first, second, first]);
    expect(reported).toHaveLength(1);
  });

  it("does not report anything for a non-verdict state", () => {
    // `checking` / `failed` are not statements about COMPATIBILITY, and
    // reporting one would launder a transport failure into a
    // `dead("incompatible")` lease no reconnection could clear.
    const reported = driveVerdicts([
      { status: "checking", retry: () => undefined },
    ]);
    expect(reported).toHaveLength(0);
  });
});
