/** Adapters from the real message targets onto {@link BridgeTransport}. */
import type { BridgeTransport } from "./bridge-endpoint";

export interface BridgeMessageEventLike {
  readonly data: unknown;
}

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
 * A port queues its messages until `start()` and delivers nothing before then, so a transport that never started is a transport that looks connected and silently receives nothing.
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
 * This is the error a developer gets when the worker entry is imported on the main thread by accident, which is otherwise a `postMessage` that quietly posts to the window and a runtime that never answers anything.
 */
export function resolveWorkerScopeTransport(scope: unknown): BridgeTransport {
  if (!isMessageTarget(scope)) {
    throw new Error(
      "epic-runtime-worker-entry: the runtime worker entry was loaded on a " +
        "scope that cannot send or receive messages",
    );
  }
  if (!isWorkerGlobalScope(scope)) {
    throw new Error(
      "epic-runtime-worker-entry was loaded on the main thread. This module " +
        "is a dedicated worker's entry point and must only be reached by " +
        "spawning it as a worker; on a window its frames post into the page " +
        "and the runtime answers nothing.",
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

function isWorkerGlobalScope(value: object): boolean {
  return !hasDefined(value, "document") && hasFunction(value, "importScripts");
}

/**
 * `Reflect.get` rather than an index read, so the members a real global scope inherits from its prototype are found.
 */
function hasFunction(value: object, member: string): boolean {
  return typeof Reflect.get(value, member) === "function";
}

/**
 * Prototype-walking too, and for a sharper reason: the worker shim's `self` is a plain object whose prototype IS the jsdom global, so its `document` is reachable only through the chain.
 */
function hasDefined(value: object, member: string): boolean {
  return Reflect.get(value, member) !== undefined;
}
