import { isValidElement, type ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import type { DefaultHostReadinessPresentation } from "@/components/layout/host-readiness-controller-context";
import { hostFailureReportIssueAction } from "@/components/layout/host-failure-report";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { isReportIssueDraftContext } from "@/lib/report-issue-draft-context";
import type { HostStatusSnapshot } from "@/lib/host/compatibility-state";

/** `ReportIssueActionProps` is module-private; borrow its shape structurally. */
type ReportIssueActionProps = ComponentProps<typeof ReportIssueAction>;

/**
 * `EMPTY_DEFAULT_HOST_PRESENTATION` is module-private, so this fixture rebuilds
 * the same shape rather than importing it. Only `compatibility.hostStatus`
 * (and `.status`) vary across the cases below; everything else stays at a
 * neutral default matching that private fixture's values.
 */
function neutralPresentation(): DefaultHostReadinessPresentation {
  return {
    targetKind: "unknown",
    localBootIntent: false,
    localHostState: "unknown",
    stage: "loading",
    progress: null,
    lastProgress: null,
    provisioningError: null,
    provisioning: false,
    removed: false,
    hostBusy: false,
    canManageHost: false,
    retryProvisioning: () => undefined,
    forceProvisioning: () => undefined,
    reinstall: () => undefined,
    configureShell: () => undefined,
    refreshDirectory: () => undefined,
    openSettings: () => undefined,
    compatibility: {
      status: "compatible",
      degraded: false,
      unreachable: false,
      hostStatus: null,
    },
  };
}

/**
 * `hostFailureReportIssueAction` builds a `<ReportIssueAction>` element
 * directly (`React.createElement`, via JSX) rather than rendering one, so its
 * pre-filled `message` is readable straight off the returned element's props —
 * no render, no provider tree, no mocking `ReportIssueAction` itself.
 */
function reportedMessage(
  presentation: DefaultHostReadinessPresentation,
): string {
  const element = hostFailureReportIssueAction({
    title: "Could not start Traycer Host",
    message: "Something went wrong.",
    code: "host-failure-test",
    source: "test",
    presentation,
    includeRetainedProgress: false,
  });
  if (!isValidElement<ReportIssueActionProps>(element)) {
    throw new Error(
      "expected hostFailureReportIssueAction to return an element",
    );
  }
  const { context } = element.props;
  if (typeof context === "function" || isReportIssueDraftContext(context)) {
    throw new Error(
      "expected an eager ReportIssueContext, not a draft/builder form",
    );
  }
  const { message } = context;
  if (message === null) {
    throw new Error("expected a non-null report message");
  }
  return message;
}

function compatiblePresentation(
  hostStatus: HostStatusSnapshot | null,
): DefaultHostReadinessPresentation {
  const base = neutralPresentation();
  return {
    ...base,
    compatibility: {
      ...base.compatibility,
      status: "compatible",
      hostStatus,
    },
  };
}

describe("hostFailureReportIssueAction — busySessionCount null vs 0 (traycer#860 health line)", () => {
  // The regression this line exists to prevent: a fabricated `0` used to read
  // as "busy 0 sessions" for a host that never reported a count at all. The
  // upgrade path now yields `null` instead (see `hostStatusUpgradeV10ToV11`),
  // and this is the ONE place a person reads the difference — a pre-filled bug
  // report. A test asserting the same rendered string for both cases would
  // pass even if `count ?? 0` crept back in; these assert genuinely different
  // observable text.
  it("says only 'busy' — no count, and never the literal word 'null' — when the host reported no count", () => {
    const message = reportedMessage(
      compatiblePresentation({
        busy: true,
        busySessionCount: null,
        hostVersion: "1.0.0",
      }),
    );
    expect(message).toContain("compat compatible, busy");
    expect(message).not.toMatch(/busy \d/);
    expect(message).not.toContain("null");
  });

  it("says 'busy 0 sessions' when the host affirmatively reported zero", () => {
    const message = reportedMessage(
      compatiblePresentation({
        busy: true,
        busySessionCount: 0,
        hostVersion: "1.1.0",
      }),
    );
    expect(message).toContain("compat compatible, busy 0 sessions");
  });

  it("says 'busy N sessions' (singular for one) for a real positive count", () => {
    expect(
      reportedMessage(
        compatiblePresentation({
          busy: true,
          busySessionCount: 1,
          hostVersion: "1.1.0",
        }),
      ),
    ).toContain("compat compatible, busy 1 session");
    expect(
      reportedMessage(
        compatiblePresentation({
          busy: true,
          busySessionCount: 3,
          hostVersion: "1.1.0",
        }),
      ),
    ).toContain("compat compatible, busy 3 sessions");
  });

  it("the null-count and zero-count reports are observably different strings", () => {
    const nullMessage = reportedMessage(
      compatiblePresentation({
        busy: true,
        busySessionCount: null,
        hostVersion: "1.0.0",
      }),
    );
    const zeroMessage = reportedMessage(
      compatiblePresentation({
        busy: true,
        busySessionCount: 0,
        hostVersion: "1.1.0",
      }),
    );
    expect(nullMessage).not.toBe(zeroMessage);
  });

  it("omits the busy clause entirely when the host says it is not busy, regardless of count", () => {
    const message = reportedMessage(
      compatiblePresentation({
        busy: false,
        busySessionCount: 0,
        hostVersion: "1.1.0",
      }),
    );
    expect(message).not.toContain("busy");
  });

  it("omits the busy clause when there is no host-status answer at all", () => {
    const message = reportedMessage(compatiblePresentation(null));
    expect(message).not.toContain("busy");
  });
});

describe("hostFailureReportIssueAction — the compat verdict word", () => {
  // Found by a SURVIVED kill probe (P3.2 R6): with `compatibilityPresentation`
  // mutated to report every failed probe as `compatible`, all six tests above
  // stayed green. They vary `hostStatus` and never the verdict - so the health
  // line's whole reason-for-existing, telling triage WHY the probe failed, had
  // no cover at all.
  //
  // It matters most now: the compat verdict no longer reaches a user through
  // any surface (D13 - it is a lease input), so this diagnostic line is the
  // only place a wrong verdict would ever show up, and it shows up in the bug
  // report someone files about something else entirely.
  const verdictCases = [
    {
      name: "a probe that never reached the host reads `unreachable`, never `rejected`",
      status: "failed",
      unreachable: true,
      degraded: false,
      expected: "unreachable",
    },
    {
      name: "a host that answered and rejected the handshake reads `rejected`",
      status: "failed",
      unreachable: false,
      degraded: false,
      expected: "rejected",
    },
    {
      name: "a held verdict reads `compatible (degraded)`, so triage can tell held from fresh",
      status: "compatible",
      unreachable: false,
      degraded: true,
      expected: "compatible (degraded)",
    },
    {
      name: "a version disagreement reads `incompatible`",
      status: "incompatible",
      unreachable: false,
      degraded: false,
      expected: "incompatible",
    },
  ] as const;

  for (const testCase of verdictCases) {
    it(testCase.name, () => {
      const base = neutralPresentation();
      const message = reportedMessage({
        ...base,
        compatibility: {
          ...base.compatibility,
          status: testCase.status,
          unreachable: testCase.unreachable,
          degraded: testCase.degraded,
        },
      });
      expect(message).toContain(`compat ${testCase.expected}`);
    });
  }
});
