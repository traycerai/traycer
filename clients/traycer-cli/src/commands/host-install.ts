import {
  commitHostInstallSource,
  currentInstallPlatform,
  discardStagedHostInstallSource,
  stageHostInstallSource,
  type InstallSourceArg,
} from "../installer";
import { runDeviceAuthFlow } from "../auth/login-flow";
import { assertHostNotBusy } from "../host/busy-check";
import {
  provisionInstalledHostCredential,
  type HostCredentialProvisionOutcome,
} from "../host/credential-provisioning";
import { resolveHostAuth, type HostAuth } from "../internal/host-auth";
import { errorFromUnknown } from "../logger";
import { CLI_ERROR_CODES, cliError, toCliError } from "../runner/errors";
import type {
  CommandContext,
  CommandFn,
  CommandResult,
} from "../runner/runner";
import {
  createServiceController,
  formatServiceLifecycleWarning,
  serviceLabelFor,
} from "../service";
import {
  createBytesOnlyInstallLifecycle,
  createServiceInstallLifecycle,
  type ServiceInstallLifecycleHandle,
} from "../service/install-lifecycle";
import { withCliLock } from "../store/cli-lock";

// `traycer host install <version|latest>` - registry path (NP-4) /
// `--from <path>` local-file path (NP-2).
//
// Lifecycle ordering (Tech Plan, Decision 3): stage + verify + extract
// happen before we touch the OS service. Only once the new bytes are
// proven good do we stop the running host, swap the install dir, and
// start/restart the service. If the post-swap start fails the new
// host stays installed (no rollback) - Doctor surfaces the
// non-readiness to the operator.
//
// `cli-lock` scope (Tech Plan, "Lock-scope restructure"): download,
// verify, and extract happen into an owner-tokened temp dir OUTSIDE the
// lock (`stageHostInstallSource`), so a parallel Desktop window or
// terminal can't be blocked behind a potentially-long download. Only
// the commit (reconcile -> stop -> swap -> start -> re-reconcile,
// `commitHostInstallSource`) runs inside the lock.
//
// Clean-machine bootstrap (Core Flow 1 / Flow 7): when no OS service is
// registered yet (`priorState === "not-installed"`), the lifecycle
// registers + starts the service post-swap so a single
// `traycer host install` end-to-end stands up the host without
// needing Desktop or a separate `traycer host service install` step. The
// `--allow-self-invocation` flag is forwarded to
// `resolveServiceCliInvocation` so dev / local-file installs that pre-
// date the packaged CLI (NP-3) can still register a working service.
//
// Sign-in pre-flight (client/host token split): the started host reads its
// owner from the shared credentials file, so installing while signed out
// stands up a host that denies every connection ("unprovisioned"). Before
// staging anything, a signed-out interactive run is offered the device-flow
// sign-in inline; a run that cannot prompt (JSON mode - every Desktop/Doctor
// shellout - CI, or a non-TTY stdout) warns and continues instead, and so
// does a declined or failed sign-in. Install-now-login-later stays legal
// throughout: the host picks up a later `traycer login` within one
// connection, no reinstall needed, which is why the guard never hard-fails.
// `--no-service-register` skips the pre-flight entirely - bytes-only,
// nothing is started, and the actor that later starts the service owns the
// sign-in question.
//
// Post-install credential provisioning: a signed-in install that started a
// host follows up with a short-lived stream connection carrying the CLI mint
// flow (`provisionInstalledHostCredential`), so the host comes up holding its
// own `aud: "host"` credential instead of waiting for the first minting
// client. Best-effort and deadline-bounded; failures warn.
export interface HostInstallArgs {
  // Always a concrete version token - "latest" or a semver. A local
  // file is signalled by a non-null `fromPath` and supersedes
  // `versionRequest`. The entrypoint resolves "" / null at the
  // registration site so command body callers never see ambiguity.
  readonly versionRequest: string;
  readonly fromPath: string | null;
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
  // Install the host bytes only; leave OS-service registration to the
  // host (mirrors `host ensure`'s flag) - the packaged-macOS pin path,
  // where Desktop owns registration via SMAppService. A null-runtime
  // archive simply lands as `activationUnknown` debt. Truly bytes-only:
  // no stop, no register/rewrite, no start, even when a service is
  // already registered - `createServiceInstallLifecycle`'s `bootstrap:
  // null` still rewrites and re-loads an EXISTING registration post-
  // swap, which is not what this flag promises.
  readonly noServiceRegister: boolean;
  // Hidden, internal - the CLI-owned pin gate. After acquiring the
  // lock (download/extract already done outside it), immediately
  // before the service stop, probe `assertHostNotBusy`; busy ->
  // `E_HOST_BUSY` with the extracted temp scrubbed. A pin is an
  // explicit one-shot: Defer abandons it, retry re-downloads - there
  // is no durable deferred-pin state the way there is for a staged
  // update.
  readonly ifIdle: boolean;
  // Install even when the host has work in progress: threaded into the
  // service lifecycle so the pre-swap stop skips the cooperative
  // shutdown claim and kills the host process, exactly like
  // `host stop --force`. Without it a busy host denies the claim and
  // the install aborts with `E_HOST_BUSY` - which used to have no
  // supported escape short of `host stop --force` + reinstall.
  // Mutually exclusive with `ifIdle` (one refuses on busy work, the
  // other kills it). Inert on the bytes-only path (`noServiceRegister`):
  // that path performs no stop for force to escalate.
  readonly force: boolean;
}

// Outcome of the sign-in pre-flight, surfaced verbatim as `authPreflight`
// in the result payload so NDJSON consumers can tell an authorized install
// from one whose host will boot unprovisioned. The desktop's `result.data`
// parsers are tolerant of added fields.
export type HostInstallAuthPreflight =
  | { readonly state: "signed-in"; readonly reason: null }
  | { readonly state: "signed-in-inline"; readonly reason: null }
  | {
      readonly state: "unauthenticated";
      // Deliberately NOT split into declined-vs-failed: the device flow raises
      // `AUTH_REJECTED` for a user denial, an expired device code, a rejected
      // request, AND a post-auth token rejection alike (see `login-flow.ts`),
      // so any such split would report "declined" for four different outcomes.
      // The distinguishing detail lives where it is accurate - the human
      // warning line and the structured log below both carry the flow's own
      // message.
      readonly reason: "noninteractive-cannot-prompt" | "sign-in-incomplete";
    }
  | { readonly state: "not-checked"; readonly reason: "bytes-only" };

const SIGN_IN_LATER_HINT =
  "Run `traycer login` to authorize it - no reinstall needed.";

/**
 * `resolveHostAuth` returns `null` for "not signed in", but the credentials
 * read underneath it only maps ENOENT to `null` and rethrows every other fs
 * error - an unreadable file (EACCES on a foreign-owned credentials file,
 * EISDIR, EIO) throws.
 *
 * Neither caller here can act on that. The pre-flight's whole contract is
 * warn-and-continue, and the post-install probe runs after the bytes are
 * already swapped and the service started - letting a throw escape there would
 * report a successful install as a failure. Both read credentials
 * opportunistically, so an unreadable file is "no usable auth", logged and
 * carried on from.
 */
async function resolveHostAuthOrNull(
  ctx: CommandContext,
  stage: "preflight" | "provision",
): Promise<HostAuth | null> {
  try {
    return await resolveHostAuth();
  } catch (err) {
    const error = errorFromUnknown(err);
    ctx.runtime.logger.warn(
      "Host install could not read the stored credentials; treating as signed out",
      {
        environment: ctx.runtime.environment,
        stage,
        errorName: error.name,
        errorMessage: error.message,
      },
    );
    return null;
  }
}

async function runSignInPreflight(
  ctx: CommandContext,
  args: HostInstallArgs,
): Promise<HostInstallAuthPreflight> {
  // Bytes-only installs start nothing, so there is no unauthenticated host
  // to prevent here.
  if (args.noServiceRegister) {
    return { state: "not-checked", reason: "bytes-only" };
  }
  const auth = await resolveHostAuthOrNull(ctx, "preflight");
  if (auth !== null) {
    return { state: "signed-in", reason: null };
  }
  // Prompting is only possible where a human can see the device-flow code
  // and act on it: human output mode, on a TTY, outside CI. The device-flow
  // instructions print via `humanRequired`, which is a no-op in JSON mode -
  // prompting there would silently block on a code nobody can read.
  const canPrompt =
    !ctx.runtime.nonInteractive &&
    !ctx.runtime.json &&
    process.stdout.isTTY === true;
  if (!canPrompt) {
    ctx.runtime.logger.warn(
      "Host install proceeding unauthenticated; cannot prompt for sign-in",
      {
        environment: ctx.runtime.environment,
        nonInteractive: ctx.runtime.nonInteractive,
        json: ctx.runtime.json,
      },
    );
    ctx.output.humanRequired(
      `warning: not signed in - the installed host will start unprovisioned and serve no work until you sign in. ${SIGN_IN_LATER_HINT}`,
    );
    return { state: "unauthenticated", reason: "noninteractive-cannot-prompt" };
  }
  ctx.output.humanRequired(
    "You are not signed in. The host this command installs starts unprovisioned\n" +
      "and serves no work until you sign in, so let's sign in first\n" +
      "(Ctrl+C cancels the install; a declined sign-in continues it unauthenticated).",
  );
  try {
    const login = await runDeviceAuthFlow(ctx);
    ctx.output.humanRequired(
      `Signed in as ${login.user.email || login.user.name || login.user.id}.`,
    );
    return { state: "signed-in-inline", reason: null };
  } catch (err) {
    const cliErr = toCliError(err);
    ctx.runtime.logger.warn(
      "Host install inline sign-in did not complete; continuing unauthenticated",
      {
        environment: ctx.runtime.environment,
        code: cliErr.code,
        message: cliErr.message,
      },
    );
    ctx.output.humanRequired(
      `warning: sign-in did not complete (${cliErr.message})\n` +
        `Continuing the install - the host will start unprovisioned. ${SIGN_IN_LATER_HINT}`,
    );
    return { state: "unauthenticated", reason: "sign-in-incomplete" };
  }
}

// Overall budget for the post-install provisioning probe: host boot, mint,
// and adoption verification together. Typical success is a few seconds; the
// ceiling only binds when the host never comes up - where the install has a
// bigger problem than its credential.
const CREDENTIAL_PROVISION_DEADLINE_MS = 30_000;

async function maybeProvisionCredential(
  ctx: CommandContext,
  postSwapAction: "start" | "install" | "none",
  authPreflight: HostInstallAuthPreflight,
): Promise<HostCredentialProvisionOutcome | null> {
  const signedIn =
    authPreflight.state === "signed-in" ||
    authPreflight.state === "signed-in-inline";
  // Deliberately NOT gated on `--json`. That flag means "emit NDJSON for
  // automation" (README, "Scripting"), and a headless provisioning script is
  // the caller that most needs its host credentialed - it is the one with no
  // GUI arriving later to mint. The gate used to exist to keep this probe from
  // racing a Desktop shellout's own mint; that race is now handled where it
  // belongs, in the probe (a superseded mint verifies rather than failing), so
  // gating on output format only denied automation the credential.
  //
  // Safe for Desktop's shellouts too: its stream runner bounds on an IDLE
  // timeout of 10 minutes, not a total one, so a probe bounded at 30s cannot
  // trip it, and `parseInstallResult` reads named fields only.
  if (postSwapAction === "none" || !signedIn) {
    return null;
  }
  // Re-read rather than reusing the pre-flight's read: an inline sign-in
  // rewrote the credentials file after it.
  const auth = await resolveHostAuthOrNull(ctx, "provision");
  if (auth === null) {
    return null;
  }
  const progress = (message: string): void => {
    ctx.progress({
      stage: "host-credential",
      message,
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
  };
  progress("authorizing the installed host (waiting for it to come up)...");
  const outcome = await provisionInstalledHostCredential({
    environment: ctx.runtime.environment,
    auth,
    deadlineMs: CREDENTIAL_PROVISION_DEADLINE_MS,
    progress,
    logger: ctx.runtime.logger,
  });
  ctx.runtime.logger.info("Host install credential provisioning settled", {
    environment: ctx.runtime.environment,
    outcome: outcome.kind,
  });
  return outcome;
}

// Terminal-line rendering of the provisioning outcome. `null` (not attempted)
// and "already credentialed" stay quiet; a fresh mint is confirmed; every
// failure is a warning that names the self-heal, because none of them makes
// the install itself less successful.
function formatCredentialProvisionNote(
  outcome: HostCredentialProvisionOutcome | null,
): string | null {
  if (outcome === null) {
    return null;
  }
  const selfHeal = "it will be provisioned when a Traycer client next connects";
  switch (outcome.kind) {
    case "active":
      return outcome.minted ? "host credential provisioned" : null;
    case "unreachable":
      return `host credential not provisioned (the host did not come up in time) - ${selfHeal}`;
    case "unsupported":
      return "host credential not provisioned (this host version does not support delegated credentials)";
    case "mint-unavailable":
      return `host credential not provisioned (the credential handoff did not complete) - ${selfHeal}`;
    case "not-adopted":
      return `host credential not provisioned (the host did not adopt it in time) - ${selfHeal}`;
    case "error":
      return `host credential not provisioned (${outcome.message}) - ${selfHeal}`;
  }
}

export function buildHostInstallCommand(args: HostInstallArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    if (args.noServiceRegister && currentInstallPlatform() === "win32") {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "host install: --no-service-register is not supported on Windows",
        details: { environment: ctx.runtime.environment },
        exitCode: 1,
      });
    }
    if (args.force && args.ifIdle) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "host install: --force and --if-idle are mutually exclusive; one refuses to disturb in-flight work, the other kills it",
        details: { environment: ctx.runtime.environment },
        exitCode: 1,
      });
    }
    ctx.runtime.logger.info("Host install command started", {
      environment: ctx.runtime.environment,
      sourceKind: args.fromPath !== null ? "local-file" : "registry",
      versionRequest:
        args.fromPath !== null ? "local-file" : args.versionRequest,
      enableLinger: args.enableLinger,
      allowSelfInvocation: args.allowSelfInvocation,
      noServiceRegister: args.noServiceRegister,
      ifIdle: args.ifIdle,
      force: args.force,
    });
    const authPreflight = await runSignInPreflight(ctx, args);
    ctx.runtime.logger.info("Host install sign-in pre-flight resolved", {
      environment: ctx.runtime.environment,
      state: authPreflight.state,
      reason: authPreflight.reason,
    });
    const source: InstallSourceArg =
      args.fromPath !== null
        ? { kind: "local-file", path: args.fromPath }
        : {
            kind: "registry",
            versionRequest: args.versionRequest,
          };

    const staged = await stageHostInstallSource({
      environment: ctx.runtime.environment,
      source,
      onProgress: (info) => ctx.progress(info),
      // `host install` records the registry version or the derived
      // local-file version - it is not stamping this build's identity.
      recordVersionOverride: null,
    });

    // `--no-service-register` must be truly bytes-only: no stop, no
    // register/rewrite, no start - even when a service is already
    // registered. `createServiceInstallLifecycle`'s `bootstrap: null`
    // does not satisfy that (it still rewrites and re-loads an EXISTING
    // registration post-swap), so this skips the service lifecycle
    // entirely and uses the same bytes-only shape `host ensure` uses
    // for `registerService: false`.
    const handle: ServiceInstallLifecycleHandle | null = args.noServiceRegister
      ? null
      : createServiceInstallLifecycle({
          environment: ctx.runtime.environment,
          bootstrap: {
            enableLinger: args.enableLinger,
            allowSelfInvocation: args.allowSelfInvocation,
          },
          force: args.force,
        });
    const lifecycle =
      handle !== null
        ? handle.lifecycle
        : createBytesOnlyInstallLifecycle(
            createServiceController(),
            serviceLabelFor(ctx.runtime.environment),
          );
    ctx.runtime.logger.debug("Host install command lifecycle created", {
      environment: ctx.runtime.environment,
      bytesOnly: handle === null,
    });

    let result;
    try {
      result = await withCliLock(
        {
          environment: ctx.runtime.environment,
          reason: "host-install",
          waitMs: 30_000,
          pollIntervalMs: 100,
        },
        async () => {
          if (args.ifIdle) {
            await assertHostNotBusy(ctx.runtime.environment);
          }
          return commitHostInstallSource({
            environment: ctx.runtime.environment,
            staged,
            onProgress: (info) => ctx.progress(info),
            lifecycle,
          });
        },
      );
    } catch (err) {
      // Any failure that prevented `commitHostInstallSource` from ever
      // running (the busy probe, a cli-lock timeout) leaves the
      // extracted temp orphaned - scrub it (a no-op if
      // `commitHostInstallSource` already cleaned up itself before
      // this error reached us).
      await discardStagedHostInstallSource(ctx.runtime.environment, staged);
      throw err;
    }

    ctx.runtime.logger.info("Host install command completed", {
      environment: ctx.runtime.environment,
      version: result.record.version,
      previousVersion: result.previous?.version ?? null,
      postSwapAction: handle !== null ? handle.state.postSwapAction : "none",
      hasPostSwapError: handle !== null && handle.state.postSwapError !== null,
    });

    // Post-install credential provisioning: leave the just-started host
    // holding its own `aud: "host"` credential rather than waiting for the
    // first minting client to happen to connect. Only where it can help:
    //   - the service lifecycle actually started/restarted a host
    //     (`postSwapAction`), cleanly - a host that failed its post-swap
    //     start has nothing to dial;
    //   - the pre-flight left us signed in (the mint spends the bearer);
    //   - not in JSON mode: every Desktop/Doctor shellout is JSON, and there
    //     the GUI connects immediately after with its own mint flow - a
    //     second minting connection would only race it.
    // Best-effort throughout: any failure is a warning, never a failed
    // install - an unprovisioned host self-heals on the next minting client.
    const credentialProvision = await maybeProvisionCredential(
      ctx,
      handle !== null && handle.state.postSwapError === null
        ? handle.state.postSwapAction
        : "none",
      authPreflight,
    );
    const lifecycleData =
      handle !== null
        ? {
            priorServiceState: handle.state.priorState,
            stoppedBeforeSwap: handle.state.stoppedBeforeSwap,
            postSwapAction: handle.state.postSwapAction,
            postSwapError: handle.state.postSwapError,
          }
        : null;
    let human = `installed host ${result.record.version} (executable=${result.record.executablePath})`;
    if (handle !== null && handle.state.postSwapError !== null) {
      human = `${human}; ${formatServiceLifecycleWarning(handle.state.postSwapAction, handle.state.postSwapError)}`;
    }
    // Restate the unauthenticated warning on the terminal line - the
    // pre-flight's copy printed before a potentially long download and
    // may have scrolled away.
    if (authPreflight.state === "unauthenticated") {
      human = `${human}; not signed in - the host is unprovisioned until you run \`traycer login\``;
    }
    const provisionNote = formatCredentialProvisionNote(credentialProvision);
    if (provisionNote !== null) {
      human = `${human}; ${provisionNote}`;
    }
    return {
      data: {
        version: result.record.version,
        runtimeVersion: result.record.runtimeVersion,
        installedAt: result.record.installedAt,
        executablePath: result.record.executablePath,
        source: result.record.source,
        archiveSha256: result.record.archiveSha256,
        signatureKeyId: result.record.signatureKeyId,
        sizeBytes: result.record.sizeBytes,
        previousVersion: result.previous?.version ?? null,
        serviceLifecycle: lifecycleData,
        installGeneration: result.installGeneration,
        authPreflight,
        credentialProvision,
      },
      human,
      exitCode: 0,
    };
  };
}
