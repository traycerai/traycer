import { fireEvent, screen, waitFor } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import type { LogLevel } from "@traycer/protocol/config/log-level";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  LogLevelScope,
  LogLevelsBridge,
  LogLevelsSnapshot,
} from "@/lib/desktop-log-levels";
import type {
  DesktopSupportBridge,
  DesktopSupportLogTailResult,
  DesktopSupportSnapshot,
} from "@/lib/windows/types";

/**
 * Fixtures shared by the two Diagnostics suites.
 *
 * Diagnostics is one feature rendered by two panels — the app's own logging and
 * heap under Application, the selected host's under the host picker — and both
 * are driven by the same desktop bridges. Every helper here belongs to BOTH, so
 * a change to what the bridge returns cannot land in one suite's copy only.
 *
 * Deliberately not extended with panel-specific scaffolding: the host suite's
 * `HostScope` / `HostClient` wiring depends on module mocks that must be hoisted
 * inside the suite that uses them, and pulling it here would make the app suite
 * import a host-RPC harness it has no host in.
 */

/**
 * The two independent bridges the app page reads off `globalThis.runnerHost`.
 *
 * They are separate slots on ONE object, which is why every installer here
 * merges rather than assigns: `getLogLevelsBridge` and
 * `getDesktopHeapSnapshotBridge` each reach into `platform` for their own key,
 * so a helper that replaced the whole object would silently uninstall the other
 * page half. That is not hypothetical — the heap capture went uncovered for
 * exactly this reason, since installing the log-levels bridge blanked
 * `platform.diagnostics` and the Memory group fell back to its unavailable
 * branch under a test that only ever checked the heading.
 */
interface TestHeapSnapshotBridge {
  readonly takeHeapSnapshot: () => Promise<string | null>;
}

interface TestRunnerPlatform {
  readonly logLevels: LogLevelsBridge | undefined;
  readonly diagnostics: TestHeapSnapshotBridge | undefined;
}

interface GlobalWithRunnerHost {
  runnerHost: { readonly platform: TestRunnerPlatform } | undefined;
}

const globalWithRunnerHost = globalThis as typeof globalThis &
  GlobalWithRunnerHost;

function mergePlatform(patch: Partial<TestRunnerPlatform>): void {
  const current: TestRunnerPlatform = globalWithRunnerHost.runnerHost
    ?.platform ?? { logLevels: undefined, diagnostics: undefined };
  globalWithRunnerHost.runnerHost = {
    platform: { ...current, ...patch },
  };
}

/** The heap-capture half — `platform.diagnostics`, not `platform.logLevels`. */
export function installHeapSnapshotBridge(
  takeHeapSnapshot: () => Promise<string | null>,
): void {
  mergePlatform({ diagnostics: { takeHeapSnapshot } });
}

export function defaultSnapshot(): LogLevelsSnapshot {
  return {
    desktopLogLevel: "info",
    cliLogLevel: "info",
    hostLogLevel: "info",
  };
}

export function scopeField(scope: LogLevelScope): keyof LogLevelsSnapshot {
  switch (scope) {
    case "desktop":
      return "desktopLogLevel";
    case "cli":
      return "cliLogLevel";
    case "host":
      return "hostLogLevel";
  }
}

export interface LogLevelsBridgeMocks {
  readonly bridge: LogLevelsBridge;
  readonly getMock: Mock<() => Promise<LogLevelsSnapshot>>;
  readonly setMock: Mock<
    (scope: LogLevelScope, level: LogLevel) => Promise<LogLevelsSnapshot>
  >;
  readonly getSnapshot: () => LogLevelsSnapshot;
}

export interface HeldLogLevelsBridgeMocks extends LogLevelsBridgeMocks {
  readonly flushNextSet: () => void;
}

/**
 * One installer builds BOTH fixtures, so they cannot drift: the suites depend
 * on the two answering identically apart from WHEN a set() settles, and that
 * one difference is exactly the `settle` parameter.
 */
function installLogLevelsBridgeSettling(
  initial: LogLevelsSnapshot,
  settle: "immediately" | "on-flush",
): HeldLogLevelsBridgeMocks {
  let snapshot = initial;
  const pendingFlushes: Array<() => void> = [];
  const applySet = (
    scope: LogLevelScope,
    level: LogLevel,
  ): LogLevelsSnapshot => {
    snapshot = {
      ...snapshot,
      [scopeField(scope)]: level,
    };
    return snapshot;
  };
  const getMock = vi.fn(() => Promise.resolve(snapshot));
  const setMock = vi.fn((scope: LogLevelScope, level: LogLevel) =>
    settle === "immediately"
      ? Promise.resolve(applySet(scope, level))
      : new Promise<LogLevelsSnapshot>((resolve) => {
          pendingFlushes.push(() => {
            resolve(applySet(scope, level));
          });
        }),
  );
  const bridge: LogLevelsBridge = {
    get: getMock,
    set: setMock,
  };
  mergePlatform({ logLevels: bridge });
  return {
    bridge,
    getMock,
    setMock,
    getSnapshot: () => snapshot,
    flushNextSet: () => {
      const next = pendingFlushes.shift();
      if (next === undefined) {
        throw new Error("No pending log-levels set() to flush");
      }
      next();
    },
  };
}

export function installLogLevelsBridge(
  initial: LogLevelsSnapshot,
): LogLevelsBridgeMocks {
  return installLogLevelsBridgeSettling(initial, "immediately");
}

/**
 * Same as installLogLevelsBridge, but each set() stays pending until
 * flushNextSet() so callers can assert in-flight disable state during reset.
 */
export function installHeldLogLevelsBridge(
  initial: LogLevelsSnapshot,
): HeldLogLevelsBridgeMocks {
  return installLogLevelsBridgeSettling(initial, "on-flush");
}

/** Installs an arbitrary log-levels bridge — for the failure-shaped cases. */
export function installCustomLogLevelsBridge(bridge: LogLevelsBridge): void {
  mergePlatform({ logLevels: bridge });
}

/**
 * Drops the WHOLE `runnerHost` — every installed bridge half, not only
 * `logLevels`. The doc block above names replacing the whole object as how a
 * heap capture went silently uncovered, so the name states the blast radius
 * rather than hiding it behind the one slot most callers think about.
 */
export function clearRunnerHostBridges(): void {
  globalWithRunnerHost.runnerHost = undefined;
}

/**
 * Both entries the real bridge answers with — see `support.ts`'s `getSnapshot`,
 * which builds `desktop` and `host` unconditionally.
 *
 * Carrying both matters now that the two pages split the list: the app page
 * takes `desktop` and the host page's bridge fallback takes everything else. A
 * fixture with only `desktop` would let the host page's filter look correct
 * while it silently dropped the one entry that page is supposed to show.
 */
export function readySupportSnapshot(): DesktopSupportSnapshot {
  return {
    appName: "Traycer",
    appVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    user: { status: "signed-out", userName: null, email: null },
    versions: { electron: "1", chrome: "1", node: "1" },
    host: { status: "ready", version: "1", pid: 1, hostId: "host-1" },
    logs: [
      { target: "desktop", label: "Desktop Log", path: "/tmp/desktop.log" },
      { target: "host", label: "Host Log", path: "/tmp/host.log" },
    ],
    links: [],
    supportEmail: "support@traycer.ai",
    privateDeliveryAvailable: true,
  };
}

export function makeSupportBridge(overrides: {
  readonly getSnapshot?: DesktopSupportBridge["getSnapshot"];
  readonly tailLog?: DesktopSupportBridge["tailLog"];
  readonly revealLog?: DesktopSupportBridge["revealLog"];
}): DesktopSupportBridge {
  return {
    getSnapshot:
      overrides.getSnapshot ?? (() => Promise.resolve(readySupportSnapshot())),
    revealLog:
      overrides.revealLog ??
      ((target) => Promise.resolve({ target, path: `/tmp/${target}.log` })),
    submitReport: vi.fn(() =>
      Promise.resolve({
        status: "delivered" as const,
        reportId: "report-1",
      }),
    ),
    tailLog:
      overrides.tailLog ??
      ((input) =>
        Promise.resolve<DesktopSupportLogTailResult>({
          target: input.target,
          path: `/tmp/${input.target}.log`,
          lines: [`line-one-${input.target}`, `line-two-${input.target}`],
          truncated: false,
        })),
    freezeEvidence: () => Promise.resolve({ reportId: "report-1" }),
    discardFrozenEvidence: () => Promise.resolve(),
    readFrozenLogTail: (input) =>
      Promise.resolve<DesktopSupportLogTailResult>({
        target: input.target,
        path: `/tmp/${input.target}.log`,
        lines: [],
        truncated: false,
      }),
    saveDiagnosticBundle: () => Promise.resolve({ path: "/tmp/bundle.json" }),
    getFingerprintOccurrence: () => Promise.resolve(null),
    buildPublicDraft: () =>
      Promise.resolve({
        template: "bug_report.yml",
        title: "",
        fields: {
          "what-happened": "",
          version: "",
          os: "",
          component: "",
          repro: "",
        },
        truncated: false,
      }),
  };
}

export function makeHost(support: DesktopSupportBridge | null): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    hostManagement: null,
    hostTray: null,
    support,
  });
}

export async function openLogLevelSelect(
  scope: LogLevelScope,
): Promise<HTMLElement> {
  const trigger = await waitFor(() => {
    const element = screen.getByTestId(`settings-log-level-${scope}`);
    if (element.hasAttribute("disabled")) {
      throw new Error(`Log level select for ${scope} still disabled`);
    }
    return element;
  });
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(trigger);
  return trigger;
}

export async function chooseLogLevelOption(label: string): Promise<void> {
  const option = await screen.findByRole("option", { name: label });
  fireEvent.pointerUp(option);
  fireEvent.click(option);
}
