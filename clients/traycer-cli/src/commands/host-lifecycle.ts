import {
  HOST_LIFECYCLE_MODES,
  refreshOnModeChange,
  type HostLifecycleMode,
  type HostLifecyclePolicy,
} from "@traycer/protocol/config/host-lifecycle-policy";
import {
  lifecycleSnapshotRows,
  readHostLifecycleSnapshot,
  type HostLifecycleSnapshot,
} from "../host/lifecycle-snapshot";
import {
  effectiveModeOf,
  readHostLifecyclePolicy,
  writeHostLifecyclePolicyFromCli,
} from "../host/lifecycle-files";
import {
  publishedHostProcessGone,
  readHostPidMetadata,
} from "../host/pid-metadata";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { SERVICE_REFRESH_COMMAND } from "../service/service-definition";
import {
  describeServiceDefinitionRefresh,
  type ServiceDefinitionRefreshOutcome,
} from "./service-refresh";

// `traycer host lifecycle get | set <mode>` - the CLI half of the host
// lifecycle setting (lifecycle mechanics, D7). Traycer Desktop's Settings card
// writes the same `lifecycle-policy.json`; the CLI supervisor is the only
// thing that enforces it.
//
// `set` only WRITES. It never stops, starts or restarts anything: the running
// host keeps running under whatever supervisor it has, and the mode governs
// the next unattended start (and, for a desktop-owned run, what the
// supervisor does when that desktop goes away). `set none` in particular
// stops nothing - the desktop observes the change and applies it at its next
// launch, without replaying a stop this command promised not to make.
//
// The one other write is the service DEFINITION, and only on a transition
// into a mode that parks (`refreshOnModeChange`): a definition that predates
// labelled starts launches the host unlabelled, which no mode can park, so
// it is brought to the current launcher form in place - `host service
// refresh`, the same definition-only write, starting and stopping nothing.

/** `host lifecycle get`: the policy, presence, owner and supervisor capability. */
export const hostLifecycleGetCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const view = await readLifecycleView(ctx.runtime.environment);
  return {
    data: view,
    human: lifecycleSnapshotRows(view.lifecycle)
      .map(([label, value]) => `${label}: ${value}`)
      .join("\n"),
    exitCode: 0,
  };
};

export interface HostLifecycleSetArgs {
  /** The positional `<mode>` exactly as typed; validated in the command. */
  readonly mode: string | undefined;
  /**
   * `host service refresh`'s mutation (`refreshServiceDefinitionUnderContender`
   * in production), run when the write is a transition into a parking mode.
   */
  readonly refreshServiceDefinition: (
    environment: Environment,
  ) => Promise<ServiceDefinitionRefreshOutcome>;
}

/**
 * `host lifecycle set <mode>`: write the policy with `updatedBy: "cli"`, one
 * `rev` past what is on disk, atomically.
 */
export function buildHostLifecycleSetCommand(
  args: HostLifecycleSetArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    // Inside the CommandFn so a bad mode renders as the runner's error
    // envelope, not a raw throw out of Commander's action.
    const mode = parseModeArgument(args.mode);
    const previousMode = effectiveModeOf(
      await readHostLifecyclePolicy(ctx.runtime.environment),
    );
    const policy = await writeHostLifecyclePolicyFromCli(
      ctx.runtime.environment,
      mode,
      new Date(),
    );
    ctx.runtime.logger.info("Host lifecycle policy written", {
      environment: ctx.runtime.environment,
      mode: policy.mode,
      rev: policy.rev,
    });
    let refresh: ServiceDefinitionRefreshOutcome | null = null;
    if (refreshOnModeChange(previousMode, policy.mode)) {
      try {
        refresh = await args.refreshServiceDefinition(ctx.runtime.environment);
      } catch (cause) {
        throw refreshFailedAfterWrite(policy, cause);
      }
      ctx.runtime.logger.info("Host service definition refreshed for mode", {
        environment: ctx.runtime.environment,
        mode: policy.mode,
        result: refresh.result.kind,
      });
    }
    const view = await readLifecycleView(ctx.runtime.environment);
    return {
      data: {
        policy,
        ...view,
        serviceDefinition: refresh === null ? null : refresh.result,
      },
      human: [
        `host lifecycle mode set to '${policy.mode}' (rev ${policy.rev})`,
        ...setNotes(policy.mode, view),
        ...(refresh === null
          ? []
          : [describeServiceDefinitionRefresh(refresh)]),
      ].join("\n"),
      exitCode: 0,
    };
  };
}

/**
 * The policy IS written - the mode is in force for every labelled start -
 * but the service definition still launches the host in a form the mode
 * cannot park, so the command must not exit 0. The cause's own message is
 * carried whole: it already names what was left and the repair.
 */
function refreshFailedAfterWrite(
  policy: HostLifecyclePolicy,
  cause: unknown,
): CliError {
  const why = cause instanceof Error ? cause.message : String(cause);
  return cliError({
    code: CLI_ERROR_CODES.SERVICE_DEFINITION_REFRESH_FAILED,
    message: `host lifecycle mode set to '${policy.mode}' (rev ${policy.rev}), but the registered host service could not be brought to the current launcher, so a login start may run the host in a form this mode cannot park: ${why}. Retry with '${SERVICE_REFRESH_COMMAND}'.`,
    details: {
      mode: policy.mode,
      rev: policy.rev,
      cause: cause instanceof CliError ? cause.code : null,
    },
    exitCode: 1,
  });
}

function parseModeArgument(value: string | undefined): HostLifecycleMode {
  const mode = HOST_LIFECYCLE_MODES.find((candidate) => candidate === value);
  if (mode !== undefined) return mode;
  throw cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message: `host lifecycle set: <mode> must be one of ${HOST_LIFECYCLE_MODES.join(", ")}`,
    details: { allowed: HOST_LIFECYCLE_MODES },
    exitCode: 1,
  });
}

interface LifecycleView {
  /** Whether a host process is serving right now (pid.json liveness). */
  readonly hostRunning: boolean;
  readonly lifecycle: HostLifecycleSnapshot;
}

async function readLifecycleView(
  environment: Environment,
): Promise<LifecycleView> {
  const pidMetadata = await readHostPidMetadata(environment);
  const hostRunning =
    pidMetadata !== null && !publishedHostProcessGone(pidMetadata);
  return {
    hostRunning,
    lifecycle: await readHostLifecycleSnapshot(environment, hostRunning),
  };
}

function setNotes(mode: HostLifecycleMode, view: LifecycleView): string[] {
  const notes: string[] = [];
  notes.push(
    mode === "none"
      ? "Nothing was stopped: a running host keeps running. From now on this machine's unattended host starts are parked, and Traycer Desktop runs without a local host from its next launch."
      : "Nothing was started or stopped: the mode applies to the next unattended host start and to how the host follows Traycer Desktop.",
  );
  if (
    mode !== "background" &&
    view.hostRunning &&
    !view.lifecycle.supervisor.enforcesLifecyclePolicy
  ) {
    notes.push(
      "The running host supervisor does not enforce lifecycle modes yet; restart the host to apply: traycer host restart",
    );
  }
  return notes;
}
