import { createContext, useContext, useEffect, useState } from "react";
import type { TierModelIdentity } from "@traycer/protocol/host/fallback-policy";

/**
 * Which "one model, one tier" conflicts the panel has already ANNOUNCED.
 *
 * The spec puts `role="alert"` on a conflict block on its FIRST appearance
 * only (§Accessibility). A permanent alert re-interrupts on every mount, and
 * a block mounts far more often than a conflict appears: the Equivalent
 * models tab unmounts when the user leaves it (`TabsContent` has no
 * `forceMount`), so every return re-inserts every block, and deleting an
 * unrelated tier re-keys a block and mounts it again. A screen reader then
 * reads the same two conflicts out on every visit.
 *
 * So the panel holds this for its lifetime, and a block that mounts for a
 * conflict already in it renders without the role. It is keyed by what the
 * conflict IS - harness, model slug and the set of tier ids involved - never
 * by an index, which a deletion shifts.
 */
export interface FallbackConflictAnnouncements {
  readonly announced: (key: string) => boolean;
  readonly markAnnounced: (key: string) => void;
}

export function createFallbackConflictAnnouncements(): FallbackConflictAnnouncements {
  const seen = new Set<string>();
  return {
    announced: (key) => seen.has(key),
    markAnnounced: (key) => {
      seen.add(key);
    },
  };
}

/**
 * `null` outside the panel - a card rendered on its own - where every block
 * is a first appearance, which is what a card without a history is.
 */
export const FallbackConflictAnnouncementsContext =
  createContext<FallbackConflictAnnouncements | null>(null);

/**
 * One key per model the block names: the same conflict whichever row draws it
 * and wherever its tiers sit in the list. JSON rather than a joined string,
 * because a slug and a tier id are free text and no separator is safe.
 */
export function conflictAnnouncementKeys(input: {
  readonly harnessId: string;
  readonly models: readonly TierModelIdentity[];
  readonly tierIds: readonly string[];
}): readonly string[] {
  const tiers = [...new Set(input.tierIds)].sort();
  return input.models.map((model) =>
    JSON.stringify([input.harnessId, model.slug.toLowerCase(), tiers]),
  );
}

/**
 * Whether the block mounting now is its conflict's first appearance in this
 * panel - decided ONCE, at mount, and kept for the block's lifetime, so a
 * block does not lose its role (or gain one) under the reader mid-life.
 *
 * The keys are recorded after the block commits, and again whenever they
 * change while it is mounted (a tier renamed under it): the conflict the user
 * has been shown is the one that must not be re-announced.
 */
export function useConflictFirstAppearance(keys: readonly string[]): boolean {
  const registry = useContext(FallbackConflictAnnouncementsContext);
  const [first] = useState(
    () => registry === null || keys.some((key) => !registry.announced(key)),
  );
  // A stable dependency for the key list, which is a fresh array per render.
  // A JSON key never contains a raw newline (JSON escapes it), so the join and
  // the split below are exact inverses.
  const joined = keys.join("\n");
  useEffect(() => {
    if (registry === null || joined === "") return;
    for (const key of joined.split("\n")) registry.markAnnounced(key);
  }, [registry, joined]);
  return first;
}
