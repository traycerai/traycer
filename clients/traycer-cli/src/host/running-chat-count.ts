import type { HostTransportEndpoint } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostAuth } from "../internal/host-auth";
import {
  callHostRpcAtResolvedEndpoint,
  PLAIN_DISPATCH,
} from "../internal/host-rpc";

/**
 * The team work a claim stops, as the app's claim confirm shows it (board
 * C13). `unknown` is a failed read, a null answer or a host that answers
 * unsupported; it is never read as `none`.
 */
export type RunningChats =
  | { readonly kind: "none" }
  | { readonly kind: "count"; readonly count: number }
  | { readonly kind: "unknown" };

/**
 * The team's chats with a turn running on this computer, from the computer
 * subject of `environment.previewLocalFacts`. `environmentId` is the team's
 * environment this computer is bound to.
 */
export async function readRunningChatCount(
  endpoint: HostTransportEndpoint,
  auth: HostAuth,
  environmentId: string,
): Promise<RunningChats> {
  const facts = await callHostRpcAtResolvedEndpoint(
    "environment.previewLocalFacts",
    { environmentId, subject: { kind: "computer" } },
    endpoint,
    auth,
    PLAIN_DISPATCH,
  ).catch(() => null);
  if (facts === null || facts.activeTurns === null) return { kind: "unknown" };
  if (facts.activeTurns === 0) return { kind: "none" };
  return { kind: "count", count: facts.activeTurns };
}
