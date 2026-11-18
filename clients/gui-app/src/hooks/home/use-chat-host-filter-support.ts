import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";

/**
 * Whether this host can evaluate the history page's chat-host filter.
 *
 * - `supported` - the host negotiated `epic.listTasks` at @1.3 or later.
 * - `unsupported` - it negotiated an older minor, which SILENTLY STRIPS
 *   `chatHostIds` from the request. That is the entire reason this gate
 *   exists: the response comes back well-formed and complete, so an
 *   unfiltered list would render as a filtered one with no error anywhere.
 * - `unknown` - no handshake with this host has completed yet.
 *
 * `epic.listTasks` is a RELEASED-FLOOR method, so `useHostSupportsMethod` is
 * the wrong question - every host advertises it. Only the negotiated MINOR
 * distinguishes a host that will honor the filter from one that will discard
 * it.
 */
export type ChatHostFilterSupport = "supported" | "unsupported" | "unknown";

/** The `epic.listTasks` minor that introduced `chatHostIds`. */
const CHAT_HOST_FILTER_MINOR = 3;

export function useChatHostFilterSupport(
  hostId: string | null,
): ChatHostFilterSupport {
  const version = useHostMethodSchemaVersion(hostId, "epic.listTasks");
  if (version === null) return "unknown";
  if (version.major !== 1) return "unsupported";
  return version.minor >= CHAT_HOST_FILTER_MINOR ? "supported" : "unsupported";
}
