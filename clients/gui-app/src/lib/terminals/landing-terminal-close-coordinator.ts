import { plainTerminalFleetIdentityKey } from "@traycer/protocol/host/terminal/plain-schemas";

const pendingByLifetimeKey = new Map<string, Promise<void>>();

/**
 * One close request per landing-terminal lifetime; joiners get `owned: false` and must not treat settlement as their own RPC.
 * Kill answering `killed: false` is ambiguous for `pendingCreate` tombstones.
 */
export interface LandingTerminalCloseOutcome {
  /** Whether THIS caller's `close` is the request that ran. */
  readonly owned: boolean;
}

export function requestLandingTerminalClose(args: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly close: () => Promise<void>;
}): Promise<LandingTerminalCloseOutcome> {
  const key = plainTerminalFleetIdentityKey({
    hostId: args.hostId,
    terminalId: args.sessionId,
  });
  const existing = pendingByLifetimeKey.get(key);
  if (existing !== undefined) return existing.then(() => ({ owned: false }));

  const pending = Promise.resolve().then(args.close);
  pendingByLifetimeKey.set(key, pending);
  const release = (): void => {
    if (pendingByLifetimeKey.get(key) === pending) {
      pendingByLifetimeKey.delete(key);
    }
  };
  void pending.then(release, release);
  return pending.then(() => ({ owned: true }));
}
