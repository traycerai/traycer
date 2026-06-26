// Local/dev fallback when the build pipeline did not inject a version
// (i.e. running under tsx / vitest or an unreleased local SEA build).
// CI release workflows set `TRAYCER_CLI_VERSION` from the `cli-v<version>`
// tag, and `build-cli-sea.cjs` bakes that value into the bundle via an
// esbuild define - when that path runs, `process.env.TRAYCER_CLI_VERSION`
// is a literal string in the emitted JS so this fallback is unreachable
// from a published binary.
//
// Lives in its own module (rather than `index.ts`) so command modules such as
// `commands/config-diagnostics.ts` can resolve the version without importing
// the entrypoint - which imports those same command modules and would create a
// cycle.
export const LOCAL_CLI_VERSION = "0.0.0-local";

/**
 * Resolve the version Commander should advertise. SEA builds get the
 * release-injected value through an esbuild `define` on
 * `process.env.TRAYCER_CLI_VERSION`; everything else (tsx dev, vitest,
 * an unreleased local SEA built without the env var) falls back to
 * `0.0.0-local`. Exported so tests can pin the resolution matrix
 * without subprocess-spawning the binary.
 */
export function resolveCliVersion(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const injected = env.TRAYCER_CLI_VERSION;
  if (typeof injected === "string" && injected.length > 0) return injected;
  return LOCAL_CLI_VERSION;
}
