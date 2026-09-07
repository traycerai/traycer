/**
 * A `Worker`-shaped message target over a {@link FakeBridgePair}'s main side.
 * It lives here rather than inside one suite because there are now two callers - the spawner's own tests and gui-app's vitest setup file, which installs a default worker factory so no suite needs its own `beforeEach`.
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
      // Only `ArrayBuffer`s survive as transfers here.
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
