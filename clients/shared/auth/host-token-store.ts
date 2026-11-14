/**
 * The host-only tokens this app holds: one per (person, host), beside the
 * sign-in token, each with its end. A host-only token is all any host ever
 * receives from this app; the sign-in token only buys them at authn.
 *
 * Nothing but the token and its end is kept: no claims, and no account detail
 * beyond the person's id that keys the entry. Signing out removes that
 * person's entries.
 */
export interface HostToken {
  readonly token: string;
  /** Epoch milliseconds at which the token stops being accepted. */
  readonly expiresAtMs: number;
}

/** A token is usable for a new connection only before its end. */
export function isUsableHostToken(
  token: HostToken | null,
  nowMs: number,
): token is HostToken {
  return token !== null && token.expiresAtMs > nowMs;
}

/** Every token for every person, as persisted. */
export type HostTokenTable = ReadonlyMap<
  string,
  ReadonlyMap<string, HostToken>
>;

export interface HostTokenChange {
  readonly userId: string;
  readonly hostId: string;
}

interface HostTokenFileV1 {
  readonly version: 1;
  readonly users: Readonly<
    Record<
      string,
      Readonly<
        Record<string, { readonly token: string; readonly expiresAt: number }>
      >
    >
  >;
}

/**
 * The on-disk form, shared by every writer of one machine's file (the desktop
 * today, the CLI with T14). An entry that does not have the shape is dropped,
 * never repaired: the next open mints a fresh token for it.
 */
export function parseHostTokenFile(
  raw: unknown,
): Map<string, Map<string, HostToken>> {
  const table = new Map<string, Map<string, HostToken>>();
  if (raw === null || typeof raw !== "object") return table;
  const version: unknown = Reflect.get(raw, "version");
  const users: unknown = Reflect.get(raw, "users");
  if (version !== 1 || users === null || typeof users !== "object")
    return table;
  for (const [userId, hosts] of Object.entries(users)) {
    if (hosts === null || typeof hosts !== "object") continue;
    const forUser = new Map<string, HostToken>();
    for (const [hostId, entry] of Object.entries(hosts)) {
      if (entry === null || typeof entry !== "object") continue;
      const token: unknown = Reflect.get(entry, "token");
      const expiresAt: unknown = Reflect.get(entry, "expiresAt");
      if (
        typeof token !== "string" ||
        token.length === 0 ||
        typeof expiresAt !== "number" ||
        !Number.isFinite(expiresAt)
      )
        continue;
      forUser.set(hostId, { token, expiresAtMs: expiresAt });
    }
    if (forUser.size > 0) table.set(userId, forUser);
  }
  return table;
}

export function serializeHostTokenFile(table: HostTokenTable): HostTokenFileV1 {
  const users: Record<
    string,
    Record<string, { readonly token: string; readonly expiresAt: number }>
  > = {};
  for (const [userId, hosts] of table) {
    if (hosts.size === 0) continue;
    const forUser: Record<
      string,
      { readonly token: string; readonly expiresAt: number }
    > = {};
    for (const [hostId, entry] of hosts)
      forUser[hostId] = { token: entry.token, expiresAt: entry.expiresAtMs };
    users[userId] = forUser;
  }
  return { version: 1, users };
}
