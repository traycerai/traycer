import { COMPATIBLE_HOST_START_SCRIPT_PREFIX as SHARED_COMPATIBLE_HOST_START_SCRIPT_PREFIX } from "@traycer-clients/shared/host-lifecycle";

/**
 * The `/bin/sh -c` program shared by the macOS LaunchAgent plist and the
 * systemd user unit. Both invoke it as
 *
 *     /bin/sh -c <script> <cli-command> <cli-args...>
 *
 * so `"$0"` is the CLI command and `"$@"` its leading invocation args.
 *
 * Single file because the two emitters previously carried byte-identical
 * copies of both this script and its quoting helper, and the copy drifted
 * into emitting shell that does not parse (see `posixShellQuote`).
 */

/**
 * Everything up to (and including) the capability token, i.e. the part of the
 * script that is invariant across labels. `readRegisteredCliInvocation` uses
 * it to recognise a plist this module wrote.
 *
 * Re-exported, not redefined. The emitter and the shared substrate's
 * `attestTraycerRegistration` must agree on this string byte-for-byte, and a
 * local copy is exactly how they came apart before: this file moved to
 * `host capabilities --has service-label` while `host-lifecycle/identity.ts`
 * kept matching the old `host start --help | grep` form, so attestation
 * stopped recognising the plists this file writes. One definition, one place.
 */
export const COMPATIBLE_HOST_START_SCRIPT_PREFIX =
  SHARED_COMPATIBLE_HOST_START_SCRIPT_PREFIX;

/**
 * Service definitions update independently of the CLI binary they point at,
 * and the slot is a user-owned symlink that can be an N-1 build. Ask the
 * binary whether it understands the identity flag before passing it: a
 * current CLI answers with exit 0 and receives `--service-label`; an N-1 CLI
 * has no `host capabilities` subcommand, exits non-zero, and starts the host
 * exactly as it always did. Neither direction can fail to start.
 *
 * The probe is an exit code, not text: no `grep` (hardcoding `/usr/bin/grep`
 * breaks on NixOS) and no help-output layout to accidentally freeze.
 *
 * Kept on ONE line and free of `;`, `%`, tab and newline: this string is
 * embedded verbatim in a systemd `ExecStart=` value, and `buildUnit`'s token
 * guard rejects those characters rather than emit a unit systemd mis-parses.
 *
 * `A && exec B || exec C` is sound here precisely because of `exec`: when the
 * probe succeeds, `exec B` replaces the shell and the `||` arm is
 * unreachable; when it fails, `&&` short-circuits and `|| exec C` runs.
 */
export function buildCompatibleHostStartScript(serviceLabel: string): string {
  return `${COMPATIBLE_HOST_START_SCRIPT_PREFIX} >/dev/null 2>&1 && exec "$0" "$@" host start --service-label ${posixShellQuote(serviceLabel)} || exec "$0" "$@" host start`;
}

/**
 * POSIX single-quote a value for embedding in the script above.
 *
 * A single-quoted POSIX string cannot contain a single quote at all, so the
 * only way to include one is to close the quote, emit an escaped or
 * double-quoted quote, and reopen: `'` -> `'\''`. The previous
 * `"'\\\"'\\\"'"` replacement produced `'\"'\"'`, which is neither that form
 * nor the `'"'"'` variant it was reaching for - it leaves an unterminated
 * quote, and `sh` dies with "unexpected EOF" before the host is ever exec'd.
 *
 * Unreachable today (`ServiceLabel.id` is provably quote-free), but this is
 * the guard the emitters lean on when the label alphabet widens or the helper
 * is reused for a path, so it has to actually hold.
 */
export function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
