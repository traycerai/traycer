// The shared Chrome DevTools Protocol client for the browser regression
// drivers - the CDP half that `chrome-launcher.mjs` deliberately leaves to its
// consumers.
//
// Every driver used to carry its own `connectCdp`, and most copies had no path
// to settle a command once Chrome went away: no `close` handler, an `error`
// handler that rejected only the connect, and no per-command deadline. A
// Chrome crash or a dropped DevTools socket then left `send()` pending
// forever, the driver never reached its `finally` to terminate Chrome and
// Vite, and `run-tests.ts` (which spawns each driver without a timeout) held
// the CI job until the job's own limit, hiding the real error. The copies that
// had been hardened each did it differently. This is the one hardened client.

const CONNECT_TIMEOUT_MS = 15_000;
// A command's own ceiling. Every page-side wait the drivers evaluate is under a
// second; the long waits live in the drivers' Node-side polling loops, each
// iteration of which is a separate command.
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Opens a CDP session on `webSocketDebuggerUrl` and resolves to
 * `{ send(method, params), close() }`.
 *
 * `send` rejects - never hangs - when Chrome answers with an error, when the
 * socket errors or closes (every outstanding command fails with the reason),
 * when the socket is no longer open, or when no answer arrives within
 * `COMMAND_TIMEOUT_MS`.
 */
export function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 0;
    let closedReason = null;
    let connectTimer = null;
    const fail = (reason) => {
      if (closedReason !== null) return;
      closedReason = reason;
      clearTimeout(connectTimer);
      for (const request of pending.values()) request.reject(reason);
      pending.clear();
      reject(reason);
    };
    connectTimer = setTimeout(() => {
      fail(new Error("CDP connect timed out"));
      socket.close();
    }, CONNECT_TIMEOUT_MS);
    socket.addEventListener("error", (event) => {
      fail(new Error(`CDP socket error: ${String(event)}`));
    });
    socket.addEventListener("close", (event) => {
      fail(new Error(`CDP socket closed (${event.code})`));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (message.error === undefined) request.resolve(message.result);
      else request.reject(new Error(message.error.message));
    });
    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      resolve({
        send(method, params = {}) {
          if (closedReason !== null) return Promise.reject(closedReason);
          if (socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(
              new Error(`CDP socket not open for ${method}`),
            );
          }
          return new Promise((requestResolve, requestReject) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              pending.delete(id);
              requestReject(
                new Error(
                  `CDP ${method} got no answer within ${COMMAND_TIMEOUT_MS}ms`,
                ),
              );
            }, COMMAND_TIMEOUT_MS);
            const request = {
              resolve: (result) => {
                clearTimeout(timer);
                requestResolve(result);
              },
              reject: (reason) => {
                clearTimeout(timer);
                requestReject(reason);
              },
            };
            pending.set(id, request);
            try {
              socket.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              pending.delete(id);
              request.reject(error);
            }
          });
        },
        close() {
          socket.close();
        },
      });
    });
  });
}
