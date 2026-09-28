import { afterAll, describe, expect, it, vi } from "vitest";

// `refreshServiceDefinitionUnderContender` (this file's other subject
// under test) resolves the CLI attempt lock's home via `hostHomeDir`, which
// - unless `WithCliUpdateContenderOptions.hostHomeDir` is passed explicitly,
// which this command never does - falls back to `store/paths`'s
// `hostHomeDir(environment)`. That constant is captured from `os.homedir()`
// at module load, so it must be redirected before any import runs.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSync(
      join(actual.tmpdir(), "traycer-service-refresh-test-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

// The platform-specific refresher is stubbed so this test exercises only the
// contender/admission wiring `refreshServiceDefinitionUnderContender` owns,
// not any real systemd/launchd/schtasks call.
const refresherMock = vi.hoisted(() => ({
  refresh: vi.fn(),
}));
vi.mock("../../service/definition-refresh", () => ({
  createServiceDefinitionRefresher: () => ({
    inspect: async () => {
      throw new Error("inspect should not be called by the refresh command");
    },
    refresh: refresherMock.refresh,
  }),
}));

afterAll(async () => {
  if (osHome.current !== "") {
    const { rm } = await import("node:fs/promises");
    await rm(osHome.current, { recursive: true, force: true });
  }
});

import {
  describeServiceDefinitionRefresh,
  refreshServiceDefinitionUnderContender,
} from "../service-refresh";
import type { ServiceDefinitionRefreshOutcome } from "../service-refresh";
import { serviceLabelFor } from "../../service/label";
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

describe("refreshServiceDefinitionUnderContender", () => {
  it("calls the platform refresher's refresh exactly once, with the environment's own label, and returns its result under the label", async () => {
    const refreshResult: ServiceDefinitionRefreshOutcome["result"] = {
      kind: "current",
    };
    refresherMock.refresh.mockReset();
    refresherMock.refresh.mockResolvedValue(refreshResult);

    const outcome = await refreshServiceDefinitionUnderContender("production");

    expect(refresherMock.refresh).toHaveBeenCalledTimes(1);
    expect(refresherMock.refresh).toHaveBeenCalledWith(
      serviceLabelFor("production"),
    );
    expect(outcome).toEqual({
      label: serviceLabelFor("production"),
      result: refreshResult,
    });
  });

  it("propagates the platform refresher's own rejection unchanged", async () => {
    refresherMock.refresh.mockReset();
    const refreshError = new Error("refresh failed for real");
    refresherMock.refresh.mockRejectedValue(refreshError);

    await expect(
      refreshServiceDefinitionUnderContender("production"),
    ).rejects.toThrow("refresh failed for real");
  });
});
