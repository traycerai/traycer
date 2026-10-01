/**
 * What the unrecorded-prompt handoff leaves behind.
 *
 * Read from the REAL landing draft store rather than a mock, because the
 * handoff's last step is a synchronous `installLandingDraft` - there is no
 * async durable write left to stub out, and the store IS the assertion
 * surface. The retired prompt stash needed a mock here for a reason that no
 * longer applies: its save awaited `hydrate()` against an IndexedDB connection
 * opened at module load, before any `beforeEach` could install a fake factory.
 */
import { expect, vi } from "vitest";
import {
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import type { JsonContent } from "@traycer/protocol/common/registry";

/**
 * Every closed start-page draft in the store, in install order. A handoff
 * installs `closed: true` and never touches `activeDraftId`, so an ordinary
 * open draft a test set up itself is not one of these.
 */
export function handedOffDrafts(): ReadonlyArray<LandingDraftTab> {
  return useLandingDraftStore.getState().drafts.filter((draft) => draft.closed);
}

/** Drops every row, so one test's handoffs are not visible to the next. */
export function resetHandedOffDrafts(): void {
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
}

/**
 * Waits for a handed-off draft whose content contains `needle`, and answers
 * its content as JSON.
 *
 * Matched on the NEEDLE, never on "a draft exists". The handoff is
 * fire-and-forget and resolves images first, so a previous test's disposal can
 * land its install after this test's `beforeEach` has cleared the store - and
 * a bare "something is in there" wait then passes on that stray row while the
 * one under test is still resolving.
 */
export async function waitForHandedOffDraft(
  needle: string,
  timeoutMs: number,
): Promise<string> {
  let found = "";
  await vi.waitFor(
    () => {
      const match = handedOffDrafts().find((draft) =>
        JSON.stringify(draft.content).includes(needle),
      );
      expect(match).toBeDefined();
      if (match === undefined) return;
      found = JSON.stringify(match.content);
    },
    { timeout: timeoutMs },
  );
  return found;
}

/** Every text run in a document, concatenated - enough to assert on a prompt. */
export function draftPlainText(content: JsonContent): string {
  const out: string[] = [];
  const walk = (node: JsonContent): void => {
    if (typeof node.text === "string") out.push(node.text);
    for (const child of node.content ?? []) walk(child);
  };
  walk(content);
  return out.join("");
}
