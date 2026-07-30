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
  userSessionsMissing: (): readonly unknown[] => [
    "auth",
    "user-sessions",
    "missing",
  ],
};
