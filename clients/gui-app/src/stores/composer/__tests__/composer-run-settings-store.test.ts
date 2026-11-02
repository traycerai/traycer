import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  COMPOSER_RUN_SETTINGS_EPIC_CAP,
  migrateComposerRunSettingsPersistedState,
  useComposerRunSettingsStore,
} from "@/stores/composer/composer-run-settings-store";
import { composerRunSettingsKey } from "@/lib/persist";

const STORAGE_KEY = composerRunSettingsKey(null);

// Two distinct hosts so a test can prove a read/write on one never leaks
// into the other, and that a host with no entry of its own falls through to
// the frozen `legacy*` fields.
const HOST_A = "host-a";
const HOST_B = "host-b";

const REGULAR_RUN_SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const EPIC_RUN_SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "sonnet-4.5",
  permissionMode: "full_access",
  reasoningEffort: "high",
  serviceTier: "flex",
  agentMode: "epic",
  profileId: null,
};

function resetComposerRunSettingsStore(): void {
  window.localStorage.clear();
  useComposerRunSettingsStore.persist.setOptions({ name: STORAGE_KEY });
  useComposerRunSettingsStore.getState().resetForTests();
}

function persistState(state: unknown): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      state,
      version: 1,
    }),
  );
}

describe("composer run settings store", () => {
  beforeEach(resetComposerRunSettingsStore);
  afterEach(resetComposerRunSettingsStore);

  it("rehydrates persisted global settings into the legacy fallback via default hydration", async () => {
    persistState({
      globalLastRunSettings: REGULAR_RUN_SETTINGS,
      epicRunSettingsByEpicId: {},
    });

    await useComposerRunSettingsStore.persist.rehydrate();

    expect(
      useComposerRunSettingsStore.getState().legacyGlobalLastRunSettings,
    ).toEqual(REGULAR_RUN_SETTINGS);
    expect(
      useComposerRunSettingsStore.getState().globalLastRunSettingsByHostId,
    ).toEqual({});
  });

  it("rehydrates persisted per-epic entries into the legacy fallback via default hydration", async () => {
    persistState({
      globalLastRunSettings: null,
      epicRunSettingsByEpicId: {
        "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 10 },
      },
    });

    await useComposerRunSettingsStore.persist.rehydrate();

    expect(
      useComposerRunSettingsStore.getState().legacyEpicRunSettingsByEpicId,
    ).toEqual({
      "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 10 },
    });
    expect(
      useComposerRunSettingsStore.getState().epicRunSettingsByEpicHost,
    ).toEqual({});
  });

  it("setGlobalRunSettings does not alter per-epic entries", () => {
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", HOST_A, EPIC_RUN_SETTINGS, 10);

    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(HOST_A, REGULAR_RUN_SETTINGS, 20);

    expect(
      useComposerRunSettingsStore.getState().epicRunSettingsByEpicHost,
    ).toEqual({
      "epic-1 host-a": { settings: EPIC_RUN_SETTINGS, updatedAt: 10 },
    });
  });

  it("setGlobalRunSettings ignores unresolved model settings", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(HOST_A, REGULAR_RUN_SETTINGS, 10);

    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(HOST_A, { ...EPIC_RUN_SETTINGS, model: "" }, 20);

    expect(
      useComposerRunSettingsStore.getState().globalLastRunSettingsByHostId[
        HOST_A
      ],
    ).toEqual(REGULAR_RUN_SETTINGS);
  });

  it("setEpicRunSettings does not alter global settings", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(HOST_A, REGULAR_RUN_SETTINGS, 10);

    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", HOST_A, EPIC_RUN_SETTINGS, 20);

    expect(
      useComposerRunSettingsStore.getState().globalLastRunSettingsByHostId[
        HOST_A
      ],
    ).toEqual(REGULAR_RUN_SETTINGS);
  });

  it("setEpicRunSettings ignores unresolved model settings", () => {
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", HOST_A, EPIC_RUN_SETTINGS, 10);

    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings(
        "epic-1",
        HOST_A,
        { ...REGULAR_RUN_SETTINGS, model: "" },
        20,
      );

    expect(
      useComposerRunSettingsStore.getState().epicRunSettingsByEpicHost,
    ).toEqual({
      "epic-1 host-a": { settings: EPIC_RUN_SETTINGS, updatedAt: 10 },
    });
  });

  it("cap keeps only the newest 200 entries", () => {
    for (
      let index = 0;
      index < COMPOSER_RUN_SETTINGS_EPIC_CAP + 1;
      index += 1
    ) {
      useComposerRunSettingsStore
        .getState()
        .setEpicRunSettings(
          `epic-${index}`,
          HOST_A,
          REGULAR_RUN_SETTINGS,
          index,
        );
    }

    const entries =
      useComposerRunSettingsStore.getState().epicRunSettingsByEpicHost;
    expect(Object.keys(entries)).toHaveLength(COMPOSER_RUN_SETTINGS_EPIC_CAP);
    expect(entries[`epic-0 ${HOST_A}`]).toBeUndefined();
    expect(entries[`epic-${COMPOSER_RUN_SETTINGS_EPIC_CAP} ${HOST_A}`]).toEqual(
      {
        settings: REGULAR_RUN_SETTINGS,
        updatedAt: COMPOSER_RUN_SETTINGS_EPIC_CAP,
      },
    );
  });

  it("caps each host's epics independently - a second host never evicts the first's", () => {
    // Host A is filled to exactly the cap, then host B is written to. A flat
    // cap over the (epic, host) map would start evicting host A's oldest epic
    // on B's very first write, so merely enrolling a machine would shrink
    // every other machine's memory.
    for (let index = 0; index < COMPOSER_RUN_SETTINGS_EPIC_CAP; index += 1) {
      useComposerRunSettingsStore
        .getState()
        .setEpicRunSettings(
          `epic-${index}`,
          HOST_A,
          REGULAR_RUN_SETTINGS,
          index,
        );
    }

    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-on-b", HOST_B, EPIC_RUN_SETTINGS, 1);

    const entries =
      useComposerRunSettingsStore.getState().epicRunSettingsByEpicHost;
    expect(Object.keys(entries)).toHaveLength(
      COMPOSER_RUN_SETTINGS_EPIC_CAP + 1,
    );
    // `epic-0` is host A's oldest and would be the first casualty of a shared
    // cap; `updatedAt: 1` also makes it older than host B's write.
    expect(entries[`epic-0 ${HOST_A}`]).toEqual({
      settings: REGULAR_RUN_SETTINGS,
      updatedAt: 0,
    });
    expect(entries[`epic-on-b ${HOST_B}`]).toEqual({
      settings: EPIC_RUN_SETTINGS,
      updatedAt: 1,
    });

    // Overflowing host A still evicts within host A only.
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings(
        "epic-overflow",
        HOST_A,
        REGULAR_RUN_SETTINGS,
        COMPOSER_RUN_SETTINGS_EPIC_CAP,
      );

    const after =
      useComposerRunSettingsStore.getState().epicRunSettingsByEpicHost;
    expect(Object.keys(after)).toHaveLength(COMPOSER_RUN_SETTINGS_EPIC_CAP + 1);
    expect(after[`epic-0 ${HOST_A}`]).toBeUndefined();
    expect(after[`epic-on-b ${HOST_B}`]).toEqual({
      settings: EPIC_RUN_SETTINGS,
      updatedAt: 1,
    });
  });

  it("clearEpicRunSettings removes only requested epic ids", () => {
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", HOST_A, REGULAR_RUN_SETTINGS, 10);
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-2", HOST_A, EPIC_RUN_SETTINGS, 20);

    useComposerRunSettingsStore.getState().clearEpicRunSettings(["epic-1"]);

    expect(
      useComposerRunSettingsStore.getState().epicRunSettingsByEpicHost,
    ).toEqual({
      "epic-2 host-a": { settings: EPIC_RUN_SETTINGS, updatedAt: 20 },
    });
  });

  it("auth bucket helper returns anonymous and email-scoped keys", () => {
    expect(composerRunSettingsKey(null)).toBe(
      "traycer-gui-app:composer-run-settings:anon",
    );
    expect(composerRunSettingsKey("alice@example.com")).toBe(
      "traycer-gui-app:composer-run-settings:alice@example.com",
    );
  });

  describe("v1 -> v2 host-scoping migration", () => {
    it("moves flat v1 data into the legacy fields with empty per-host maps", () => {
      const migrated = migrateComposerRunSettingsPersistedState({
        globalLastRunSettings: REGULAR_RUN_SETTINGS,
        epicRunSettingsByEpicId: {
          "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 10 },
        },
      });

      expect(migrated).toEqual({
        globalLastRunSettingsByHostId: {},
        epicRunSettingsByEpicHost: {},
        legacyGlobalLastRunSettings: REGULAR_RUN_SETTINGS,
        legacyEpicRunSettingsByEpicId: {
          "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 10 },
        },
      });
    });

    it("drops invalid persisted entries instead of throwing", () => {
      const migrated = migrateComposerRunSettingsPersistedState({
        // Fails `chatRunSettingsSchema` (`model: z.string().min(1)`).
        globalLastRunSettings: { ...REGULAR_RUN_SETTINGS, model: "" },
        epicRunSettingsByEpicId: {
          "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 10 },
          "epic-2": {
            settings: { ...EPIC_RUN_SETTINGS, model: "" },
            updatedAt: 20,
          },
          "epic-3": { settings: EPIC_RUN_SETTINGS, updatedAt: "not-a-number" },
          "epic-4": "not-a-record",
        },
      });

      expect(migrated.legacyGlobalLastRunSettings).toBeNull();
      expect(migrated.legacyEpicRunSettingsByEpicId).toEqual({
        "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 10 },
      });
    });

    it("returns empty state for non-record input", () => {
      const empty = {
        globalLastRunSettingsByHostId: {},
        epicRunSettingsByEpicHost: {},
        legacyGlobalLastRunSettings: null,
        legacyEpicRunSettingsByEpicId: {},
      };
      expect(migrateComposerRunSettingsPersistedState(null)).toEqual(empty);
      expect(migrateComposerRunSettingsPersistedState("not-a-record")).toEqual(
        empty,
      );
      expect(migrateComposerRunSettingsPersistedState(undefined)).toEqual(
        empty,
      );
    });
  });

  describe("per-host isolation", () => {
    it("getGlobalRunSettings falls back to the legacy global settings when the host has no entry", () => {
      useComposerRunSettingsStore
        .getState()
        .setGlobalRunSettings(HOST_A, REGULAR_RUN_SETTINGS, 10);

      expect(
        useComposerRunSettingsStore.getState().getGlobalRunSettings(HOST_B),
      ).toBeNull();
      expect(
        useComposerRunSettingsStore.getState().getGlobalRunSettings(HOST_A),
      ).toEqual(REGULAR_RUN_SETTINGS);
    });

    it("getGlobalRunSettings falls back to the legacy value (not another host's) when one is present", () => {
      useComposerRunSettingsStore.setState({
        legacyGlobalLastRunSettings: EPIC_RUN_SETTINGS,
      });
      useComposerRunSettingsStore
        .getState()
        .setGlobalRunSettings(HOST_A, REGULAR_RUN_SETTINGS, 10);

      expect(
        useComposerRunSettingsStore.getState().getGlobalRunSettings(HOST_A),
      ).toEqual(REGULAR_RUN_SETTINGS);
      expect(
        useComposerRunSettingsStore.getState().getGlobalRunSettings(HOST_B),
      ).toEqual(EPIC_RUN_SETTINGS);
      expect(
        useComposerRunSettingsStore.getState().getGlobalRunSettings(null),
      ).toEqual(EPIC_RUN_SETTINGS);
    });

    it("getEpicRunSettings falls back per (epic, host) to the legacy epic map", () => {
      useComposerRunSettingsStore.setState({
        legacyEpicRunSettingsByEpicId: {
          "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 1 },
        },
      });
      useComposerRunSettingsStore
        .getState()
        .setEpicRunSettings("epic-1", HOST_A, REGULAR_RUN_SETTINGS, 10);

      expect(
        useComposerRunSettingsStore
          .getState()
          .getEpicRunSettings("epic-1", HOST_A),
      ).toEqual(REGULAR_RUN_SETTINGS);
      expect(
        useComposerRunSettingsStore
          .getState()
          .getEpicRunSettings("epic-1", HOST_B),
      ).toEqual(EPIC_RUN_SETTINGS);
      expect(
        useComposerRunSettingsStore
          .getState()
          .getEpicRunSettings("epic-2", HOST_B),
      ).toBeNull();
    });

    it("clearEpicRunSettings removes the epic across every host bucket and the legacy fallback", () => {
      useComposerRunSettingsStore.setState({
        legacyEpicRunSettingsByEpicId: {
          "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 1 },
        },
      });
      useComposerRunSettingsStore
        .getState()
        .setEpicRunSettings("epic-1", HOST_A, REGULAR_RUN_SETTINGS, 10);
      useComposerRunSettingsStore
        .getState()
        .setEpicRunSettings("epic-1", HOST_B, REGULAR_RUN_SETTINGS, 20);
      useComposerRunSettingsStore
        .getState()
        .setEpicRunSettings("epic-2", HOST_A, EPIC_RUN_SETTINGS, 30);

      useComposerRunSettingsStore.getState().clearEpicRunSettings(["epic-1"]);

      const state = useComposerRunSettingsStore.getState();
      expect(state.epicRunSettingsByEpicHost).toEqual({
        "epic-2 host-a": { settings: EPIC_RUN_SETTINGS, updatedAt: 30 },
      });
      expect(state.legacyEpicRunSettingsByEpicId).toEqual({});
    });

    // A Task deletion clears each tier in its own scope. Account-wide: every
    // host bucket and the legacy entry (above). Host-scoped (a local-homed
    // Task deleted on one host, whose id another host may still serve): that
    // host's bucket, after the host adopts the transitional legacy tier and
    // retires it, so the cleared entry cannot fall back to a legacy choice the
    // host had superseded (gui-app AGENTS.md, the legacy tier).
    describe("a host-scoped deletion", () => {
      function seedEveryTier(): void {
        useComposerRunSettingsStore.setState({
          legacyGlobalLastRunSettings: EPIC_RUN_SETTINGS,
          legacyEpicRunSettingsByEpicId: {
            "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 1 },
            "epic-3": { settings: EPIC_RUN_SETTINGS, updatedAt: 2 },
          },
        });
        useComposerRunSettingsStore
          .getState()
          .setEpicRunSettings("epic-1", HOST_A, REGULAR_RUN_SETTINGS, 10);
        useComposerRunSettingsStore
          .getState()
          .setEpicRunSettings("epic-1", HOST_B, REGULAR_RUN_SETTINGS, 20);
      }

      function clearOnHostA(): void {
        useComposerRunSettingsStore
          .getState()
          .clearEpicRunSettingsForHost(["epic-1"], HOST_A);
      }

      it("clears the deleting host's entry without falling back to the legacy one it superseded", () => {
        seedEveryTier();

        clearOnHostA();

        expect(
          useComposerRunSettingsStore
            .getState()
            .getEpicRunSettings("epic-1", HOST_A),
        ).toBeNull();
      });

      it("retires the legacy tier, so no host reads the deleted Task's legacy entry", () => {
        seedEveryTier();

        clearOnHostA();

        const state = useComposerRunSettingsStore.getState();
        expect(state.legacyEpicRunSettingsByEpicId).toEqual({});
        expect(state.legacyGlobalLastRunSettings).toBeNull();
        expect(state.getEpicRunSettings("epic-1", "host-never")).toBeNull();
      });

      it("adopts the rest of the legacy tier into the deleting host's bucket", () => {
        seedEveryTier();

        clearOnHostA();

        const state = useComposerRunSettingsStore.getState();
        expect(state.getEpicRunSettings("epic-3", HOST_A)).toEqual(
          EPIC_RUN_SETTINGS,
        );
        expect(state.getGlobalRunSettings(HOST_A)).toEqual(EPIC_RUN_SETTINGS);
      });

      it("keeps the deleting host's own global settings over the legacy ones", () => {
        seedEveryTier();
        useComposerRunSettingsStore
          .getState()
          .setGlobalRunSettings(HOST_A, REGULAR_RUN_SETTINGS, 5);

        clearOnHostA();

        expect(
          useComposerRunSettingsStore.getState().getGlobalRunSettings(HOST_A),
        ).toEqual(REGULAR_RUN_SETTINGS);
      });

      it("keeps another host's bucket, which that host still reads", () => {
        seedEveryTier();

        clearOnHostA();

        expect(
          useComposerRunSettingsStore
            .getState()
            .getEpicRunSettings("epic-1", HOST_B),
        ).toEqual(REGULAR_RUN_SETTINGS);
      });

      // The per-host cap runs once, on the final set, after the deletion:
      // never on the adopted set before it.
      describe("the cap", () => {
        function seedLegacy(count: number): void {
          useComposerRunSettingsStore.setState({
            legacyEpicRunSettingsByEpicId: Object.fromEntries(
              Array.from({ length: count }, (_, index) => [
                `legacy-${String(index + 1)}`,
                { settings: EPIC_RUN_SETTINGS, updatedAt: index + 1 },
              ]),
            ),
          });
        }

        function hostAEpicIds(): string[] {
          return Object.keys(
            useComposerRunSettingsStore.getState().epicRunSettingsByEpicHost,
          )
            .filter((key) => key.endsWith(` ${HOST_A}`))
            .map((key) => key.slice(0, key.indexOf(" ")));
        }

        it("does not evict a survivor for an entry the same sweep deletes", () => {
          seedLegacy(COMPOSER_RUN_SETTINGS_EPIC_CAP);
          useComposerRunSettingsStore
            .getState()
            .setEpicRunSettings(
              "epic-new",
              HOST_A,
              REGULAR_RUN_SETTINGS,
              COMPOSER_RUN_SETTINGS_EPIC_CAP + 1,
            );

          useComposerRunSettingsStore
            .getState()
            .clearEpicRunSettingsForHost(
              [`legacy-${String(COMPOSER_RUN_SETTINGS_EPIC_CAP)}`],
              HOST_A,
            );

          const kept = hostAEpicIds();
          expect(kept).toHaveLength(COMPOSER_RUN_SETTINGS_EPIC_CAP);
          expect(kept).toContain("legacy-1");
          expect(kept).toContain("epic-new");
        });

        it.each([
          [COMPOSER_RUN_SETTINGS_EPIC_CAP - 1, false],
          [COMPOSER_RUN_SETTINGS_EPIC_CAP - 1, true],
          [COMPOSER_RUN_SETTINGS_EPIC_CAP, false],
          [COMPOSER_RUN_SETTINGS_EPIC_CAP, true],
          [COMPOSER_RUN_SETTINGS_EPIC_CAP + 1, false],
          [COMPOSER_RUN_SETTINGS_EPIC_CAP + 1, true],
        ])(
          "adopting %i legacy entries (deleting the newest: %s) keeps the newest that fit",
          (count, deleteNewest) => {
            seedLegacy(count);

            useComposerRunSettingsStore
              .getState()
              .clearEpicRunSettingsForHost(
                [deleteNewest ? `legacy-${String(count)}` : "epic-absent"],
                HOST_A,
              );

            const survivors = deleteNewest ? count - 1 : count;
            const expected = Math.min(
              survivors,
              COMPOSER_RUN_SETTINGS_EPIC_CAP,
            );
            const kept = hostAEpicIds();
            expect(kept).toHaveLength(expected);
            // The ones kept are the newest survivors.
            const oldestKept = survivors - expected + 1;
            expect(kept).toContain(`legacy-${String(oldestKept)}`);
            expect(kept).not.toContain(`legacy-${String(oldestKept - 1)}`);
            expect(kept).not.toContain(
              deleteNewest ? `legacy-${String(count)}` : "epic-absent",
            );
          },
        );
      });

      it("leaves other epics on the deleting host alone", () => {
        seedEveryTier();
        useComposerRunSettingsStore
          .getState()
          .setEpicRunSettings("epic-2", HOST_A, EPIC_RUN_SETTINGS, 30);

        clearOnHostA();

        expect(
          useComposerRunSettingsStore
            .getState()
            .getEpicRunSettings("epic-2", HOST_A),
        ).toEqual(EPIC_RUN_SETTINGS);
      });
    });

    it("setGlobalRunSettings / setEpicRunSettings are no-ops when hostId is null", () => {
      useComposerRunSettingsStore
        .getState()
        .setGlobalRunSettings(null, REGULAR_RUN_SETTINGS, 10);
      useComposerRunSettingsStore
        .getState()
        .setEpicRunSettings("epic-1", null, EPIC_RUN_SETTINGS, 10);

      expect(
        useComposerRunSettingsStore.getState().globalLastRunSettingsByHostId,
      ).toEqual({});
      expect(
        useComposerRunSettingsStore.getState().epicRunSettingsByEpicHost,
      ).toEqual({});
    });
  });
});
