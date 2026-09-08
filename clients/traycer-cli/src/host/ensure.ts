import type { UpdateMutationCapabilityAdoption } from "@traycer-clients/shared/host-update";
import { config } from "../config";
import { currentInstallPlatform, type InstallSourceArg } from "../installer";
import { resolveBundledHostArchive } from "../installer/bundled-host";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { ProgressInfo } from "../runner/output";
import type { RuntimeContext } from "../runner/runtime";
import {
  provisionHost,
  type HostProvisionResult,
  type HostSatisfactionPolicy,
} from "./provision";
import { defaultRegistryHostVersionRequest } from "./supported-host-version";
import { installSourceLogFields } from "./install-source-log-fields";

// `host ensure` - the desktop's post-auth provisioning call, and now the
// CLI's ONLY convergent install/register/start path. A thin source-resolving
// wrapper over the shared `provisionHost` core (host/provision.ts).
//
// It used to share that core with `maybeAutoBootstrap`, which ran the same
// pipeline implicitly off `traycer host status`. That was removed (audit
// finding CLI-001): a status read must not install software. Anything that
// wants a host to exist asks for it here, or via `host install` /
// `host service install`.
//
// ONE SEMANTIC DIFFERENCE FROM AUTO-BOOTSTRAP IS DELIBERATE, and is the point
// rather than an oversight. When bytes were already installed but the OS
// service registration was missing, auto-bootstrap forced `satisfaction:
// presence` so a registration repair could never replace the installed host.
// `ensureHost` does NOT: it derives satisfaction from the resolved source, so
// bytes that differ from this CLI's expected version are reinstalled even when
// the only visible gap was the registration - IN EVERY DIRECTION BUT ONE. A
// host whose installed version this build's comparator ranks strictly ABOVE
// the expected one is kept (`own-build-minimum`, `provision.ts`), because an
// update the user already has must not be undone by a convergence they did not
// ask for. Q7: `exact` could not express that, and the desktop requests a
// convergence whenever the local host is down OR has not been dialed - so a
// host updated out of band was reverted to the bundled build after every
// outage and every launch with a remote serving, then updated again, then
// reverted again.
//
// That asymmetry tracks implicit vs explicit. Auto-bootstrap ran off a READ,
// where swapping a user's host bytes as a side effect is indefensible;
// `ensure` is a convergence verb someone typed, and converging to the
// expected version is what it promises (Desktop's post-auth call depends on
// exactly that). Do not "restore" presence-only semantics here to match the
// deleted module - it would break that contract, and it is not what the Q7
// narrowing did: a missing, older, or unorderable install still converges, and
// `--force` still replaces bytes unconditionally, since it never takes the
// satisfied fast path. A caller that wants registration repaired WITHOUT
// touching bytes wants `host service install`, which is the narrower tool and
// still has that behaviour.
//
// Source resolution order (offline-capable, self-contained when the host
// ships beside the CLI):
//   1. explicit `--from <path>`
//   2. explicit `--release <semver>`
//   3. packaged host archive next to the CLI binary
//   4. build-stamped `config.supportedHostVersion`
//   5. registry `latest` (dev/manual fallback)

// Result shape is identical to the shared core; re-exported under the
// command-facing name.
export type HostEnsureResult = HostProvisionResult;

export interface EnsureHostOptions {
  readonly runtime: RuntimeContext;
  // null means "use the build-stamped default" after checking for a
  // packaged archive. "latest" remains an explicit registry request.
  readonly versionRequest: string | null;
  readonly fromPath: string | null;
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
  // When true, install the host bytes only and leave OS-service
  // registration to the host (the desktop's SMAppService).
  readonly noServiceRegister: boolean;
  // Skip the busy probe and restart a running host unconditionally (the
  // desktop "Force restart"). Threaded into `provisionHost`.
  readonly force: boolean;
  // Liveness-only convergence: keep ANY installed, non-yanked host whatever
  // its version, instead of converging to this build's preferred pin. The
  // desktop passes it for its BACKGROUND intent (the selection authority's
  // "host down" ensure, the launch boot ladder, a Doctor repair over a
  // deliberately held version), so an out-of-band downgrade is not silently
  // reverted by a convergence nobody asked for (the downgrade-revert RCA). An
  // explicit `--release` still wins - a named version is an exact request;
  // `--from`/the packaged archive only supply the FIRST-INSTALL source, so
  // `--keep-installed --from <archive>` keeps a viable install and bootstraps
  // from the archive only when nothing is installed.
  readonly keepInstalled: boolean;
  readonly onProgress: ((info: ProgressInfo) => void) | null;
  // Forwarded to `provisionHost`: runs only once this call has committed to
  // installing, registering or starting a host, never on the no-op fast
  // path. `host ensure` hangs its sign-in pre-flight here.
  readonly beforeMutate: (() => Promise<void>) | null;
  /** See `ProvisionHostOptions.adoption`. Forwarded verbatim. */
  readonly adoption: UpdateMutationCapabilityAdoption | undefined;
}

export async function ensureHost(
  opts: EnsureHostOptions,
): Promise<HostEnsureResult> {
  if (opts.noServiceRegister && currentInstallPlatform() === "win32") {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "host ensure: --no-service-register is not supported on Windows",
      details: { environment: opts.runtime.environment },
      exitCode: 1,
    });
  }
  opts.runtime.logger.info("Host ensure started", {
    environment: opts.runtime.environment,
    hasExplicitVersion: opts.versionRequest !== null,
    hasFromPath: opts.fromPath !== null,
    keepInstalled: opts.keepInstalled,
    enableLinger: opts.enableLinger,
    allowSelfInvocation: opts.allowSelfInvocation,
    noServiceRegister: opts.noServiceRegister,
    force: opts.force,
  });
  // Resolve the source up front (a cheap path probe - no network/download)
  // so we can key idempotency on it. Our own bundled host resolves to a
  // local-file; it shares this build's `config.version`, so we stamp that as
  // both the target and the recorded version. A rebuilt host (new stamp,
  // same channel) then differs from the install record and is reinstalled,
  // while an unchanged build - and, since Q7, a comparably NEWER install - is
  // a no-op. An explicit `--release <semver>` resolves to a registry source
  // and keeps the real semver as its target.
  const source = await resolveEnsureSource(opts);
  opts.runtime.logger.debug("Host ensure source resolved", {
    environment: opts.runtime.environment,
    ...installSourceLogFields(source),
  });
  // Both local-file shapes are "this build's host": the packaged archive AND
  // an explicit `--from`, which is what the Windows desktop passes for the
  // very same bundled archive (`resolveWindowsBundledHostArchive`). Keying the
  // Q7 narrowing on the local-file branch rather than on "no `--from`" is what
  // makes the two desktop platforms behave alike; an operator who does mean
  // "these bytes, whatever is installed" has `--force`.
  const isOwnBuild = source.kind === "local-file";
  // `--keep-installed` with no explicit `--release` selects the liveness-only
  // `viability` policy: keep whatever viable host is installed rather than
  // reinstalling this build's preferred pin over it. Deliberately NOT gated on
  // `fromPath === null` - the desktop's CLI-owned (Windows) background route
  // passes `--from <bundled archive>` as its FIRST-INSTALL source, not as an
  // explicit version pin, so gating on it would leave that route reverting the
  // very downgrade the mac route no longer touches. An explicit `--release`
  // (a named version) is the one thing that still wins, as `exact` below.
  const satisfaction: HostSatisfactionPolicy =
    opts.keepInstalled && opts.versionRequest === null
      ? { kind: "viability" }
      : isOwnBuild
        ? { kind: "own-build-minimum", version: config.version }
        : opts.versionRequest !== null &&
            source.kind === "registry" &&
            source.versionRequest !== "latest"
          ? { kind: "exact", version: source.versionRequest }
          : source.kind === "registry" && source.versionRequest !== "latest"
            ? {
                kind: "implicit-registry-minimum",
                version: source.versionRequest,
              }
            : { kind: "presence" };
  opts.runtime.logger.debug("Host ensure provisioning target computed", {
    environment: opts.runtime.environment,
    sourceKind: source.kind,
    satisfactionKind: satisfaction.kind,
    satisfactionVersion:
      satisfaction.kind === "presence" || satisfaction.kind === "viability"
        ? satisfaction.kind
        : satisfaction.version,
    recordVersionOverride: isOwnBuild ? "cli-build-version" : "none",
    registerService: !opts.noServiceRegister,
  });
  // An explicit concrete `--release X` is the one ensure path that is a
  // deliberate version selection (the `exact` policy) and can therefore be a
  // deliberate DOWNGRADE - so its committed install records a hold, decided
  // inside `provisionHost` UNDER the CLI lock on the actual committed records.
  // Derived from the effective explicit target, NOT from `keepInstalled`:
  // `--keep-installed --release <older>` still selects `exact` above and
  // installs the downgrade, so it must still be held. Every implicit source
  // (packaged/`--from` own-build, the build-stamped pin default, `latest`,
  // viability) leaves this false and never creates a hold.
  const holdExplicitDowngrade =
    opts.versionRequest !== null && opts.versionRequest !== "latest";
  const result = await provisionHost({
    adoption: opts.adoption,
    runtime: opts.runtime,
    resolveInstallSource: () => Promise.resolve(source),
    satisfaction,
    recordVersionOverride: isOwnBuild ? config.version : null,
    enableLinger: opts.enableLinger,
    allowSelfInvocation: opts.allowSelfInvocation,
    registerService: !opts.noServiceRegister,
    lockReason: "host-ensure",
    force: opts.force,
    holdExplicitDowngrade,
    onProgress: opts.onProgress,
    beforeMutate: opts.beforeMutate,
  });
  opts.runtime.logger.info("Host ensure completed", {
    environment: opts.runtime.environment,
    action: result.action,
    installed: result.installed,
    registered: result.registered,
    running: result.running,
    hasPostSwapError: result.postSwapError !== null,
  });
  return result;
}

async function resolveEnsureSource(
  opts: EnsureHostOptions,
): Promise<InstallSourceArg> {
  if (opts.fromPath !== null) {
    return { kind: "local-file", path: opts.fromPath };
  }
  if (opts.versionRequest !== null) {
    return { kind: "registry", versionRequest: opts.versionRequest };
  }
  const bundled = await resolveBundledHostArchive();
  if (bundled !== null) {
    return { kind: "local-file", path: bundled };
  }
  return {
    kind: "registry",
    versionRequest: defaultRegistryHostVersionRequest(),
  };
}
