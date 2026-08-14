/**
 * Query-key builders for non-Traycer Host `AuthService` reads.
 */
export const authQueryKeys = {
  // `authService: object` keys the query to the live AuthService instance,
  // mirroring the runner-host `traycerCli` keying. Prefix-stable so a broad
  // `["auth"]` invalidation still drops it.
  user: (authService: object): readonly unknown[] => [
    "auth",
    "user",
    authService,
  ],
  // Remote Host Support (§7): the cross-device host registry + live status.
  // Keyed to the signed-in user like `userSessions`, and for the same reason:
  // an AuthService survives account changes, so without the user id the
  // previous account's cached host list (names, ids, platforms) would be
  // served to its replacement until a refetch landed. `null` is the
  // signed-out placeholder — the query is disabled then, the key only has to
  // not collide with a real user's entry.
  registeredHosts: (
    authService: object,
    userId: string | null,
  ): readonly unknown[] => ["auth", "registered-hosts", authService, userId],
  // Devices & Sessions account-security list, keyed to both the live
  // AuthService and signed-in user. An AuthService survives account changes,
  // so the user id is required to keep an old account's promise/cache from
  // becoming visible to its replacement.
  userSessions: (authService: object, userId: string): readonly unknown[] => [
    "auth",
    "user-sessions",
    authService,
    userId,
  ],
  // Stable, disabled key for when no `AuthService` binding is available yet
  // (mirrors `uiQueryKeys.hostPickerMissing`).
  registeredHostsMissing: (): readonly unknown[] => [
    "auth",
    "registered-hosts",
    "missing",
  ],
  userSessionsMissing: (): readonly unknown[] => [
    "auth",
    "user-sessions",
    "missing",
  ],
};
