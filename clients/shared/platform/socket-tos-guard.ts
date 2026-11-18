/**
 * Makes `net.Socket.prototype.setTypeOfService` best effort.
 *
 * Node's HTTP client (undici 7.x, both the copy built into Node and the npm
 * one) calls `socket.setTypeOfService(0)` on the first write of every request,
 * with nothing around it. The call marks the connection's traffic class and is
 * optional, but outside Windows Node throws when the system call fails, and on
 * macOS it fails with `EINVAL` on a connection the peer has already reset. The
 * throw happens on the socket's own callback, not inside the `fetch` promise,
 * so no `try`/`catch` around a request can see it: it reaches the process as an
 * uncaught exception while the request itself rejects normally
 * (traycerai/traycer#2093). A host that is stalled or shutting down resets the
 * connections waiting in its accept queue, which is when the CLI and the
 * desktop app probe it over loopback HTTP.
 *
 * The prototype is the only place that covers the built-in `fetch`: it does
 * not use the npm undici unless a proxy is configured, and undici guards the
 * call itself only from 8.x.
 *
 * Remove this module and its installer once the Node these processes run on
 * ships an undici with that guard. The Traycer Host carries its own copy
 * (`traycer-host/src/net/socket-tos-guard.ts` in the host repository), because
 * it cannot import from the clients.
 */

/** The part of `net.Socket.prototype` the guard replaces. */
export interface SocketTosTarget {
  setTypeOfService: ((tos: number) => unknown) | undefined;
}

// Registered globally so a second copy of this module in the same realm (two
// bundles, a re-import in a test) finds the mark and does not wrap again.
const GUARDED = Symbol.for("traycer.socketTosGuard");

/**
 * Wraps `target.setTypeOfService` so a failure of the system call returns the
 * socket instead of throwing. An argument error (`ERR_INVALID_ARG_TYPE`,
 * `ERR_OUT_OF_RANGE`) still throws: that is a caller's bug, not socket state.
 * A runtime without the method (Bun, an older Node) is left untouched.
 */
export function installSocketTosGuard(target: SocketTosTarget): void {
  const original = target.setTypeOfService;
  if (typeof original !== "function" || GUARDED in original) {
    return;
  }
  const guarded = function (this: unknown, tos: number): unknown {
    try {
      return original.call(this, tos);
    } catch (error) {
      if (isSetTypeOfServiceFailure(error)) {
        return this;
      }
      throw error;
    }
  };
  Object.defineProperty(guarded, GUARDED, { value: true });
  target.setTypeOfService = guarded;
}

// Node reports the failed system call on the error it builds from the errno
// (`new ErrnoException(err, "setTypeOfService")`); the argument errors carry
// no `syscall` at all.
function isSetTypeOfServiceFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "syscall" in error &&
    error.syscall === "setTypeOfService"
  );
}
