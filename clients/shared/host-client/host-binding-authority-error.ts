/**
 * `StaleHostBindingAuthorityError`, alone, with ZERO imports.
 *
 * It used to be declared inside `host-binding-authority-registry.ts`, which
 * value-imports `hasReadyRemoteSession` from
 * `host-transport/remote/active-remote-sessions` — a module-scoped, process-wide
 * `RemoteSession` cache. So any module that wanted to `instanceof` this error
 * imported that cache along with it, whether or not it ever touched the
 * registry.
 *
 * That mattered because `epic-write-command.ts` does exactly one thing with the
 * registry: `error instanceof StaleHostBindingAuthorityError`, inside
 * `classifyEpicWriteCommandFailure`. It reads none of the registry's members.
 * The class travelled into the epic replica runtime's import graph, and the
 * runtime is scheduled to run in a Web Worker — where a second copy of a
 * process-wide session cache is a split brain nothing in-process can observe.
 *
 * **The file must stay import-free.** Its whole value is that it cannot pull
 * anything: an `import type` would be harmless, but a value import here would
 * silently restore the chain for every one of its dependents at once, and the
 * worker-graph ratchet is the only thing that would notice.
 */
/** A routed entry no longer describes the directory's current transport. */
export class StaleHostBindingAuthorityError extends Error {
  constructor(hostId: string) {
    super(`Host '${hostId}' changed before its request authority was captured`);
    this.name = "StaleHostBindingAuthorityError";
  }
}
