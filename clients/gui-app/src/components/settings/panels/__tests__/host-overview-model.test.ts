import { describe, expect, it } from "vitest";
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import {
  customNameFromIdentityDraft,
  resolveOverviewMethodDegrade,
  splitDoctorIssuesByVantage,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";

function issue(code: string): HostDoctorIssue {
  return {
    code,
    severity: "warning",
    title: code,
    message: code,
    fixAction: null,
    terminalCommand: null,
    details: null,
  };
}

describe("splitDoctorIssuesByVantage", () => {
  it("moves a SERVICE_STOPPED trivially-green code to disprovenByTransport for a local vantage", () => {
    const split = splitDoctorIssuesByVantage(
      [issue("SERVICE_STOPPED"), issue("STALE_CONFIG")],
      ["SERVICE_STOPPED"],
    );
    expect(split.actionable.map((i) => i.code)).toEqual(["STALE_CONFIG"]);
    expect(split.disprovenByTransport.map((i) => i.code)).toEqual([
      "SERVICE_STOPPED",
    ]);
  });

  it("keeps the same code actionable for a relay vantage (empty trivially-green list)", () => {
    const split = splitDoctorIssuesByVantage([issue("SERVICE_STOPPED")], []);
    expect(split.actionable.map((i) => i.code)).toEqual(["SERVICE_STOPPED"]);
    expect(split.disprovenByTransport).toEqual([]);
  });
});

describe("resolveOverviewMethodDegrade", () => {
  it("is unsupported only for handshake-false without a fallback lane", () => {
    const rows: ReadonlyArray<{
      readonly supported: boolean | null;
      readonly fallbackServes: boolean;
      readonly expected: OverviewDegradeReason | null;
    }> = [
      { supported: null, fallbackServes: false, expected: null },
      { supported: null, fallbackServes: true, expected: null },
      { supported: true, fallbackServes: false, expected: null },
      { supported: true, fallbackServes: true, expected: null },
      { supported: false, fallbackServes: true, expected: null },
      { supported: false, fallbackServes: false, expected: "unsupported" },
    ];
    for (const row of rows) {
      expect(
        resolveOverviewMethodDegrade(row.supported, row.fallbackServes),
      ).toBe(row.expected);
    }
  });
});

describe("customNameFromIdentityDraft", () => {
  it("clears the override for an empty draft", () => {
    expect(customNameFromIdentityDraft("")).toBeNull();
    expect(customNameFromIdentityDraft("   ")).toBeNull();
  });

  it("collapses internal whitespace", () => {
    expect(customNameFromIdentityDraft("  My   Host  ")).toBe("My Host");
  });

  it("does NOT clear when the draft equals the host's systemName", () => {
    // Unlike the bridge rule (`customNameFromDraft`), typing the machine's own
    // name is not special here: a provisioned host's label can differ from its
    // systemName, so clearing on a systemName match would silently swap the
    // typed name for the label.
    expect(customNameFromIdentityDraft("hardiks-macbook")).toBe(
      "hardiks-macbook",
    );
  });
});
