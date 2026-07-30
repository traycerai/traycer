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
  // Devices & Sessions account-security list, keyed to the live AuthService
  // instance so sign-out/cross-user invalidation drops it with other auth data.
  userSessions: (authService: object): readonly unknown[] => [
    "auth",
    "user-sessions",
    authService,
  ],
  userSessionsMissing: (): readonly unknown[] => [
    "auth",
    "user-sessions",
    "missing",
  ],
};
