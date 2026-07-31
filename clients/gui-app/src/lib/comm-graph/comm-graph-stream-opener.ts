/**
 * Production `CommGraphSubscriptionOpener`: one durable transport + one
 * `epic.communicationGraph.subscribe` session per host.
 *
 * The transport is opened per host rather than reusing the app-wide stream
 * client, because that one is bound to the ACTIVE host and this tile has to
 * reach every host the epic's agents live on at once. `openDurableStreamTransport`
 * is the shared "socket + auth + wake re-dial + endpoint-change re-dial" bundle
 * the chat / terminal / epic session stores use, so a comm-graph subscription
 * recovers from host restarts and OS sleep exactly like they do.
 */
import { epicCommunicationGraphSubscribeServerFrameSchema } from "@traycer/protocol/host/epic/communication-graph";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { appLogger } from "@/lib/logger";
import type {
  CommGraphSubscriptionHandle,
  CommGraphSubscriptionOpener,
  CommGraphSubscriptionRequest,
} from "@/lib/comm-graph/comm-graph-subscription";

const COMM_GRAPH_METHOD = "epic.communicationGraph.subscribe";

export function createCommGraphSubscriptionOpener(
  openTransport: (hostId: string) => DurableStreamTransport,
): CommGraphSubscriptionOpener {
  return (request: CommGraphSubscriptionRequest): CommGraphSubscriptionHandle =>
    openCommGraphSubscription(openTransport, request);
}

function openCommGraphSubscription(
  openTransport: (hostId: string) => DurableStreamTransport,
  request: CommGraphSubscriptionRequest,
): CommGraphSubscriptionHandle {
  const { handlers, hostId } = request;
  const transport = openTransport(hostId);
  const client = transport.wsStreamClient;
  let closed = false;
  try {
    const session = client.subscribe(COMM_GRAPH_METHOD, {
      epicId: request.epicId,
      // Required-and-nullable: a first open MUST send an explicit `null`.
      sinceCursor: request.sinceCursor,
    });
    session.onServerFrame((envelope) => {
      if (closed) return;
      const parsed =
        epicCommunicationGraphSubscribeServerFrameSchema.safeParse(envelope);
      if (!parsed.success) {
        appLogger.warn("[comm-graph] unparsable server frame", { hostId });
        return;
      }
      if (parsed.data.kind === "snapshot") {
        handlers.onSnapshot(parsed.data.events, parsed.data.headId);
        return;
      }
      if (parsed.data.kind === "event") {
        handlers.onEvent(parsed.data.event);
      }
    });
    session.onStatusChange((status, reason) => {
      if (closed) return;
      if (status === "connecting") {
        handlers.onStatus("connecting");
        return;
      }
      if (status === "open") {
        handlers.onStatus("live");
        return;
      }
      if (status === "reconnecting") {
        handlers.onStatus("reconnecting");
        return;
      }
      // A caller-initiated close is our own teardown; nothing to report.
      if (reason === null || reason.kind === "caller") return;
      // A host that predates this optional stream method fails the per-method
      // compatibility check at subscribe time: the client records the method
      // as `unsupported` and closes THIS subscription only. Every other host
      // in the epic keeps streaming; this one's agents get the "no edge data"
      // affordance instead of a broken-connection badge.
      handlers.onStatus(
        client.getMethodSupport(COMM_GRAPH_METHOD) === "unsupported"
          ? "unsupported"
          : "unreachable",
      );
    });
    return {
      close: () => {
        if (closed) return;
        closed = true;
        // The transport (socket + rotation/wake listeners) must be released
        // even when the session's own teardown throws - otherwise the leak is
        // silent for the life of the app.
        try {
          session.close();
        } finally {
          transport.close();
        }
      },
    };
  } catch (cause) {
    transport.close();
    throw cause;
  }
}
