import { expect } from "vitest";
import type { TabActivationIntent } from "@/lib/tab-navigation/intents";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface ExpectedArtifactOpen {
  readonly epicId: string;
  readonly artifactId: string;
  readonly title: string;
  /** The reference host the tile opens on, not the window's. */
  readonly hostId: string;
  /** The bot whose transcript the open returns to. */
  readonly botId: string;
}

/**
 * The one intent a live artifact card's Open handed the router boundary,
 * narrowed to the open-epic it must be and checked field by field.
 */
export function expectArtifactOpenIntent(
  calls: ReadonlyArray<readonly [TabActivationIntent]>,
  expected: ExpectedArtifactOpen,
): void {
  expect(calls).toHaveLength(1);
  const [[intent]] = calls;
  if (intent.kind !== "open-epic")
    throw new Error(`expected an open-epic intent, got ${intent.kind}`);
  const preparation = intent.preparation;
  if (preparation === null || preparation.kind !== "open-admitted-tile")
    throw new Error("expected an open-admitted-tile preparation");
  expect(intent.epicId).toBe(expected.epicId);
  expect(intent.focus?.focusArtifactId).toBe(expected.artifactId);
  expect(preparation.gesture).toBe("explicit");
  expect(preparation.node.id).toBe(expected.artifactId);
  expect(preparation.node.type).toBe("html");
  expect(preparation.node.name).toBe(expected.title);
  expect(preparation.node.hostId).toBe(expected.hostId);
  // The host the card was admitted on travels beside the node.
  expect(preparation.hostId).toBe(expected.hostId);
  expect(preparation.node.instanceId).toMatch(UUID);
  expect(intent.includeNestedFocus).toBe(true);
  expect(intent.tracyOrigin).toEqual({ botId: expected.botId });
}
