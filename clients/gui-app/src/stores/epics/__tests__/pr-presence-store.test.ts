import { beforeEach, describe, expect, it } from "vitest";
import {
  migratePrPresencePersistedState,
  PR_PRESENCE_PERSIST_KEY,
  prPresenceScopeKey,
  selectPrScopeHasItems,
  usePrPresenceStore,
} from "@/stores/epics/pr-presence-store";

const PERSISTED_CURRENT_VERSION = 1;

const HOST_ID = "host-1";
const EPIC_ID = "epic-1";

describe("pr presence store", () => {
  beforeEach(() => {
    usePrPresenceStore.setState({ hasItemsByScopeKey: {} });
  });

  it("reads false for a scope no frame has ever been recorded for", () => {
    // The whole point of the epic-open change: an unobserved epic must not
    // claim to have PRs, because nothing fetches on its behalf any more.
    expect(
      selectPrScopeHasItems(HOST_ID, EPIC_ID)(usePrPresenceStore.getState()),
    ).toBe(false);
  });

  it("records presence from a frame that carried at least one PR", () => {
    usePrPresenceStore.getState().recordPrPresence(HOST_ID, EPIC_ID, true);

    expect(
      selectPrScopeHasItems(HOST_ID, EPIC_ID)(usePrPresenceStore.getState()),
    ).toBe(true);
  });

  it("clears presence when the epic stops deriving any PR", () => {
    usePrPresenceStore.getState().recordPrPresence(HOST_ID, EPIC_ID, true);
    usePrPresenceStore.getState().recordPrPresence(HOST_ID, EPIC_ID, false);

    // Follows the live list rather than latching on forever, so a PR that
    // stops being derived from the epic takes the rail icon with it.
    expect(
      selectPrScopeHasItems(HOST_ID, EPIC_ID)(usePrPresenceStore.getState()),
    ).toBe(false);
  });

  it("scopes presence per host so one machine cannot reveal another's panel", () => {
    usePrPresenceStore.getState().recordPrPresence(HOST_ID, EPIC_ID, true);

    expect(
      selectPrScopeHasItems(
        "other-host",
        EPIC_ID,
      )(usePrPresenceStore.getState()),
    ).toBe(false);
  });

  it("reads false when there is no active host", () => {
    usePrPresenceStore.getState().recordPrPresence(HOST_ID, EPIC_ID, true);

    expect(
      selectPrScopeHasItems(null, EPIC_ID)(usePrPresenceStore.getState()),
    ).toBe(false);
  });

  it("keeps the same state object when a repeated frame changes nothing", () => {
    usePrPresenceStore.getState().recordPrPresence(HOST_ID, EPIC_ID, true);
    const first = usePrPresenceStore.getState().hasItemsByScopeKey;
    usePrPresenceStore.getState().recordPrPresence(HOST_ID, EPIC_ID, true);

    // Identity, not equality: the panel re-emits on every poll tick, and a
    // fresh object each time would re-render every rail consumer for nothing.
    expect(usePrPresenceStore.getState().hasItemsByScopeKey).toBe(first);
  });

  it("separates ids that would collide under a naive separator", () => {
    // `a` + `b:c` and `a:b` + `c` must not land on one key.
    usePrPresenceStore.getState().recordPrPresence("a", "b:c", true);

    expect(
      selectPrScopeHasItems("a:b", "c")(usePrPresenceStore.getState()),
    ).toBe(false);
    expect(prPresenceScopeKey("a", "b:c")).not.toBe(
      prPresenceScopeKey("a:b", "c"),
    );
  });

  describe("persisted-state migration", () => {
    it("drops a persisted shape it does not recognise", () => {
      expect(migratePrPresencePersistedState({ nope: 1 })).toEqual({
        hasItemsByScopeKey: {},
      });
    });

    it("keeps only literal true, so a stale truthy value cannot reveal a panel", () => {
      const migrated = migratePrPresencePersistedState({
        hasItemsByScopeKey: {
          [prPresenceScopeKey(HOST_ID, EPIC_ID)]: true,
          "stale-truthy": 1,
          "stale-false": false,
        },
      });

      expect(migrated.hasItemsByScopeKey).toEqual({
        [prPresenceScopeKey(HOST_ID, EPIC_ID)]: true,
      });
    });
  });

  describe("rehydration at the current version", () => {
    beforeEach(() => {
      window.localStorage.clear();
    });

    // `migrate` only runs on a version mismatch, so persisted corruption
    // written under the CURRENT version would reach zustand's default merge
    // unsanitized without a `merge` option applying the same guard on every
    // rehydration. Driven through `persist.rehydrate()` rather than calling
    // `migratePrPresencePersistedState` directly - the helper alone would not
    // fail if `merge:` were deleted from the store's persist config.
    it("sanitizes a corrupted hasItemsByScopeKey even though the version already matches", async () => {
      window.localStorage.setItem(
        PR_PRESENCE_PERSIST_KEY,
        JSON.stringify({
          state: {
            hasItemsByScopeKey: {
              [prPresenceScopeKey(HOST_ID, EPIC_ID)]: true,
              "stale-non-boolean": "yes",
              "stale-false": false,
              "stale-number": 1,
            },
          },
          version: PERSISTED_CURRENT_VERSION,
        }),
      );

      await usePrPresenceStore.persist.rehydrate();

      expect(usePrPresenceStore.getState().hasItemsByScopeKey).toEqual({
        [prPresenceScopeKey(HOST_ID, EPIC_ID)]: true,
      });
    });

    it("sanitizes a hasItemsByScopeKey that is not even an object", async () => {
      window.localStorage.setItem(
        PR_PRESENCE_PERSIST_KEY,
        JSON.stringify({
          state: { hasItemsByScopeKey: "not-an-object" },
          version: PERSISTED_CURRENT_VERSION,
        }),
      );

      await usePrPresenceStore.persist.rehydrate();

      expect(usePrPresenceStore.getState().hasItemsByScopeKey).toEqual({});
    });

    it("keeps recordPrPresence working after a rehydration that sanitized corrupted state", async () => {
      window.localStorage.setItem(
        PR_PRESENCE_PERSIST_KEY,
        JSON.stringify({
          state: {
            hasItemsByScopeKey: { "stale-non-boolean": "yes" },
          },
          version: PERSISTED_CURRENT_VERSION,
        }),
      );

      await usePrPresenceStore.persist.rehydrate();

      // The custom `merge` must not drop the store's actions off the merged
      // state - only spread `hasItemsByScopeKey` from the sanitized shape.
      usePrPresenceStore.getState().recordPrPresence(HOST_ID, EPIC_ID, true);

      expect(
        selectPrScopeHasItems(HOST_ID, EPIC_ID)(usePrPresenceStore.getState()),
      ).toBe(true);
    });
  });
});
