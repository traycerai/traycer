import { describe, expect, it } from "vitest";
import {
  deriveLegacyUpdateFacts,
  NO_LEGACY_UPDATE_FACTS,
  type LegacyUpdateInstallation,
} from "@/lib/host/fleet-update/legacy-update-facts";

// Table-driven over the module's own truth table (see its doc comment).
// Real version strings throughout, run through the REAL comparator
// (`@traycer-clients/shared/host-version/compare-host-versions`) rather than a
// stub, so a change to SemVer precedence or the incomparable-version rule
// shows up here rather than only in the comparator's own suite.

function managed(
  installRecord: {
    readonly version: string;
    readonly runtimeVersion: string | null;
  },
  stagedRecord: { readonly version: string } | null = null,
): LegacyUpdateInstallation {
  return { status: "managed", installRecord, stagedRecord };
}

describe("deriveLegacyUpdateFacts — activationDebt, runtimeVersion SET", () => {
  it("equal to the running stamp - no debt", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed({ version: "1.3.0", runtimeVersion: "1.3.0" }),
      runningVersion: "1.3.0",
      busy: false,
      busySessionCount: null,
    });
    expect(facts.activationDebt).toBeNull();
  });

  it("unequal (running AHEAD of the recorded stamp) - debt", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed({ version: "1.3.0", runtimeVersion: "1.2.0" }),
      runningVersion: "1.3.0",
      busy: false,
      busySessionCount: null,
    });
    expect(facts.activationDebt).toEqual({ installedVersion: "1.3.0" });
  });

  it("unequal (running BEHIND the recorded stamp) - debt, the other direction", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed({ version: "1.3.0", runtimeVersion: "1.3.0" }),
      runningVersion: "1.2.0",
      busy: false,
      busySessionCount: null,
    });
    expect(facts.activationDebt).toEqual({ installedVersion: "1.3.0" });
  });

  it("unequal NON-SemVer staging stamps - debt. The domain is EQUALITY, never ordering", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed({
        version: "1.3.0",
        runtimeVersion: "staging.2.abc",
      }),
      runningVersion: "staging.1.def",
      busy: false,
      busySessionCount: null,
    });
    expect(facts.activationDebt).toEqual({ installedVersion: "1.3.0" });
  });

  it("equal NON-SemVer staging stamps - no debt", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed({
        version: "1.3.0",
        runtimeVersion: "staging.5.xyz",
      }),
      runningVersion: "staging.5.xyz",
      busy: false,
      busySessionCount: null,
    });
    expect(facts.activationDebt).toBeNull();
  });
});

describe("deriveLegacyUpdateFacts — activationDebt, no runtimeVersion (catalog-version fallback)", () => {
  it("running version is not valid SemVer (a foreign runtime) - no debt", () => {
    // Falsification: removing the `isValidHostVersion` guard and letting
    // `compareHostVersions` alone decide would coincidentally also read
    // "not comparable" here, so this case alone would not catch a dropped
    // guard - the rc.2/rc.3 case right below is what would.
    const facts = deriveLegacyUpdateFacts({
      installation: managed({ version: "1.3.0", runtimeVersion: null }),
      runningVersion: "staging.1.abc",
      busy: false,
      busySessionCount: null,
    });
    expect(facts.activationDebt).toBeNull();
  });

  it("comparable and unequal (rc.2 running, rc.3 installed) - debt", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed({
        version: "1.3.0-rc.3",
        runtimeVersion: null,
      }),
      runningVersion: "1.3.0-rc.2",
      busy: false,
      busySessionCount: null,
    });
    expect(facts.activationDebt).toEqual({ installedVersion: "1.3.0-rc.3" });
  });

  it("0.0.0-dev IS valid SemVer, so a dev host beside a released record reads as debt", () => {
    // Stated explicitly because it looks like it should be an exemption and is
    // not: the CLI's own `readActivationState` gives the same answer, and the
    // module's doc calls this out by name so nobody "fixes" it on one side only.
    const facts = deriveLegacyUpdateFacts({
      installation: managed({ version: "1.3.0", runtimeVersion: null }),
      runningVersion: "0.0.0-dev",
      busy: false,
      busySessionCount: null,
    });
    expect(facts.activationDebt).toEqual({ installedVersion: "1.3.0" });
  });

  it("equal - no debt", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed({ version: "1.3.0", runtimeVersion: null }),
      runningVersion: "1.3.0",
      busy: false,
      busySessionCount: null,
    });
    expect(facts.activationDebt).toBeNull();
  });

  it("incomparable (installed is a local-file pin) - no debt", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed({
        version: "local-abc-1699999999999",
        runtimeVersion: null,
      }),
      runningVersion: "1.3.0",
      busy: false,
      busySessionCount: null,
    });
    expect(facts.activationDebt).toBeNull();
  });
});

describe("deriveLegacyUpdateFacts — unmanaged / absent installation", () => {
  it("unmanaged - both facts null", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: { status: "unmanaged" },
      runningVersion: "1.3.0",
      busy: true,
      busySessionCount: 4,
    });
    expect(facts).toEqual(NO_LEGACY_UPDATE_FACTS);
  });

  it("null installation - both facts null", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: null,
      runningVersion: "1.3.0",
      busy: true,
      busySessionCount: 4,
    });
    expect(facts).toEqual(NO_LEGACY_UPDATE_FACTS);
  });
});

describe("deriveLegacyUpdateFacts — stagedWait", () => {
  it("staged differs from installed, busy, positive count - present with that count", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed(
        { version: "1.3.0-rc.2", runtimeVersion: "1.3.0-rc.2" },
        { version: "1.3.0-rc.3" },
      ),
      runningVersion: "1.3.0-rc.2",
      busy: true,
      busySessionCount: 2,
    });
    expect(facts.stagedWait).toEqual({
      stagedVersion: "1.3.0-rc.3",
      blockingSessionCount: 2,
    });
  });

  it("busy but the host reported a count of exactly zero - stagedWait present, count null (a claim, not work)", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed(
        { version: "1.3.0-rc.2", runtimeVersion: "1.3.0-rc.2" },
        { version: "1.3.0-rc.3" },
      ),
      runningVersion: "1.3.0-rc.2",
      busy: true,
      busySessionCount: 0,
    });
    expect(facts.stagedWait).toEqual({
      stagedVersion: "1.3.0-rc.3",
      blockingSessionCount: null,
    });
  });

  it("busy but the host reported no count at all (null) - stagedWait present, count null", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed(
        { version: "1.3.0-rc.2", runtimeVersion: "1.3.0-rc.2" },
        { version: "1.3.0-rc.3" },
      ),
      runningVersion: "1.3.0-rc.2",
      busy: true,
      busySessionCount: null,
    });
    expect(facts.stagedWait).toEqual({
      stagedVersion: "1.3.0-rc.3",
      blockingSessionCount: null,
    });
  });

  it("not busy - stagedWait null even with a real stage and a positive count", () => {
    // Falsification: dropping the `input.busy` conjunct from `stagedWait`'s
    // guard would make this assert a non-null stagedWait.
    const facts = deriveLegacyUpdateFacts({
      installation: managed(
        { version: "1.3.0-rc.2", runtimeVersion: "1.3.0-rc.2" },
        { version: "1.3.0-rc.3" },
      ),
      runningVersion: "1.3.0-rc.2",
      busy: false,
      busySessionCount: 2,
    });
    expect(facts.stagedWait).toBeNull();
  });

  it("staged version equals the installed version - stagedWait null (nothing new parked)", () => {
    // Falsification: dropping the `staged.version !== installed.version`
    // conjunct would make this assert a non-null stagedWait.
    const facts = deriveLegacyUpdateFacts({
      installation: managed(
        { version: "1.3.0-rc.2", runtimeVersion: "1.3.0-rc.2" },
        { version: "1.3.0-rc.2" },
      ),
      runningVersion: "1.3.0-rc.2",
      busy: true,
      busySessionCount: 2,
    });
    expect(facts.stagedWait).toBeNull();
  });

  it("no staged record at all - stagedWait null", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed(
        { version: "1.3.0-rc.2", runtimeVersion: "1.3.0-rc.2" },
        null,
      ),
      runningVersion: "1.3.0-rc.2",
      busy: true,
      busySessionCount: 2,
    });
    expect(facts.stagedWait).toBeNull();
  });
});

describe("deriveLegacyUpdateFacts — debt and stagedWait can both be present", () => {
  it("installed ahead of running (debt) AND a further stage waiting on busy work", () => {
    const facts = deriveLegacyUpdateFacts({
      installation: managed(
        { version: "1.3.0-rc.3", runtimeVersion: null },
        { version: "1.3.0-rc.4" },
      ),
      runningVersion: "1.3.0-rc.2",
      busy: true,
      busySessionCount: 1,
    });
    expect(facts.activationDebt).toEqual({ installedVersion: "1.3.0-rc.3" });
    expect(facts.stagedWait).toEqual({
      stagedVersion: "1.3.0-rc.4",
      blockingSessionCount: 1,
    });
  });
});
