// A host only ever receives a host-only token; the sign-in token only buys them at
// authn. Nothing but the token and its end is kept.
export interface HostToken {
  readonly token: string;
  /** Epoch milliseconds at which the token stops being accepted. */
  readonly expiresAtMs: number;
}

export function isUsableHostToken(
  token: HostToken | null,
  nowMs: number,
): token is HostToken {
  return token !== null && token.expiresAtMs > nowMs;
}

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

// Shared by every writer of the machine's file; a malformed entry is dropped, never repaired.
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
