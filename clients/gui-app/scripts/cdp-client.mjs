// The shared Chrome DevTools Protocol client for the browser regression
// drivers - the CDP half that `chrome-launcher.mjs` deliberately leaves to its
// consumers.
//
// Every driver used to carry its own `connectCdp`, and most copies had no path
// to settle a command once Chrome went away: no `close` handler, an `error`
// handler that rejected only the connect, and no per-command deadline. A
// Chrome crash or a dropped DevTools socket then left `send()` pending
// forever, the driver never reached its `finally` to terminate Chrome and
// Vite, and the runner (`run-browser-regressions.ts`, which spawns each driver
// without a timeout) held the CI job until the job's own limit, hiding the real
// error. The copies that had been hardened each did it differently. This is
// the one hardened client.

const CONNECT_TIMEOUT_MS = 15_000;
// A command's own ceiling. Every page-side wait the drivers evaluate is under a
// second; the long waits live in the drivers' Node-side polling loops, each
// iteration of which is a separate command.
const COMMAND_TIMEOUT_MS = 30_000;
// How long disposing of a session's tab may wait on Chrome's HTTP endpoint.
const TAB_CLOSE_TIMEOUT_MS = 2_000;

/**
 * Opens a CDP session on `webSocketDebuggerUrl` and resolves to
 * `{ send(method, params), on(method, handler), close() }`.
 *
 * `send` rejects - never hangs - when Chrome answers with an error, when the
 * socket errors or closes (every outstanding command fails with the reason),
 * when the socket is no longer open, or when no answer arrives within
 * `COMMAND_TIMEOUT_MS`.
 *
 * `on` calls `handler(params)` for every CDP event named `method` (a message
 * with no `id`, e.g. `Runtime.exceptionThrown`) and returns the function that
 * unsubscribes it. It adds no wait of its own: a driver that waits on an event
 * does so in its own bounded polling loop, like every other page-side wait.
 */
export function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    const eventHandlers = new Map();
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
      if (typeof message.id !== "number") {
        for (const handler of eventHandlers.get(message.method) ?? []) {
          handler(message.params);
        }
        return;
      }
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
        on(method, handler) {
          const handlers = eventHandlers.get(method) ?? new Set();
          handlers.add(handler);
          eventHandlers.set(method, handlers);
          return () => {
            handlers.delete(handler);
          };
        },
        close() {
          socket.close();
        },
      });
    });
  });
}

/**
 * A CDP session on a page tab that can move to a fresh tab: `freshTab()`
 * opens a new tab on about:blank, points the session at it and closes the old
 * one, so the same session object - and every handler registered with `on`,
 * which keeps firing on whichever tab is current - drives a new renderer
 * process. `crashed()` reports whether the current tab's renderer is gone.
 *
 * Why it exists: a tab navigated from load to load keeps one renderer
 * process, and on the unbundled Vite fixtures that process grows to 1-2 GB of
 * retained state, then either stops booting or is killed ("Render process
 * gone"), after which its CDP session never answers again. A fresh tab per
 * load holds the renderer near its single-load size (tickets/12).
 *
 * Domains a driver enables and emulation it sets are the TAB's state: a
 * driver re-sends them after `freshTab()`.
 */
export async function openTabSession(devtoolsHttpUrl) {
  const handlers = new Map();
  let tab = await openTab(devtoolsHttpUrl);
  const dispatchOn = (current, method) => {
    current.client.on(method, (params) => {
      for (const handler of handlers.get(method) ?? []) handler(params);
    });
  };
  // Chrome reports a renderer that crashed or was killed as
  // `Inspector.targetCrashed`, and some exits only as `Inspector.detached`
  // ("Render process gone"): either one means this tab will never answer.
  const watch = (current) => {
    const markCrashed = () => {
      current.crashed = true;
    };
    current.client.on("Inspector.targetCrashed", markCrashed);
    current.client.on("Inspector.detached", markCrashed);
    for (const method of handlers.keys()) dispatchOn(current, method);
  };
  watch(tab);
  await tab.client.send("Inspector.enable", undefined);
  return {
    send(method, params = {}) {
      return tab.client.send(method, params);
    },
    on(method, handler) {
      if (!handlers.has(method)) {
        handlers.set(method, new Set());
        dispatchOn(tab, method);
      }
      handlers.get(method).add(handler);
      return () => {
        handlers.get(method)?.delete(handler);
      };
    },
    crashed() {
      return tab.crashed;
    },
    async freshTab() {
      const next = await openTab(devtoolsHttpUrl);
      watch(next);
      await next.client.send("Inspector.enable", undefined);
      const previous = tab;
      tab = next;
      await closeTab(devtoolsHttpUrl, previous);
    },
    async close() {
      await closeTab(devtoolsHttpUrl, tab);
    },
  };
}

async function openTab(devtoolsHttpUrl) {
  const response = await fetch(
    new URL("/json/new?about:blank", devtoolsHttpUrl),
    { method: "PUT" },
  );
  if (!response.ok) {
    throw new Error(`Chrome could not open a page: ${response.status}`);
  }
  const target = await response.json();
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("Chrome did not return a page debugger URL");
  }
  const client = await connectCdp(target.webSocketDebuggerUrl);
  return { id: target.id, client, crashed: false };
}

/**
 * Closes a tab and never rejects, within `TAB_CLOSE_TIMEOUT_MS`: disposal runs
 * in the drivers' `finally`, ahead of terminating Chrome and Vite, so it must
 * not depend on a live DevTools endpoint. A browser that is already gone has
 * no tab left to close.
 */
async function closeTab(devtoolsHttpUrl, tab) {
  tab.client.close();
  try {
    await fetch(new URL(`/json/close/${tab.id}`, devtoolsHttpUrl), {
      signal: AbortSignal.timeout(TAB_CLOSE_TIMEOUT_MS),
    });
  } catch {
    // The endpoint is gone or slow; the tab dies with the browser.
  }
}
