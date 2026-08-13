import { toast } from "sonner";
import type {
  HostDoctorIssue,
  FreePortAndRestartInput,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

export function copyTerminalCommand(command: string): void {
  void navigator.clipboard.writeText(command).then(
    () => {
      toast.success("Command copied to clipboard");
    },
    () => {
      reportableErrorToast("Could not copy command", undefined, {
        title: "Could not copy command",
        message: null,
        code: null,
        source: "Host Doctor",
      });
    },
  );
}

export function describeFreePortPrompt(
  prompt: FreePortAndRestartInput | null,
): string {
  if (prompt === null) {
    return "The conflicting process will be asked to exit before the host is restarted.";
  }
  const processName = prompt.processName ?? "(unknown)";
  const pidLabel = prompt.pid !== null ? ` (pid ${prompt.pid})` : "";
  return `Port ${prompt.port} is held by ${processName}${pidLabel}. The process will be asked to exit before the host is restarted, which will end any running terminal sessions and cancel in-flight requests.`;
}

export function fixActionLabel(fixAction: string): string {
  switch (fixAction) {
    case "host-install-latest":
      return "Install host";
    case "service-install":
      return "Register service";
    case "host-start":
      return "Start host";
    case "host-restart":
      return "Restart host";
    case "host-logs":
      return "Show logs";
    case "host-free-port-and-restart":
      return "Free port + restart";
    default:
      return "Fix";
  }
}

// `declined` mirrors `HostRestartRequestResult`: the restart fix resolved
// without restarting because the host deliberately refused (busy with
// in-progress work, removed-by-user, lock contention). The card must not
// announce "Fix applied" for it - and must not route it through the
// reportable error toast either, since the condition clears on its own.
export type FixActionResult =
  | { readonly kind: "applied" }
  | { readonly kind: "declined"; readonly message: string };

export async function runFixAction(
  management: IHostManagement,
  issue: HostDoctorIssue,
): Promise<FixActionResult> {
  switch (issue.fixAction) {
    case "host-install-latest": {
      // No "install latest" intent survives the two-lane cutover - the
      // idempotent-converge intent (`convergeReady`) subsumes it: it
      // installs/registers/starts the host when reachable, which is exactly
      // what this Doctor issue means.
      const outcome = await management.convergeReady(false);
      if (outcome.kind !== "ok") {
        throw new Error(outcome.message);
      }
      return { kind: "applied" };
    }
    case "service-install": {
      const outcome = await management.registerService();
      if (outcome.kind !== "ok") {
        throw new Error(outcome.message);
      }
      return { kind: "applied" };
    }
    case "host-start":
    case "host-restart": {
      const result = await management.restartHost();
      if (result.kind === "declined") {
        return { kind: "declined", message: result.message };
      }
      return { kind: "applied" };
    }
    case "host-logs":
      await management.getHostLogs({ tailLines: 200 });
      return { kind: "applied" };
    case "host-free-port-and-restart": {
      const input = parseFreePortInput(issue);
      if (input === null) {
        throw new Error("Doctor issue is missing a valid conflicting port.");
      }
      await management.freePortAndRestart(input);
      return { kind: "applied" };
    }
    default:
      throw new Error(`Unknown fix action: ${issue.fixAction}`);
  }
}

/**
 * How a doctor fix action can be carried out for the host being shown.
 *
 * The taxonomy is the doctor half of the same question the rest of the Overview
 * answers per button: not "is this local?" but "is there a mechanism that can
 * actually do this from here?".
 *
 *   - `rpc`         — `host-restart` / `host-start` route to `host.restart`, and
 *     `host-logs` to `diagnostics.logs.tail`. Both work for any reachable host,
 *     local or remote, which is the whole point.
 *   - `local-bridge` — the three repair-a-down-host actions, on THIS computer,
 *     where the CLI bridge can still run them.
 *   - `copy-command` — the same three for a host on another machine. Nothing
 *     here can reach that box's service manager or its ports, so the honest
 *     affordance is the command to run there. Not a fallback for a missing RPC:
 *     these repair a host that is typically not answering RPCs at all, which is
 *     why the plan dropped their remote verbs on purpose.
 */
export type DoctorFixRoute = "rpc" | "local-bridge" | "copy-command";

export function doctorFixRoute(input: {
  readonly fixAction: string;
  readonly isLocalMachine: boolean;
  readonly hasLocalBridge: boolean;
}): DoctorFixRoute {
  if (input.fixAction === "host-restart" || input.fixAction === "host-start") {
    return "rpc";
  }
  if (input.fixAction === "host-logs") return "rpc";
  return input.isLocalMachine && input.hasLocalBridge
    ? "local-bridge"
    : "copy-command";
}

export function parseFreePortInput(
  issue: HostDoctorIssue,
): FreePortAndRestartInput | null {
  const details = issue.details ?? {};
  const port = typeof details.port === "number" ? details.port : 0;
  if (port <= 0) return null;
  return {
    port,
    pid:
      typeof details.conflictingPid === "number"
        ? details.conflictingPid
        : null,
    processName:
      typeof details.conflictingProcess === "string"
        ? details.conflictingProcess
        : null,
  };
}

export function severityBorderClass(
  severity: HostDoctorIssue["severity"],
): string {
  if (severity === "error" || severity === "fatal") return "border-rose-700/40";
  if (severity === "warning") return "border-amber-700/40";
  return "border-border/60";
}

export function severityBadgeClass(
  severity: HostDoctorIssue["severity"],
): string {
  if (severity === "error" || severity === "fatal") return "bg-rose-500";
  if (severity === "warning") return "bg-amber-400";
  return "bg-sky-500";
}
