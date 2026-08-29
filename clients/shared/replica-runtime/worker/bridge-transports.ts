/**
 * Adapters from the real message targets onto {@link BridgeTransport}.
 *
 * Three targets, one shape: the `Worker` handle the main thread holds, the
 * worker's own global scope, and a `MessagePort` (which is what a test drives,
 * and what a future split into more than one worker would ride).
 *
 * Structural interfaces rather than the DOM types, for a reason that bites at
 * compile time rather than at runtime: `clients/shared` compiles with `lib:
 * DOM`, where `self` is a `Window` whose `postMessage` is
 * `(message, targetOrigin, transfer)`. A dedicated worker's scope has
 * `(message, transfer)`. Naming the DOM types here would make the worker entry
 * fail to type-check against the very global it runs on, and the usual escape -
 * an assertion - is not available to us and would not be right anyway.
 */
import type { BridgeTransport } from "./bridge-endpoint";

export interface BridgeMessageEventLike {
  readonly data: unknown;
}

/**
 * The two-way message target both a `Worker` and a worker's global scope
 * satisfy.
 */
export interface BridgeMessageTargetLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: BridgeMessageEventLike) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: BridgeMessageEventLike) => void,
  ): void;
}

/** A `MessagePort`: a message target that must be started before it delivers. */
export interface BridgePortLike extends BridgeMessageTargetLike {
  start(): void;
}

/**
 * Wraps a `Worker` handle, or a worker's own global scope, as a transport.
 *
 * The transfer list is copied into a fresh array at this one edge because
 * `postMessage` declares a mutable `Transferable[]` while everything above
 * keeps its lists `readonly` - the alternative is a `readonly` leak all the
 * way up, or an assertion here.
 */
export function createMessageTargetTransport(
  target: BridgeMessageTargetLike,
): BridgeTransport {
  return {
    post(message, transfer): void {
      target.postMessage(message, [...transfer]);
    },
    subscribe(listener): () => void {
      const handler = (event: BridgeMessageEventLike): void => {
        listener(event.data);
      };
      target.addEventListener("message", handler);
      return () => {
        target.removeEventListener("message", handler);
      };
    },
  };
}

/**
 * Wraps a `MessagePort`, starting it on the first subscription.
 *
 * A port queues its messages until `start()` and delivers nothing before then,
 * so a transport that never started is a transport that looks connected and
 * silently receives nothing. Starting on subscribe rather than on construction
 * keeps the queued messages: everything sent before the endpoint existed is
 * delivered to it, rather than to a listener that was not registered yet.
 */
export function createMessagePortTransport(
  port: BridgePortLike,
): BridgeTransport {
  const target = createMessageTargetTransport(port);
  let started = false;
  return {
    post(message, transfer): void {
      target.post(message, transfer);
    },
    subscribe(listener): () => void {
      const unsubscribe = target.subscribe(listener);
      if (!started) {
        started = true;
        port.start();
      }
      return unsubscribe;
    },
  };
}

/**
 * Narrows a worker's ambient global to a message target.
 *
 * The worker entry has to reach `globalThis` for its scope, and the type it
 * gets there is whatever `lib` the package compiles with - which is the wrong
 * one (see this module's header). Rather than assert, check: the guard is also
 * the error a developer gets when the worker entry is imported on the main
 * thread by accident, which is otherwise a `postMessage` that quietly posts to
 * the window and a runtime that never answers anything.
 */
export function resolveWorkerScopeTransport(scope: unknown): BridgeTransport {
  if (!isMessageTarget(scope)) {
    throw new Error(
      "The runtime worker entry was loaded outside a dedicated worker scope",
    );
  }
  return createMessageTargetTransport(scope);
}

function isMessageTarget(value: unknown): value is BridgeMessageTargetLike {
  if (typeof value !== "object" || value === null) return false;
  return (
    hasFunction(value, "postMessage") &&
    hasFunction(value, "addEventListener") &&
    hasFunction(value, "removeEventListener")
  );
}

/**
 * `Reflect.get` rather than an index read, so the members a real global scope
 * inherits from its prototype are found. An own-property check answers `false`
 * for every genuine `DedicatedWorkerGlobalScope`.
 */
function hasFunction(value: object, member: string): boolean {
  return typeof Reflect.get(value, member) === "function";
}
