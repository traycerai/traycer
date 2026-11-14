/**
 * The host refuses a request that names a managed profile it cannot use with
 * one of four fixed messages, sent under the wire code `RPC_ERROR`
 * (`transport/rpc/handler.ts`'s invalid managed-profile selection arm). The
 * error classes live host-side only (`profile-resolver.ts`) and the envelope
 * carries just `{ code, message }`, so a client recognizes the family by these
 * templates - the only client-observable signal. Each pattern allows the
 * interpolated profile and provider ids and anything the host appends after
 * the first sentence (for example the retained-worktree disclosure
 * `agent-tui-prepare-launch-resolver.ts` adds).
 *
 * Coupled by construction to the constructors of `ProfileNotFoundError`,
 * `ProfileTombstonedError`, `ProfileSetupPendingError` and
 * `ProfileNotSupportedByProviderError` in the host's `profile-resolver.ts`:
 * change a template there and here together. Users: the GUI's TUI-fork
 * rejection view (`gui-app/src/lib/tui-fork-profile-rejection.ts`) and the
 * CLI's host-error mapper (`traycer-cli/src/internal/host-rpc.ts`).
 */
const UNKNOWN_PROFILE_MESSAGE_PATTERN =
  /^No profile ".*" is registered for provider ".*"\./;

const PROFILE_LIFECYCLE_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  UNKNOWN_PROFILE_MESSAGE_PATTERN,
  /^Profile ".*" for provider ".*" was removed and can no longer be used\./,
  /^Profile ".*" for provider ".*" is still completing setup and cannot be used yet\./,
  /^Provider ".*" does not support managed profiles\./,
];

/**
 * True only for an `RPC_ERROR` whose message is one of the four profile
 * lifecycle templates. Any other code, including `E_INVALID_ARGUMENT`, is
 * false: the family is recognized by the code the host sends it under today.
 */
export function isProfileLifecycleRejection(
  code: string,
  message: string,
): boolean {
  if (code !== "RPC_ERROR") return false;
  return PROFILE_LIFECYCLE_MESSAGE_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
}

/**
 * True only for the code `removed-by-person` with the unknown-id sentence,
 * which is what the computer answers on a unary start that names an account a
 * person removed: the sentence it gives for an unknown id, under its own code.
 *
 * For the CLI's host-error mapper only, so that refusal prints exactly what an
 * unknown id prints today. The app must not use it: for this code the app
 * shows its own words (the profile pin's "Was removed"), never the computer's
 * sentence, which carries the profile id.
 */
export function isRemovedProfileRefusal(
  code: string,
  message: string,
): boolean {
  return (
    code === "removed-by-person" &&
    UNKNOWN_PROFILE_MESSAGE_PATTERN.test(message)
  );
}
