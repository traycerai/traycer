import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import {
  getPublishedProcessIdentityVerdict,
  type PublishedProcessIdentityVerdict,
} from "./process-identity";

export type HostEndpointReachabilityProbe = (
  websocketUrl: string,
) => Promise<boolean>;

/** Do not serve a cached verdict when `answered` is true (impostor listener on the same port). */
export interface PublishedProcessIdentityQuery {
  readonly pid: number;
  readonly startIdentity: ProcessStartIdentity | null;
  readonly answered: boolean;
}

export type PublishedProcessIdentityVerdictReader = (
  query: PublishedProcessIdentityQuery,
) => Promise<PublishedProcessIdentityVerdict>;

export type PublishedHostPresence = "available" | "busy" | "absent";

// Committed WS-only endpoint; status reads and lifecycle snapshots share this eligibility check.
const WS_RPC_PATH = "/rpc";
const WS_RPC_HOST = "127.0.0.1";

/** True only for `ws(s)://127.0.0.1:<port>/rpc`. */
export function isCurrentHostWebsocketUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return false;
  }
  if (parsed.hostname !== WS_RPC_HOST || parsed.port === "") {
    return false;
  }
  return parsed.pathname === WS_RPC_PATH;
}

export async function isPublishedHostEndpointReachable(
  websocketUrl: string,
  pid: number,
  startIdentity: ProcessStartIdentity | null,
  probe: HostEndpointReachabilityProbe,
): Promise<boolean> {
  return (
    (await readPublishedHostPresence(
      websocketUrl,
      pid,
      startIdentity,
      probe,
      undefined,
    )) === "available"
  );
}

/** Probe first, then identity; a failed probe may degrade, never contradict liveness. */
export async function readPublishedHostPresence(
  websocketUrl: string,
  pid: number,
  startIdentity: ProcessStartIdentity | null,
  probe: HostEndpointReachabilityProbe,
  readIdentityVerdict: PublishedProcessIdentityVerdictReader | undefined,
): Promise<PublishedHostPresence> {
  if (!isCurrentHostWebsocketUrl(websocketUrl)) return "absent";
  const answered = await probe(websocketUrl);
  const identityVerdict = await (readIdentityVerdict ?? readIdentityVerdictNow)(
    { pid, startIdentity, answered },
  );
  // Dead/recycled pid outranks a successful handshake (impostor listener on the same port).
  if (identityVerdict === "dead" || identityVerdict === "mismatch") {
    return "absent";
  }
  return answered ? "available" : "busy";
}

function readIdentityVerdictNow(
  query: PublishedProcessIdentityQuery,
): Promise<PublishedProcessIdentityVerdict> {
  return getPublishedProcessIdentityVerdict(query.pid, query.startIdentity);
}
