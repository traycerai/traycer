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
 * This is the error a developer gets when the worker entry is imported on the
 * main thread by accident, which is otherwise a `postMessage` that quietly
 * posts to the window and a runtime that never answers anything.
 *
 * **The message-target shape alone cannot decide this**, and used to be all
 * this checked. Every `Window` has `postMessage`, `addEventListener` and
 * `removeEventListener`, so the main-thread import the guard exists to catch
 * walked straight through it and produced exactly the silent runtime described
 * above. The discriminators below were measured rather than reasoned about,
 * in Chromium (what the desktop renderer is) and in the two test scopes:
 *
 * | member          | Window | DedicatedWorkerGlobalScope | jsdom window | `@vitest/web-worker` `self` |
 * | --------------- | ------ | -------------------------- | ------------ | --------------------------- |
 * | `document`      | yes    | **no**                     | yes          | yes (via prototype)         |
 * | `importScripts` | no     | **yes**                    | no           | no                          |
 * | `postMessage.length` | 1 | 1                          | 2            | 0                           |
 *
 * Read the third row before reaching for it: the arity that looks like a
 * discriminator is 1 on BOTH real scopes, and the values that differ (2, 0)
 * are artifacts of jsdom and of the worker shim. A guard built on it would
 * pass its tests and be inert in production.
 *
 * `importScripts` is present on `WorkerGlobalScope.prototype` for MODULE
 * workers too - it throws when called, but it is there, and the worker we
 * spawn is a module worker. That is why the positive marker is safe to require
 * rather than only asserting `document` away: a bare object carrying three
 * function members is not an ambient worker scope either, and this function's
 * job is to resolve exactly that.
 *
 * The shim's `self` fails both markers, so no suite can boot the real entry;
 * see this package's worker tests for what is pinned in its place.
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

/** The two markers from the table above, in the order that reads best. */
function isWorkerGlobalScope(value: object): boolean {
  return !hasDefined(value, "document") && hasFunction(value, "importScripts");
}

/**
 * `Reflect.get` rather than an index read, so the members a real global scope
 * inherits from its prototype are found. An own-property check answers `false`
 * for every genuine `DedicatedWorkerGlobalScope`.
 */
function hasFunction(value: object, member: string): boolean {
  return typeof Reflect.get(value, member) === "function";
}

/**
 * Prototype-walking too, and for a sharper reason: the worker shim's `self` is
 * a plain object whose prototype IS the jsdom global, so its `document` is
 * reachable only through the chain. An own-property check would call that
 * scope a worker.
 */
function hasDefined(value: object, member: string): boolean {
  return Reflect.get(value, member) !== undefined;
}
