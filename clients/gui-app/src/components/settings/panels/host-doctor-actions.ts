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
  /**
   * The local host these fixes are for. Only the log read consults it today —
   * the lifecycle repairs that need fencing take `runDoctorRepairIfIdle`
   * instead — but it is threaded here rather than at that one call so a fix
   * added to this switch cannot reach the bridge without one.
   */
  expectedHostId: string,
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
      await management.getHostLogs({ tailLines: 200, expectedHostId });
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
 *     local or remote, which is the whole point — EXCEPT on a host that
 *     negotiated `host.restart` away (see `rpcRestartSupported`), where the
 *     mechanism that can actually do it is the local bridge's respawn.
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
  /**
   * Whether `host.restart` is actually servable for this host — the
   * capability alone, `false` for ANY host whose handshake refused it. A
   * remote host can refuse it too, so this must never be derived from
   * whether a fallback route was selected: the inverse of "the bridge stands
   * in" reads as "the RPC works" exactly where neither is true.
   */
  readonly rpcRestartSupported: boolean;
  /**
   * Whether a refused `host.restart` has the page's bridge respawn to stand
   * in — the page's own derived fact (`restartViaForceFallback`), NOT
   * re-derived here from `isLocalMachine && hasLocalBridge`: the force route
   * also requires a runner bridge, and a torn pair would route a restart fix
   * to a confirm whose dispatch leg then sends the RPC the handshake
   * refused.
   */
  readonly bridgeRestartRoute: boolean;
}): DoctorFixRoute {
  if (input.fixAction === "host-restart" || input.fixAction === "host-start") {
    if (input.rpcRestartSupported) return "rpc";
    // Same precedence as below: the bridge when it can genuinely stand in,
    // otherwise the command to run on the box itself.
    return input.bridgeRestartRoute ? "local-bridge" : "copy-command";
  }
  if (input.fixAction === "host-logs") return "rpc";
  return input.isLocalMachine && input.hasLocalBridge
    ? "local-bridge"
    : "copy-command";
}

/**
 * Whether an OPEN "Free port and restart?" confirmation has gone stale.
 *
 * The same window the restart confirm and the OS-service confirms already
 * close for (`host-overview-panel.tsx`, `host-overview-advanced.tsx`): opened
 * while idle, the dialog stays answerable while an install, a service change
 * or a restart arms the page-wide lifecycle gate underneath it. Gating the
 * issue card's BUTTON cannot reach a dialog that is already up, and
 * `freePortAndRestart` queues rather than refusing — so a confirm landing
 * there kills the recorded process and forces a restart immediately after the
 * competing write.
 *
 * Stale for every arming EXCEPT this repair's own dispatch, which has to keep
 * the dialog (and its spinner) up until it settles.
 */
export function freePortConfirmWentStale(input: {
  /**
   * The open dialog's issue, or `null` when no dialog is open. Structural on
   * `code` alone so the two `HostDoctorIssue` declarations (protocol and
   * bridge) both satisfy it without this module picking one.
   */
  readonly issue: { readonly code: string } | null;
  readonly lifecycleArmed: boolean;
  readonly ownDispatchCode: string | null;
}): boolean {
  if (input.issue === null) return false;
  if (!input.lifecycleArmed) return false;
  return input.ownDispatchCode !== input.issue.code;
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
