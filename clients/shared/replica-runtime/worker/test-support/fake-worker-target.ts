/**
 * A `Worker`-shaped message target over a {@link FakeBridgePair}'s main side.
 *
 * jsdom has no `Worker`, so every suite that spawns one supplies a constructor.
 * This is the adapter that makes the fake pair look like the real thing to
 * `spawnEpicRuntimeWorker`: the caller posts into `pair.main`, and what the
 * worker side posts back arrives as a `message` event.
 *
 * It lives here rather than inside one suite because there are now two callers
 * — the spawner's own tests and gui-app's vitest setup file, which installs a
 * default worker factory so no suite needs its own `beforeEach`. Two copies of
 * a transport adapter is two places for the transfer-list handling below to
 * drift.
 */
import type {
  BridgeMessageEventLike,
  BridgeMessageTargetLike,
} from "../bridge-transports";
import type { FakeBridgePair } from "./fake-bridge-pair";

export function createFakeWorkerTarget(
  pair: FakeBridgePair,
): BridgeMessageTargetLike {
  const listeners = new Set<(event: BridgeMessageEventLike) => void>();
  pair.main.subscribe((message) => {
    const event: BridgeMessageEventLike = { data: message };
    // Copied before iterating: a listener that removes itself while being
    // notified would otherwise mutate the set mid-walk.
    for (const listener of [...listeners]) listener(event);
  });
  return {
    postMessage(message, transfer): void {
      // Only `ArrayBuffer`s survive as transfers here. The real `postMessage`
      // accepts other transferables, but the fake pair's `post` moves buffers
      // and nothing else, and silently passing a `MessagePort` through as if
      // it were transferred would make a suite pass on a frame the real
      // structured clone would reject.
      const buffers = transfer.filter(
        (value): value is ArrayBuffer => value instanceof ArrayBuffer,
      );
      pair.main.post(message, buffers);
    },
    addEventListener(
      _type: "message",
      listener: (event: BridgeMessageEventLike) => void,
    ): void {
      listeners.add(listener);
    },
    removeEventListener(
      _type: "message",
      listener: (event: BridgeMessageEventLike) => void,
    ): void {
      listeners.delete(listener);
    },
  };
}
