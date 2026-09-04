import { STAGING_RELEASE_TOKEN_ENV } from "./types";

/**
 * Which credential families to remove, because the two boundaries that strip
 * this environment want different answers and neither is a superset by
 * accident.
 *
 * - `traycer-token-only` is for the resolver's own `gh` subprocess. `gh auth
 *   token` reads `GH_TOKEN` / `GITHUB_TOKEN` as its credential, so removing
 *   them there would disable the supported fallback this module depends on.
 * - `traycer-and-gh-cli-tokens` is for the Host boundary on a build whose
 *   release credential can BE one of those variables.
 */
export type GitHubReleaseCredentialScope =
  | "traycer-token-only"
  | "traycer-and-gh-cli-tokens";

/**
 * `gh`'s own token variables for github.com. `gh help environment` documents
 * both as authentication tokens that take precedence over stored credentials,
 * and `gh auth token --hostname github.com` will emit either - so on a build
 * that authenticates its releases through `gh`, these are release credentials
 * under another name, not merely the user's ambient environment.
 *
 * The enterprise spellings are deliberately absent: the resolver pins
 * `--hostname github.com`, so they can never supply the credential it returns.
 */
const GH_CLI_TOKEN_ENV = ["GH_TOKEN", "GITHUB_TOKEN"];

/**
 * Prevent the release credential from reaching Host/provider processes.
 *
 * Windows environment names are case-insensitive: the resolver reads a token
 * supplied as `Traycer_Staging_Release_Token`, but a spread copy keeps that
 * spelling, so an exact-case delete would hand the child the token under the
 * original name. Strip every casing there; elsewhere names are case-sensitive
 * and only the exact name is the credential.
 */
export function stripGitHubReleaseCredentialsFromEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  scope: GitHubReleaseCredentialScope,
): NodeJS.ProcessEnv {
  const credentialNames =
    scope === "traycer-and-gh-cli-tokens"
      ? [STAGING_RELEASE_TOKEN_ENV, ...GH_CLI_TOKEN_ENV]
      : [STAGING_RELEASE_TOKEN_ENV];
  const isCredential =
    platform === "win32"
      ? (key: string) => credentialNames.includes(key.toUpperCase())
      : (key: string) => credentialNames.includes(key);
  const keys = Object.keys(env).filter(isCredential);
  if (keys.length === 0) return env;
  const clean = { ...env };
  for (const key of keys) delete clean[key];
  return clean;
}
