import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dialog } from "electron";
import { isShellExecutablePathSupported } from "@traycer/protocol/config/shell-executable";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import type { TraycerShellProbeResult } from "../../ipc-contracts/traycer-cli-types";
import { runTraycerCli, runTraycerCliJson } from "../cli/traycer-cli";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(raw: unknown, key: string, channel: string): string {
  if (!isPlainObject(raw) || typeof raw[key] !== "string") {
    throw new Error(`${channel}: missing or non-string '${key}'`);
  }
  return raw[key];
}

function requireStringOrNull(
  raw: unknown,
  key: string,
  channel: string,
): string | null {
  if (!isPlainObject(raw)) {
    throw new Error(`${channel}: missing object payload`);
  }
  const value = raw[key];
  if (typeof value === "string" || value === null) return value;
  throw new Error(`${channel}: '${key}' must be a string or null`);
}

function optionalString(raw: unknown, key: string): string | null {
  if (!isPlainObject(raw)) return null;
  const value = raw[key];
  return typeof value === "string" ? value : null;
}

/**
 * Reads a `readonly string[] | null` field off the IPC payload. Returns
 * `null` only when the field is explicitly absent or set to `null`; an empty
 * array is preserved (it's the explicit-empty-args case). Throws on a
 * malformed shape - the renderer types are strict, so anything else is a
 * bug worth surfacing instead of papering over.
 */
function optionalStringArray(
  raw: unknown,
  key: string,
  channel: string,
): readonly string[] | null {
  if (!isPlainObject(raw)) return null;
  const value = raw[key];
  if (value === null || value === undefined) return null;
  if (
    Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string")
  ) {
    return value;
  }
  throw new Error(
    `${channel}: '${key}' must be a string[] or null (got ${JSON.stringify(value)})`,
  );
}

/**
 * IPC handlers that subprocess-invoke the `traycer` CLI. The renderer
 * (via TanStack Query in the future Shell&Environment settings page,
 * and the host-failure card) reaches the on-disk SQLite + bootstrap.log
 * through these. Host-independent - works whether the host is up,
 * starting, or stuck.
 *
 * Each handler maps to a single CLI subcommand. Inputs are validated
 * here at the IPC boundary; the CLI itself re-validates (commander's
 * required-option enforcement, env-key regex, shell-args array shape).
 */
export function registerTraycerCliIpc(bridge: RunnerIpcBridge): void {
  // `host status` is now a runner-aware command (Native Packaging
  // cutover): it emits the shared NDJSON envelope and integrates Core
  // Flow 7 auto-bootstrap. Desktop always passes `--no-bootstrap` here
  // because Setup splash and Settings → Host drive the install
  // pipeline explicitly - host-status from Desktop is informational
  // only and must never implicitly install the host.
  bridge.handleInvoke(RunnerHostInvoke.traycerHostStatus, async () => {
    return runTraycerCliJson(["host", "status", "--no-bootstrap"]);
  });

  bridge.handleInvoke(RunnerHostInvoke.traycerConfigShellGet, async () => {
    // `config shell get` is now a runner-aware command (Native Packaging
    // legacy-JSON migration). The shared NDJSON envelope means we use
    // `runTraycerCliJson` here so the helper unwraps `result.data` for
    // the renderer - no more plain-JSON compatibility path on this
    // surface.
    return runTraycerCliJson(["config", "shell", "get"]);
  });

  bridge.handleInvoke(
    RunnerHostInvoke.traycerConfigShellSet,
    async (_event, raw: unknown) => {
      const path = optionalString(raw, "path");
      const args = optionalStringArray(raw, "args", "traycerConfigShellSet");
      const cliArgs = ["config", "shell", "set"];
      if (path !== null) cliArgs.push("--path", path);
      if (args !== null) {
        if (args.length === 0) {
          cliArgs.push("--clear-args");
        } else {
          // Pass shell flags as separate argv entries after `--` so any
          // leading-dash flags (e.g. "-i", "-l") aren't interpreted as
          // commander options. No shell quoting required - we're spawning
          // the CLI directly, not through a shell.
          cliArgs.push("--", ...args);
        }
      }
      await runTraycerCli({
        args: cliArgs,
        maxBuffer: 64 * 1024,
        timeoutMs: 10_000,
      });
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.traycerConfigShellReset, async () => {
    await runTraycerCli({
      args: ["config", "shell", "reset"],
      maxBuffer: 64 * 1024,
      timeoutMs: 10_000,
    });
  });

  bridge.handleInvoke(RunnerHostInvoke.traycerConfigShellList, async () => {
    // Best-effort shell enumeration for the Settings shell picker; the shared
    // NDJSON envelope means `runTraycerCliJson` unwraps `result.data` (the
    // DetectedShell[] array) for the renderer.
    return runTraycerCliJson(["config", "shell", "list"]);
  });

  bridge.handleInvoke(
    RunnerHostInvoke.traycerConfigShellAdd,
    async (_event, raw: unknown) => {
      const path = requireString(raw, "path", "traycerConfigShellAdd");
      await runTraycerCli({
        args: ["config", "shell", "add", "--path", path],
        maxBuffer: 64 * 1024,
        timeoutMs: 10_000,
      });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerConfigShellRemove,
    async (_event, raw: unknown) => {
      const path = requireString(raw, "path", "traycerConfigShellRemove");
      await runTraycerCli({
        args: ["config", "shell", "remove", "--path", path],
        maxBuffer: 64 * 1024,
        timeoutMs: 10_000,
      });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerConfigShellRevertArgs,
    async (_event, raw: unknown) => {
      const path = requireString(raw, "path", "traycerConfigShellRevertArgs");
      await runTraycerCli({
        args: ["config", "shell", "revert-args", "--path", path],
        maxBuffer: 64 * 1024,
        timeoutMs: 10_000,
      });
    },
  );

  // Native existence/executability probe for the "Add a shell" live validation.
  // Runs directly in main (fs access) so it can be debounced per keystroke
  // without paying a CLI subprocess spawn each time; mirrors the protocol's
  // `X_OK` detection check.
  bridge.handleInvoke(
    RunnerHostInvoke.traycerConfigShellProbe,
    async (_event, raw: unknown): Promise<TraycerShellProbeResult> => {
      const path = requireString(raw, "path", "traycerConfigShellProbe");
      const fileStat = await stat(path).then(
        (value) => value,
        () => null,
      );
      if (fileStat === null) {
        return { exists: false, executable: false };
      }
      if (
        !fileStat.isFile() ||
        !isShellExecutablePathSupported(path, process.platform)
      ) {
        return { exists: true, executable: false };
      }
      const executable = await access(path, fsConstants.X_OK).then(
        () => true,
        () => false,
      );
      return {
        exists: true,
        executable,
      };
    },
  );

  // Native "choose a program file" dialog for the picker's Browse affordance.
  // Returns the chosen absolute path, or null on cancel.
  bridge.handleInvoke(
    RunnerHostInvoke.traycerConfigShellPickProgramFile,
    async (): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
      });
      return result.canceled || result.filePaths.length === 0
        ? null
        : result.filePaths[0];
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.traycerConfigEnvList, async () => {
    // `config env list` is now a runner-aware command (Native Packaging
    // legacy-JSON migration). See traycerConfigShellGet above for the
    // rationale - same migration, same call shape.
    return runTraycerCliJson(["config", "env", "list"]);
  });

  bridge.handleInvoke(
    RunnerHostInvoke.traycerConfigEnvSet,
    async (_event, raw: unknown) => {
      const key = requireString(raw, "key", "traycerConfigEnvSet");
      const value = requireStringOrNull(raw, "value", "traycerConfigEnvSet");
      const args =
        value === null
          ? ["config", "env", "unset", "--key", key]
          : ["config", "env", "set", "--key", key, "--value", value];
      await runTraycerCli({
        args,
        maxBuffer: 64 * 1024,
        timeoutMs: 10_000,
      });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerConfigEnvDelete,
    async (_event, raw: unknown) => {
      const key = requireString(raw, "key", "traycerConfigEnvDelete");
      const args = ["config", "env", "delete", "--key", key];
      await runTraycerCli({
        args,
        maxBuffer: 64 * 1024,
        timeoutMs: 10_000,
      });
    },
  );

  // ─── Orchestrations ─────────────────────────────────────────────────────
  // Read-only orchestration queries via `traycer orchestration *` CLI
  // subcommands. Host-independent (local filesystem under ~/.traycer/).

  bridge.handleInvoke(RunnerHostInvoke.traycerOrchestrationList, async () => {
    return runTraycerCliJson(["orchestration", "list"]);
  });

  bridge.handleInvoke(
    RunnerHostInvoke.traycerOrchestrationShow,
    async (_event, raw: unknown) => {
      const name = requireString(raw, "name", "traycerOrchestrationShow");
      return runTraycerCliJson(["orchestration", "show", "--name", name]);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerOrchestrationRoles,
    async (_event, raw: unknown) => {
      const name = requireString(raw, "name", "traycerOrchestrationRoles");
      return runTraycerCliJson(["orchestration", "roles", "--name", name]);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerOrchestrationModels,
    async (_event, raw: unknown) => {
      const name = requireString(raw, "name", "traycerOrchestrationModels");
      const roleId = requireString(raw, "roleId", "traycerOrchestrationModels");
      const group = optionalString(raw, "group");
      const cliArgs = [
        "orchestration",
        "models",
        "--name",
        name,
        "--role",
        roleId,
      ];
      if (group !== null) cliArgs.push("--group", group);
      return runTraycerCliJson(cliArgs);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerOrchestrationResponsibility,
    async (_event, raw: unknown) => {
      const name = requireString(
        raw,
        "name",
        "traycerOrchestrationResponsibility",
      );
      const roleId = requireString(
        raw,
        "roleId",
        "traycerOrchestrationResponsibility",
      );
      return runTraycerCliJson([
        "orchestration",
        "responsibility",
        "--name",
        name,
        "--role",
        roleId,
      ]);
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.traycerOrchestrationGroups, async () => {
    return runTraycerCliJson(["orchestration", "groups"]);
  });

  bridge.handleInvoke(
    RunnerHostInvoke.traycerOrchestrationCreate,
    async (_event, raw: unknown) => {
      const name = requireString(raw, "name", "traycerOrchestrationCreate");
      const description = optionalString(raw, "description");
      const from = optionalString(raw, "from");
      const cliArgs = ["orchestration", "create", "--name", name];
      if (description !== null) cliArgs.push("--description", description);
      if (from !== null) cliArgs.push("--from", from);
      return runTraycerCliJson(cliArgs);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerOrchestrationDelete,
    async (_event, raw: unknown) => {
      const name = requireString(raw, "name", "traycerOrchestrationDelete");
      return runTraycerCliJson(["orchestration", "delete", "--name", name]);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerOrchestrationGroupShow,
    async (_event, raw: unknown) => {
      const name = requireString(raw, "name", "traycerOrchestrationGroupShow");
      return runTraycerCliJson([
        "orchestration",
        "group",
        "show",
        "--name",
        name,
      ]);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerOrchestrationGroupSave,
    async (_event, raw: unknown) => {
      const name = requireString(raw, "name", "traycerOrchestrationGroupSave");
      const group = requireString(raw, "group", "traycerOrchestrationGroupSave");
      return runTraycerCliJson([
        "orchestration",
        "group",
        "save",
        "--name",
        name,
        "--data",
        group,
      ]);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerOrchestrationGroupDelete,
    async (_event, raw: unknown) => {
      const name = requireString(raw, "name", "traycerOrchestrationGroupDelete");
      return runTraycerCliJson([
        "orchestration",
        "group",
        "delete",
        "--name",
        name,
      ]);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerOrchestrationRoleSave,
    async (_event, raw: unknown) => {
      const name = requireString(raw, "name", "traycerOrchestrationRoleSave");
      const roleJson = requireString(raw, "role", "traycerOrchestrationRoleSave");
      return runTraycerCliJson([
        "orchestration",
        "role",
        "save",
        "--name",
        name,
        "--data",
        roleJson,
      ]);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerOrchestrationRoleDelete,
    async (_event, raw: unknown) => {
      const name = requireString(raw, "name", "traycerOrchestrationRoleDelete");
      const roleId = requireString(
        raw,
        "roleId",
        "traycerOrchestrationRoleDelete",
      );
      return runTraycerCliJson([
        "orchestration",
        "role",
        "delete",
        "--name",
        name,
        "--role",
        roleId,
      ]);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerOrchestrationPrelude,
    async (_event, raw: unknown) => {
      const name = requireString(raw, "name", "traycerOrchestrationPrelude");
      const roleId = requireString(raw, "roleId", "traycerOrchestrationPrelude");
      const group = optionalString(raw, "group");
      const cliArgs = [
        "orchestration",
        "prelude",
        "--name",
        name,
        "--role",
        roleId,
      ];
      if (group !== null) cliArgs.push("--group", group);
      return runTraycerCliJson(cliArgs);
    },
  );
}
