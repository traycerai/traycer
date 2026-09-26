import { describe, expect, it } from "vitest";
import { describeServiceDefinitionRefresh } from "../service-refresh";
import type { ServiceDefinitionRefreshOutcome } from "../service-refresh";
import type { ServiceLabel } from "../../service/label";

// `describeServiceDefinitionRefresh`: the one line `traycer host service
// refresh` and `host lifecycle set` both print for a refresh outcome. One
// case per `ServiceDefinitionRefresh["kind"]` (service-definition.ts), plus
// the two `appliesAt` branches of "refreshed" - the wording split that tells
// the operator whether a respawn before the next login already picks up the
// rewrite (Linux/Windows "next-start") or has to wait for it (macOS's
// launchd-cached "next-login").

const LABEL: ServiceLabel = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production",
  devSlot: null,
};

function outcomeFor(
  result: ServiceDefinitionRefreshOutcome["result"],
): ServiceDefinitionRefreshOutcome {
  return { label: LABEL, result };
}

describe("describeServiceDefinitionRefresh", () => {
  it("not-registered: says there is no definition to refresh, naming the label", () => {
    const line = describeServiceDefinitionRefresh(
      outcomeFor({ kind: "not-registered" }),
    );
    expect(line).toContain("ai.traycer.host");
    expect(line).toContain("is not registered");
    expect(line).toContain("no definition to refresh");
  });

  it("current: says nothing was changed", () => {
    const line = describeServiceDefinitionRefresh(
      outcomeFor({ kind: "current" }),
    );
    expect(line).toContain("ai.traycer.host");
    expect(line).toContain("already runs the current launcher");
    expect(line).toContain("nothing was changed");
  });

  it("refreshed, appliesAt 'next-start': says the new launcher applies from its next start, and does not mention login", () => {
    const line = describeServiceDefinitionRefresh(
      outcomeFor({
        kind: "refreshed",
        form: "direct",
        appliesAt: "next-start",
      }),
    );
    expect(line).toContain("now runs the current launcher");
    expect(line).toContain("Nothing was started or stopped");
    expect(line).toContain("applies from its next start");
    expect(line).not.toContain("next login");
  });

  it("refreshed, appliesAt 'next-login': says it applies at the next login, not to an in-session respawn", () => {
    const line = describeServiceDefinitionRefresh(
      outcomeFor({
        kind: "refreshed",
        form: "launcher-file",
        appliesAt: "next-login",
      }),
    );
    expect(line).toContain("now runs the current launcher");
    expect(line).toContain("Nothing was started or stopped");
    expect(line).toContain("applies at the next login");
    expect(line).not.toContain("applies from its next start");
  });

  it("every case names the label's own id, not a generic 'the service'", () => {
    const other: ServiceLabel = {
      id: "ai.traycer.host.dev.myslot",
      displayName: "Traycer Host (Dev myslot)",
      environment: "dev",
      devSlot: "myslot",
    };
    const line = describeServiceDefinitionRefresh({
      label: other,
      result: { kind: "current" },
    });
    expect(line).toContain("ai.traycer.host.dev.myslot");
  });
});
