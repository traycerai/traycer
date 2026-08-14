import { describe, expect, it } from "vitest";
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  customNameFromIdentityDraft,
  overviewEndpointParts,
  splitDoctorIssuesByVantage,
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

describe("overviewEndpointParts", () => {
  const localHost: LocalHostSnapshot = {
    hostId: "host-a",
    availability: "available",
    websocketUrl: "ws://127.0.0.1:8765",
    version: "1.5.0",
    pid: 4821,
    systemHostName: "hardiks-macbook",
    displayName: "hardiks-macbook",
  };

  it("shows the loopback URL and pid for a local host", () => {
    const parts = overviewEndpointParts({
      host: hostScopeOptionFixture({ hostId: "host-a", isLocalMachine: true }),
      busySessionCount: null,
      localHost,
    });
    // No version here on purpose — the identity line above owns it. Printing
    // it in both places is what let the card show v1.4.2 (from the registry
    // row) and v1.5.0 (from the RPC) at the same time.
    expect(parts).toEqual(["ws://127.0.0.1:8765", "pid 4821"]);
  });

  it("shows only the relay origin for a remote host, never the full URL", () => {
    const parts = overviewEndpointParts({
      host: hostScopeOptionFixture({
        hostId: "host-b",
        isLocalMachine: false,
        entry: {
          hostId: "host-b",
          label: "host-b",
          kind: "remote",
          websocketUrl: "wss://relay.traycer.ai/rpc/abc123secret",
          version: "1.5.0",
          transportDialability: "dialable",
        },
      }),
      busySessionCount: 2,
      localHost: null,
    });
    expect(parts).toEqual(["via relay.traycer.ai", "2 active sessions"]);
    expect(parts.some((p) => p.includes("abc123secret"))).toBe(false);
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
