import type { CommandFn, CommandResult } from "../runner/runner";
import {
  createServiceController,
  resolveServiceCliInvocation,
  serviceLabelFor,
  serviceManifestPath,
  windowsTaskName,
  type DesktopRegistrationTakeover,
} from "../service";
import { withCliLock } from "../store/cli-lock";
import { attestInstallRuntime } from "../host/attested-install-runtime";
import {
  formatCredentialProvisionNote,
  maybeProvisionCredential,
  runSignInPreflight,
} from "../host/install-auth";

// `traycer host service install [--no-linger] [--takeover]` - register the
// OS service for the current environment. `--no-linger` skips `loginctl
// enable-linger` on Linux. `--takeover` (macOS) moves host management from
// the Traycer Desktop app to the CLI: the Desktop-managed host is stopped
// cooperatively, its agent registration booted out, and the CLI-owned
// service registered in its place.
//
// This command STARTS a host (systemd `enable --now`, launchd bootstrap), so
// it owns the same sign-in pre-flight and post-start credential provisioning
// as `host install` - it is the deferred half of the documented
// `host install --no-service-register` split flow, whose bytes-only first
// half deliberately skipped both on the promise that "the actor that later
// starts the service owns the sign-in question". That actor is this command.
export interface ServiceInstallArgs {
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
  readonly takeover: boolean;
}

export function buildServiceInstallCommand(
  args: ServiceInstallArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Service install command started", {
      environment: ctx.runtime.environment,
      enableLinger: args.enableLinger,
      allowSelfInvocation: args.allowSelfInvocation,
    });
    // Before the lock: the inline device-flow sign-in can take as long as a
    // human takes, and nothing it touches (the credentials file) is guarded
    // by the CLI lock.
    const authPreflight = await runSignInPreflight(ctx, false);
    return withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "service-install",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      async () => {
        const label = serviceLabelFor(ctx.runtime.environment);
        const cli = await resolveServiceCliInvocation({
          environment: ctx.runtime.environment,
          override: null,
          allowSelfInvocation: args.allowSelfInvocation,
        });
        ctx.runtime.logger.debug("Service install CLI invocation resolved", {
          environment: ctx.runtime.environment,
          label: label.id,
          argCount: cli.args.length,
        });
        const controller = createServiceController();
        let takeover: DesktopRegistrationTakeover | null = null;
        if (args.takeover) {
          ctx.progress({
            stage: "register",
            message: `taking over host management from Traycer Desktop`,
            percent: null,
            bytes: null,
            totalBytes: null,
            workUnits: null,
          });
          takeover = await controller.takeoverDesktopRegistration(label);
          ctx.runtime.logger.info("Service install takeover step completed", {
            environment: ctx.runtime.environment,
            label: label.id,
            outcome: takeover.kind,
          });
        }
        ctx.progress({
          stage: "register",
          message: `registering service '${label.id}'`,
          percent: null,
          bytes: null,
          totalBytes: null,
          workUnits: null,
        });
        await controller.install({
          label,
          cli,
          enableLinger: args.enableLinger,
        });
        const platform = process.platform;
        const manifestPath =
          platform === "win32"
            ? windowsTaskName(label)
            : serviceManifestPath(label);
        ctx.runtime.logger.info("Service install command completed", {
          environment: ctx.runtime.environment,
          label: label.id,
          platform,
          enableLinger: args.enableLinger,
        });
        // The registration above started the host, so this command owns the
        // credential handoff too - "install" mirrors host-install's
        // register+start path. Best-effort: failures are notes, never a
        // failed registration.
        const credentialProvision = await maybeProvisionCredential(
          ctx,
          "install",
          authPreflight,
        );
        let human =
          takeover !== null && takeover.kind === "took-over"
            ? `service '${label.id}' registered (environment=${label.environment}); host management taken over from Traycer Desktop (agent '${takeover.agentLabelId}' deregistered, host ${takeover.cooperativeStop === "stopped" ? "stopped cooperatively" : takeover.cooperativeStop === "no-host" ? "was not running" : "was unreachable and booted out"})`
            : `service '${label.id}' registered (environment=${label.environment})`;
        // Restate the unauthenticated warning on the terminal line - the
        // pre-flight's copy printed before the registration output and may
        // have scrolled away.
        if (authPreflight.state === "unauthenticated") {
          human = `${human}; not signed in - the host is unprovisioned until you run \`traycer login\``;
        }
        const provisionNote =
          formatCredentialProvisionNote(credentialProvision);
        if (provisionNote !== null) {
          human = `${human}; ${provisionNote}`;
        }
        return {
          data: {
            label: label.id,
            displayName: label.displayName,
            environment: label.environment,
            manifestPath,
            cli: { command: cli.command, args: cli.args },
            ...(takeover === null ? {} : { takeover }),
            ...(await attestInstallRuntime(ctx.runtime.environment)),
            authPreflight,
            credentialProvision,
          },
          human,
          exitCode: 0,
        };
      },
    );
  };
}
