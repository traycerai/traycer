import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockTraycerCli } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { LogLevel } from "@traycer/protocol/config/log-level";
import type { ConfigLogLevelScope } from "@traycer/protocol/host/config/index";
import type { DiagnosticsLogTarget } from "@traycer/protocol/host/diagnostics/index";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";

/**
 * Every method the config-RPC track added, grouped the way the panels gate on
 * them ("has this host handshaked WITH the shell family" / "...the log-level
 * family" / "...the diagnostics-log family"). `recordNegotiatedHostMethods`
 * expects a flat method list per host, so tests compose these per scenario
 * instead of writing the strings out by hand each time.
 */
export const CONFIG_SHELL_METHODS = [
  "config.shell.get",
  "config.shell.set",
  "config.shell.reset",
  "config.shell.add",
  "config.shell.remove",
  "config.shell.revertArgs",
  "config.shell.listDetected",
  "config.shell.probe",
  "config.env.list",
  "config.env.set",
  "config.env.delete",
] as const;

export const CONFIG_LOG_LEVEL_METHODS = [
  "config.logLevels.get",
  "config.logLevels.set",
] as const;

export const DIAGNOSTICS_LOG_METHODS = [
  "diagnostics.logs.list",
  "diagnostics.logs.tail",
] as const;

export const ALL_CONFIG_RPC_METHODS = [
  ...CONFIG_SHELL_METHODS,
  ...CONFIG_LOG_LEVEL_METHODS,
  ...DIAGNOSTICS_LOG_METHODS,
] as const;

export interface DiagnosticsLogFixtureEntry {
  readonly target: DiagnosticsLogTarget;
  readonly label: string;
  readonly path: string;
  readonly lines: readonly string[];
}

export interface ConfigHostFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  /** Backs the shell/env handlers - same validated behaviour the bridge tests already relied on. */
  readonly cli: MockTraycerCli;
  readonly setLogLevelCalls: Array<{
    readonly scope: ConfigLogLevelScope;
    readonly level: LogLevel;
  }>;
  readonly getLogLevels: () => {
    cliLogLevel: LogLevel;
    hostLogLevel: LogLevel;
  };
  /**
   * How many times `host.status` was answered by this fixture's client -
   * `useHostCapabilityProbe`'s target, and a RELEASED-FLOOR method so even a
   * host whose config family is unsupported still answers it. Tests assert
   * this to prove the probe actually dispatched, not merely that the panel
   * changed state for some other reason.
   */
  readonly hostStatusCalls: () => number;
}

/**
 * A real `HostClient` wired to an in-memory messenger whose handlers delegate
 * to a `MockTraycerCli` for the shell/env family - mirroring how the host
 * resolver delegates to the same `@traycer/protocol/config/store` functions
 * the CLI uses, so RPC-path tests exercise the same canonicalisation
 * (family-default flags, `synthesised`, entry upserts) the bridge tests always
 * relied on instead of re-deriving it by hand.
 */
export function buildConfigHostFixture(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly cli?: MockTraycerCli;
  readonly logLevels?: { cliLogLevel: LogLevel; hostLogLevel: LogLevel };
  readonly diagnosticsLogs?: readonly DiagnosticsLogFixtureEntry[];
  /**
   * Replaces (rather than merges into) individual method handlers after the
   * defaults are built - for the rare test that needs a pending/erroring RPC
   * (e.g. a `diagnostics.logs.list` that never resolves) instead of the
   * fixture's normal in-memory behaviour.
   */
  readonly overrideHandlers?: MockHandlerMap<HostRpcRegistry>;
}): ConfigHostFixture {
  const cli = options.cli ?? new MockTraycerCli();
  let logLevels = options.logLevels ?? {
    cliLogLevel: "info" as LogLevel,
    hostLogLevel: "info" as LogLevel,
  };
  const setLogLevelCalls: Array<{
    readonly scope: ConfigLogLevelScope;
    readonly level: LogLevel;
  }> = [];
  const logs = new Map(
    (options.diagnosticsLogs ?? []).map((entry) => [
      entry.target,
      { label: entry.label, path: entry.path, lines: [...entry.lines] },
    ]),
  );
  let hostStatusCalls = 0;

  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "host.status": () => {
      hostStatusCalls += 1;
      return {
        ready: true,
        hostVersion: "1.5.0",
        protocolVersion: { major: 1, minor: 1 },
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
      };
    },
    "config.shell.get": async () => {
      const config = await cli.shellConfigGet();
      return { ...config, args: [...config.args] };
    },
    "config.shell.set": async (req) => {
      await cli.shellConfigSet(req);
      return { path: req.path, args: req.args };
    },
    "config.shell.reset": async () => {
      await cli.shellConfigReset();
      return { reset: true };
    },
    "config.shell.add": async (req) => {
      await cli.shellConfigAdd(req);
      return {
        path: req.path,
        entries: cli.shellEntries.map((entry) => ({
          path: entry.path,
          args: entry.args === null ? null : [...entry.args],
        })),
      };
    },
    "config.shell.remove": async (req) => {
      const wasAdded = cli.shellEntries.some(
        (entry) => entry.path === req.path,
      );
      await cli.shellConfigRemove(req);
      return { removed: wasAdded, path: wasAdded ? req.path : null };
    },
    "config.shell.revertArgs": async (req) => {
      const hadEntry = cli.shellEntries.some(
        (entry) => entry.path === req.path,
      );
      await cli.shellRevertArgs(req);
      return { path: req.path, reverted: hadEntry };
    },
    "config.shell.listDetected": async () => ({
      shells: [...(await cli.shellListDetected())],
    }),
    "config.shell.probe": (req) => cli.shellProbe(req),
    "config.env.list": async () => ({
      entries: [...(await cli.envOverrideList())],
    }),
    "config.env.set": async (req) => {
      await cli.envOverrideSet(req);
      return { key: req.key, value: req.value };
    },
    "config.env.delete": async (req) => {
      await cli.envOverrideDelete(req);
      return { key: req.key, deleted: true as const };
    },
    "config.logLevels.get": () => ({ ...logLevels }),
    "config.logLevels.set": (req) => {
      setLogLevelCalls.push({ scope: req.scope, level: req.level });
      logLevels =
        req.scope === "cli"
          ? { ...logLevels, cliLogLevel: req.level }
          : { ...logLevels, hostLogLevel: req.level };
      return { ...logLevels };
    },
    "diagnostics.logs.list": () => ({
      logs: [...logs.entries()].map(([target, entry]) => ({
        target,
        label: entry.label,
        path: entry.path,
      })),
    }),
    "diagnostics.logs.tail": (req) => {
      const entry = logs.get(req.target);
      if (entry === undefined) {
        return {
          status: "unavailable" as const,
          // `cli`, not `req.target`, because the WIRE TYPE says so:
          // `diagnosticsLogsTailUnavailableResponseSchema` pins this arm to
          // `z.literal("cli")`. A missing host log is reported as an
          // `available` tail with no lines - the host is running, its file
          // just has not been written yet - so `unavailable` is a CLI-only
          // outcome and echoing the request here would not type-check.
          target: "cli" as const,
          reason: "missing" as const,
        };
      }
      return {
        status: "available" as const,
        target: req.target,
        path: entry.path,
        lines: [...entry.lines],
        truncated: false,
      };
    },
  };

  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${options.hostId}`,
      handlers: { ...handlers, ...options.overrideHandlers },
    }),
  });

  const entry: HostDirectoryEntry = {
    hostId: options.hostId,
    label: options.hostId,
    kind: options.isLocalMachine ? "local" : "remote",
    websocketUrl: options.isLocalMachine
      ? "ws://127.0.0.1:0"
      : "wss://mock-remote.invalid/rpc",
    version: "1.5.0",
    transportDialability: "dialable",
  };
  client.bind(entry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );

  return {
    client,
    hostId: options.hostId,
    cli,
    setLogLevelCalls,
    getLogLevels: () => logLevels,
    hostStatusCalls: () => hostStatusCalls,
  };
}
