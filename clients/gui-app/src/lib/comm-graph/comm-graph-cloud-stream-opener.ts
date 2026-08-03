import { hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/communication-graph";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { appLogger } from "@/lib/logger";
import type {
  CommGraphCloudSubscriptionHandle,
  CommGraphCloudSubscriptionOpener,
  CommGraphCloudSubscriptionRequest,
} from "@/lib/comm-graph/comm-graph-cloud-subscription";

const COMM_GRAPH_CLOUD_METHOD = "host.communicationGraph.subscribe";

export function createCommGraphCloudSubscriptionOpener(
  openTransport: (hostId: string) => DurableStreamTransport,
): CommGraphCloudSubscriptionOpener {
  return (request) => openCommGraphCloudSubscription(openTransport, request);
}

function openCommGraphCloudSubscription(
  openTransport: (hostId: string) => DurableStreamTransport,
  request: CommGraphCloudSubscriptionRequest,
): CommGraphCloudSubscriptionHandle {
  const { handlers, hostId } = request;
  const transport = openTransport(hostId);
  const client = transport.wsStreamClient;
  let closed = false;
  try {
    const session = client.subscribeWithParamsProvider(
      COMM_GRAPH_CLOUD_METHOD,
      () => ({
        epicId: request.epicId,
        sinceCursor: request.readSinceCursor(),
      }),
    );
    session.onServerFrame((envelope) => {
      if (closed) return;
      const parsed =
        hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10.safeParse(
          envelope,
        );
      if (!parsed.success) {
        appLogger.warn("[comm-graph] unparsable cloud server frame", {
          hostId,
        });
        return;
      }
      const frame = parsed.data;
      if (frame.kind === "availability") {
        handlers.onAvailability(frame.availability);
      } else if (frame.kind === "snapshot") {
        handlers.onSnapshot(
          frame.events,
          frame.headVersion,
          frame.frontier ?? null,
        );
      } else if (frame.kind === "event") {
        handlers.onEvent(frame.event);
      } else if (frame.kind === "connectionState") {
        handlers.onStatus("reconnecting");
      }
    });
    session.onStatusChange((status, reason) => {
      if (closed) return;
      if (status === "connecting") handlers.onStatus("connecting");
      else if (status === "open") handlers.onStatus("live");
      else if (status === "reconnecting") handlers.onStatus("reconnecting");
      else if (reason !== null && reason.kind !== "caller") {
        handlers.onStatus(
          client.getMethodSupport(COMM_GRAPH_CLOUD_METHOD) === "unsupported"
            ? "unsupported"
            : "unreachable",
        );
      }
    });
    return {
      close: () => {
        if (closed) return;
        closed = true;
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
