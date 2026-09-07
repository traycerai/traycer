import {
  COMPATIBLE_HOST_START_SCRIPT_PREFIX as SHARED_COMPATIBLE_HOST_START_SCRIPT_PREFIX,
  HOST_START_LAUNCHER_BASENAME as SHARED_HOST_START_LAUNCHER_BASENAME,
} from "@traycer-clients/shared/host-lifecycle";

/** The `/bin/sh -c` program shared by the macOS LaunchAgent plist and the systemd user unit. Both invoke it as /bin/sh -c <script> <cli-command> <cli-args...> so `"$0"` is the CLI command and `"$@"` its leading invocation args. */

/** Everything up to (and including) the capability token, i.e. the part of the script that is invariant across labels. `readRegisteredCliInvocation` uses it to recognise a plist this module wrote. */
export const COMPATIBLE_HOST_START_SCRIPT_PREFIX =
  SHARED_COMPATIBLE_HOST_START_SCRIPT_PREFIX;

/** Service definitions update independently of the CLI binary they point at, and the slot is a user-owned symlink that can be an N-1 build. Ask the binary whether it understands the identity flag before passing it: a current CLI answers with exit 0 and receives `--service-label`; an N-1 CLI has no `host capabilities` subcommand, exits non-zero, and starts the host exactly as it always did. */
export function buildCompatibleHostStartScript(serviceLabel: string): string {
  const label = posixShellQuote(serviceLabel);
  const capability = `${COMPATIBLE_HOST_START_SCRIPT_PREFIX} >/dev/null 2>&1`;
  const adoptionCapability = `"$0" "$@" host capabilities --has host-start-adoption-v2 >/dev/null 2>&1`;
  const adoptionNonce = `"$0" "$@" host adoption-nonce --service-label ${label} 2>/dev/null`;
  return `${capability} && ${adoptionCapability} && nonce="$(${adoptionNonce})" && [ -n "$nonce" ] && exec "$0" "$@" host start --service-label ${label} --adoption-nonce "$nonce" || ${capability} && exec "$0" "$@" host start --service-label ${label} || exec "$0" "$@" host start`;
}

/** Basename of the launcher file the macOS LaunchAgent executes. Re-exported from the shared substrate for the same lockstep reason as the prefix above: `attestTraycerRegistration` recognises launcher-form plists by this basename, so the emitter must not spell it independently. */
export const HOST_START_LAUNCHER_BASENAME = SHARED_HOST_START_LAUNCHER_BASENAME;

/** Launcher-file form of the compatibility wrapper. Keep lockstep with the in-plist script. */
export function buildHostStartLauncherScript(serviceLabel: string): string {
  const label = posixShellQuote(serviceLabel);
  return `#!/bin/sh
# Traycer host launcher. Written by 'traycer host service install'; the
# LaunchAgent plist executes this file with the CLI invocation as its
# arguments. It exists as a FILE (not an inline 'sh -c' program) so macOS
# names the login item after it instead of after /bin/sh.
"$@" host capabilities --has service-label >/dev/null 2>&1 && "$@" host capabilities --has host-start-adoption-v2 >/dev/null 2>&1 && nonce="$("$@" host adoption-nonce --service-label ${label} 2>/dev/null)" && [ -n "$nonce" ] && exec "$@" host start --service-label ${label} --adoption-nonce "$nonce" || "$@" host capabilities --has service-label >/dev/null 2>&1 && exec "$@" host start --service-label ${label} || exec "$@" host start
`;
}

/** POSIX single-quote a value for embedding in the script above. A single-quoted POSIX string cannot contain a single quote at all, so the only way to include one is to close the quote, emit an escaped or double-quoted quote, and reopen: `'` -> `'\''`. */
export function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
