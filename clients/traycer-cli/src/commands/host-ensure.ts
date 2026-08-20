import { ensureHost, type HostEnsureResult } from "../host/ensure";
import type { CommandFn, CommandResult } from "../runner/runner";
import { formatServiceLifecycleWarning } from "../service";
import {
  formatCredentialProvisionNote,
  maybeProvisionCredential,
  runSignInPreflight,
  type HostInstallAuthPreflight,
} from "../host/install-auth";
import type { HostCredentialProvisionOutcome } from "../host/credential-provisioning";

// `traycer host ensure [--release <v> | --from <path>]` - idempotent
// "make the host installed + registered + running" command. This is
// the single host-lifecycle call the desktop shell makes after the
// user signs in; the desktop never registers services or calls launchctl
// itself. See host/ensure.ts for the source-resolution order and the
// state machine.
export interface HostEnsureArgs {
  readonly versionRequest: string | null;
  readonly fromPath: string | null;
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
  // Install the host bytes only; leave OS-service registration to the
  // host. The desktop passes this because it registers the macOS login
  // item via SMAppService (only the .app can attribute the row).
  readonly noServiceRegister: boolean;
  // Skip the busy check and restart a running host unconditionally
  // (desktop "Force restart" path). Surfaced as `--force`.
  readonly force: boolean;
}

export function buildHostEnsureCommand(args: HostEnsureArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    // This command can install + register + START a host (three of its four
    // actions), so it owns the same sign-in pre-flight and post-start
    // credential provisioning as `host install` and `host service install` -
    // see install-auth.ts for the start-capable command inventory.
    //
    // Unlike those two, ensure is idempotent and its FOURTH action is a
    // no-op, so the pre-flight cannot run unconditionally: the desktop calls
    // ensure on every launch, and a signed-out operator whose host is
    // already healthy would be prompted to sign in for a command that then
    // does nothing. `beforeMutate` fires only once provisionHost has
    // committed to installing/registering/starting - still outside the
    // cli-lock and ahead of the staging download, so the inline sign-in
    // neither extends the lock's critical section nor waits out a transfer.
    //
    // A no-op therefore leaves this at `not-checked`, which is the honest
    // report: we never looked, so we make no claim either way about a host
    // this run did not touch. Bytes-only mirrors host-install -
    // `--no-service-register` starts nothing itself.
    let authPreflight: HostInstallAuthPreflight = {
      state: "not-checked",
      reason: "nothing-to-start",
    };
    const result = await ensureHost({
      runtime: ctx.runtime,
      versionRequest: args.versionRequest,
      fromPath: args.fromPath,
      enableLinger: args.enableLinger,
      allowSelfInvocation: args.allowSelfInvocation,
      noServiceRegister: args.noServiceRegister,
      force: args.force,
      onProgress: (info) => ctx.progress(info),
      beforeMutate: async () => {
        authPreflight = await runSignInPreflight(ctx, args.noServiceRegister);
      },
    });
    // After ensureHost returns - and with it the cli-lock it took - exactly
    // like host-install's post-lock probe. `serviceLifecycle` is non-null on
    // every branch that started or cycled the service, so the two `"none"`
    // cases below are both deliberate:
    //   - `serviceLifecycle === null` is the noop branch: already installed,
    //     registered AND running, so this command started nothing (and, per
    //     `beforeMutate` above, never even ran the pre-flight). The host
    //     keeps whatever provisioning state the command that installed it
    //     left behind. Probing a host we did not start would re-run the mint
    //     on every idempotent desktop call; an already-unprovisioned one
    //     self-heals on the next minting client, the same argument that
    //     keeps `host restart` unwired (install-auth.ts).
    //   - `postSwapError !== null` means the post-swap start itself failed -
    //     there is nothing listening to dial.
    // Read off the result rather than `serviceLifecycle.postSwapError`: both
    // carry the same value on every branch provision.ts constructs, and the
    // top-level field is what this file's human line already reads.
    const credentialProvision = await maybeProvisionCredential(
      ctx,
      result.serviceLifecycle !== null && result.postSwapError === null
        ? result.serviceLifecycle.postSwapAction
        : "none",
      authPreflight,
    );
    return {
      data: {
        installed: result.installed,
        registered: result.registered,
        running: result.running,
        version: result.version,
        runtimeVersion: result.runtimeVersion,
        action: result.action,
        serviceLifecycle: result.serviceLifecycle,
        postSwapError: result.postSwapError,
        installGeneration: result.installGeneration,
        authPreflight,
        credentialProvision,
      },
      human: buildHuman(result, authPreflight, credentialProvision),
      exitCode: 0,
    };
  };
}

function buildHuman(
  result: HostEnsureResult,
  authPreflight: HostInstallAuthPreflight,
  credentialProvision: HostCredentialProvisionOutcome | null,
): string {
  let base = describeAction(result);
  if (result.postSwapError !== null && result.serviceLifecycle !== null) {
    base = `${base}; ${formatServiceLifecycleWarning(result.serviceLifecycle.postSwapAction, result.postSwapError)}`;
  }
  // Restate the unauthenticated warning on the terminal line - the
  // pre-flight's copy printed before a potentially long download and may
  // have scrolled away.
  if (authPreflight.state === "unauthenticated") {
    base = `${base}; not signed in - the host is unprovisioned until you run \`traycer login\``;
  }
  const provisionNote = formatCredentialProvisionNote(credentialProvision);
  if (provisionNote !== null) {
    base = `${base}; ${provisionNote}`;
  }
  return base;
}

function describeAction(result: HostEnsureResult): string {
  // Prefer the archive's own build stamp: `version` is the caller's
  // idempotency identity and can lag the installed bytes when an older CLI
  // installs a newer archive (the echo then names a build that isn't the
  // one that just started).
  const version = result.runtimeVersion ?? result.version ?? "unknown";
  switch (result.action) {
    case "noop":
      return `host already ready (version=${version})`;
    case "installed":
      return `installed and started host ${version}`;
    case "service-registered":
      return `registered and started the OS service for installed host ${version}`;
    case "started":
      return `started the registered host service (version=${version})`;
  }
}
