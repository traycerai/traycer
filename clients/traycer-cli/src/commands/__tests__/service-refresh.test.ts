import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// `refreshServiceDefinitionUnderContender` (this file's other subject
// under test) resolves the CLI attempt lock's home via `hostHomeDir`, which
// - unless `WithCliUpdateContenderOptions.hostHomeDir` is passed explicitly,
// which this command never does - falls back to `store/paths`'s
// `hostHomeDir(environment)`. That constant is captured from `os.homedir()`
// at module load, so it must be redirected before any import runs.
const osHome = vi.hoisted(() => ({
  current: "",
  // `refreshServiceDefinitionAtSupervisorStart` gates on the platform; the
  // real one unless a test sets it.
  platform: null as NodeJS.Platform | null,
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSync(
      join(actual.tmpdir(), "traycer-service-refresh-test-"),
    );
  }
  return {
    ...actual,
    homedir: () => osHome.current,
    platform: () => osHome.platform ?? actual.platform(),
  };
});

// The platform-specific refresher is stubbed so this test exercises only the
// contender/admission wiring `refreshServiceDefinitionUnderContender` owns,
// not any real systemd/launchd/schtasks call.
const refresherMock = vi.hoisted(() => ({
  refresh: vi.fn(),
}));
// The real contender, observed: how long each caller agrees to wait for it.
const contenderWaits = vi.hoisted(() => ({
  seen: (): number[] => [],
  clear: (): void => undefined,
}));
vi.mock("../../host/update-contender", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/update-contender")>();
  const spy = vi.fn(actual.withCliUpdateContender);
  contenderWaits.seen = () => spy.mock.calls.map(([options]) => options.waitMs);
  contenderWaits.clear = () => spy.mockClear();
  return { ...actual, withCliUpdateContender: spy };
});
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
  refreshServiceDefinitionAtSupervisorStart,
  refreshServiceDefinitionUnderContender,
} from "../service-refresh";
import type { ServiceDefinitionRefreshOutcome } from "../service-refresh";
import { withCliUpdateContender } from "../../host/update-contender";
import { serviceLabelFor } from "../../service/label";
import type { ServiceLabel } from "../../service/label";
import type { ILogger } from "../../logger";

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

  it("refreshed, form 'exit-timeout': says the host now gets its full shutdown time, not that the launcher changed", () => {
    const line = describeServiceDefinitionRefresh(
      outcomeFor({
        kind: "refreshed",
        form: "exit-timeout",
        appliesAt: "next-login",
      }),
    );
    expect(line).toContain("now gives the host its full time to shut down");
    expect(line).toContain("applies at the next login");
    expect(line).not.toContain("launcher");
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

interface LoggedLine {
  readonly level: "info" | "warn";
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

function recordingLogger(lines: LoggedLine[]): ILogger {
  return {
    debug: () => undefined,
    info: (message, fields) => lines.push({ level: "info", message, fields }),
    warn: (message, fields) => lines.push({ level: "warn", message, fields }),
    error: () => undefined,
  };
}

describe("refreshServiceDefinitionAtSupervisorStart", () => {
  const OWN_LABEL = serviceLabelFor("production").id;

  beforeEach(() => {
    refresherMock.refresh.mockReset();
    contenderWaits.clear();
  });

  afterEach(() => {
    osHome.platform = null;
    vi.unstubAllEnvs();
  });

  it("a dev slot that sanitizes to nothing (the label cannot be derived): resolves with a warning and never touches the definition", async () => {
    osHome.platform = "darwin";
    vi.stubEnv("DEV_DESKTOP_SLOT", "!!!");
    const lines: LoggedLine[] = [];

    await expect(
      refreshServiceDefinitionAtSupervisorStart(
        "dev",
        "ai.traycer.host.dev",
        recordingLogger(lines),
      ),
    ).resolves.toBeUndefined();

    expect(refresherMock.refresh).not.toHaveBeenCalled();
    expect(lines.map((line) => line.level)).toEqual(["warn"]);
  });

  it("another label (Desktop's agent): no refresh attempted, nothing logged", async () => {
    const lines: LoggedLine[] = [];

    await refreshServiceDefinitionAtSupervisorStart(
      "production",
      "ai.traycer.desktop.host",
      recordingLogger(lines),
    );

    expect(refresherMock.refresh).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("a platform without a launchd or systemd job (win32): no refresh attempted", async () => {
    osHome.platform = "win32";

    await refreshServiceDefinitionAtSupervisorStart(
      "production",
      OWN_LABEL,
      recordingLogger([]),
    );

    expect(refresherMock.refresh).not.toHaveBeenCalled();
  });

  it("its own label: refreshes once and logs info when the definition was rewritten", async () => {
    osHome.platform = "darwin";
    refresherMock.refresh.mockResolvedValue({
      kind: "refreshed",
      form: "exit-timeout",
      appliesAt: "next-login",
    });
    const lines: LoggedLine[] = [];

    await refreshServiceDefinitionAtSupervisorStart(
      "production",
      OWN_LABEL,
      recordingLogger(lines),
    );

    expect(refresherMock.refresh).toHaveBeenCalledTimes(1);
    expect(refresherMock.refresh).toHaveBeenCalledWith(
      serviceLabelFor("production"),
    );
    expect(lines).toEqual([
      {
        level: "info",
        message: "Host service definition refreshed at supervisor start",
        fields: {
          environment: "production",
          label: OWN_LABEL,
          form: "exit-timeout",
          appliesAt: "next-login",
        },
      },
    ]);
  });

  it("a current definition: refreshes without logging", async () => {
    osHome.platform = "linux";
    refresherMock.refresh.mockResolvedValue({ kind: "current" });
    const lines: LoggedLine[] = [];

    await refreshServiceDefinitionAtSupervisorStart(
      "production",
      OWN_LABEL,
      recordingLogger(lines),
    );

    expect(refresherMock.refresh).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
  });

  it("a refresher that throws: resolves and logs a warning carrying the cause", async () => {
    osHome.platform = "linux";
    refresherMock.refresh.mockRejectedValue(new Error("unit not writable"));
    const lines: LoggedLine[] = [];

    await expect(
      refreshServiceDefinitionAtSupervisorStart(
        "production",
        OWN_LABEL,
        recordingLogger(lines),
      ),
    ).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("warn");
    expect(lines[0]?.fields).toMatchObject({
      environment: "production",
      cause: "unit not writable",
    });
  });

  it("asks the update contender for no wait, so a held one never stalls the start", async () => {
    osHome.platform = "darwin";
    refresherMock.refresh.mockResolvedValue({ kind: "current" });

    await refreshServiceDefinitionAtSupervisorStart(
      "production",
      OWN_LABEL,
      recordingLogger([]),
    );

    expect(contenderWaits.seen()).toEqual([0]);
  });

  it("the update contender held elsewhere: resolves with a warning and never touches the definition", async () => {
    osHome.platform = "darwin";
    const lines: LoggedLine[] = [];

    await withCliUpdateContender(
      {
        environment: "production",
        reason: "service-refresh",
        waitMs: 30_000,
        pollIntervalMs: 100,
        admission: "service-maintenance",
      },
      () =>
        refreshServiceDefinitionAtSupervisorStart(
          "production",
          OWN_LABEL,
          recordingLogger(lines),
        ),
    );

    expect(refresherMock.refresh).not.toHaveBeenCalled();
    expect(lines.map((line) => line.level)).toEqual(["warn"]);
  });
});
