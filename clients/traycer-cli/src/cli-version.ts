// The CLI's own identity, as a LEAF module.
// This used to live in `index.ts`, which builds the whole Commander program and therefore imports every command and the registry client.

import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  type FirstPartyClientIdentity,
} from "@traycer/protocol/framework/index";

// Local/dev fallback when the build pipeline did not inject a version (i.e. running under tsx / vitest or an unreleased local SEA build).
// CI release workflows set `TRAYCER_CLI_VERSION` from the `cli-v<version>` tag, and `build-cli-sea.cjs` bakes that value into the bundle via an esbuild define - when that path runs, `process.env.TRAYCER_CLI_VERSION` is a literal string in the emitted JS so this fallback is unreachable from a published binary.
export const LOCAL_CLI_VERSION = "0.0.0-local";

/** Resolve the version Commander should advertise. SEA builds get the release-injected value through an esbuild `define` on `process.env.TRAYCER_CLI_VERSION`; everything else (tsx dev, vitest, an unreleased local SEA built without the env var) falls back to `0.0.0-local`. */
export function resolveCliVersion(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const injected = env.TRAYCER_CLI_VERSION;
  if (typeof injected === "string" && injected.length > 0) return injected;
  return LOCAL_CLI_VERSION;
}

/** THE CLI's client identity, sent on every connection this process opens (unary `/rpc` and long-lived `/stream`). Resolved ONCE at module load rather than per connection: the injected version is an esbuild define in a published binary and the epoch is a source-level constant, so every member is a process constant - which is what lets each transport serialize it at construction. */
export const CLI_CLIENT_IDENTITY: FirstPartyClientIdentity = {
  kind: "cli",
  compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  appVersion: resolveCliVersion(process.env),
};
