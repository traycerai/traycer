import {
  RELAY_RELINK_CLOSE_CODE,
  RELAY_RELINK_CLOSE_REASON,
} from "@traycer/protocol/host-transport/remote/relay-socket";

/** Track this window's relay legs without touching local or pool sockets. */
export function installDevRelayDropSwitch(
  scope: Window & typeof globalThis,
  relayBaseUrl: string,
): () => void {
  const relay = new URL(relayBaseUrl);
  const NativeWebSocket = scope.WebSocket;
  const sockets = new Set<WebSocket>();
  const trackedWebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const socket: unknown = Reflect.construct(target, args, newTarget);
      if (!(socket instanceof NativeWebSocket)) {
        throw new Error("WebSocket construction returned an unexpected value");
      }
      const url = new URL(socket.url);
      if (url.origin === relay.origin && url.pathname === relay.pathname) {
        sockets.add(socket);
        socket.addEventListener("close", () => sockets.delete(socket), {
          once: true,
        });
      }
      return socket;
    },
  });
  scope.WebSocket = trackedWebSocket;
  Object.defineProperty(scope, "__traycerDevDropRelay", {
    configurable: true,
    value: (): number => {
      let dropped = 0;
      for (const socket of sockets) {
        if (socket.readyState !== NativeWebSocket.OPEN) continue;
        socket.close(RELAY_RELINK_CLOSE_CODE, RELAY_RELINK_CLOSE_REASON);
        dropped += 1;
      }
      return dropped;
    },
  });
  return () => {
    if (scope.WebSocket === trackedWebSocket) scope.WebSocket = NativeWebSocket;
    Reflect.deleteProperty(scope, "__traycerDevDropRelay");
  };
}
