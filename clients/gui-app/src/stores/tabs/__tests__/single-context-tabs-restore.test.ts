import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTabsStore } from "@/stores/tabs/store";
import {
  resetTabsLocalRestorePolicyForTests,
  suppressTabsLocalRestore,
} from "@/stores/tabs/tabs-local-restore-policy";

/**
 * The restart probe: a layout is already in this origin's storage when the
 * document loads.
 *
 * This is the failure the write half alone does not close. Stopping new writes
 * leaves whatever is already there to be read back, and the read is the half
 * a person sees - a freshly opened tab showing a different tab's active
 * surface, behind chrome that is no longer drawn, with nothing on screen to
 * explain it or change it.
 */
const TABS_STORAGE_KEY = "traycer-gui-app:tabs";

/**
 * A v2 payload naming a remembered surface - the shape this store writes and
 * reads back. A system tab is used rather than an epic tab because it carries
 * its own contents: nothing cross-checks it, so what comes back is exactly
 * what the read produced and not a sanitizer's opinion of it.
 */
const SEEDED_SETTINGS_PATH = "/settings/keybindings";

/**
 * The bytes a previous context left behind, produced by THIS store's own
 * writer rather than hand-written here.
 *
 * Hand-writing the payload would make the probe an assertion about a shape
 * guessed in a test file; letting the store write it makes it an assertion
 * about the bytes the app actually leaves on an origin. The state is put back
 * afterwards, so only the captured string carries the seeded surface.
 */
function captureSeedFromStore(): string {
  useTabsStore.setState({
    systemTabs: {
      history: null,
      settings: {
        id: "settings",
        kind: "settings",
        name: "Seeded elsewhere",
        lastPath: SEEDED_SETTINGS_PATH,
      },
    },
  });
  const seeded = window.localStorage.getItem(TABS_STORAGE_KEY);
  if (seeded === null)
    throw new Error("the store wrote no layout to seed from");
  useTabsStore.setState({ systemTabs: { history: null, settings: null } });
  return seeded;
}

function seedPersistedLayout(seed: string): void {
  window.localStorage.setItem(TABS_STORAGE_KEY, seed);
}

function restoredSettingsPath(): string | null {
  return useTabsStore.getState().systemTabs.settings?.lastPath ?? null;
}

/**
 * What a reload does: the store re-reads storage through the same path it uses
 * while being created.
 */
async function restart(): Promise<void> {
  await useTabsStore.persist.rehydrate();
}

describe("single-context tab restore", () => {
  beforeEach(() => {
    resetTabsLocalRestorePolicyForTests();
    window.localStorage.clear();
  });

  afterEach(() => {
    resetTabsLocalRestorePolicyForTests();
    window.localStorage.clear();
  });

  it("restores a seeded layout on a shell that keeps its own tabs", async () => {
    // The control. Without it, the assertion below could pass against a seed
    // the store never restores from under ANY policy - which would make the
    // suppression look effective while proving nothing.
    seedPersistedLayout(captureSeedFromStore());

    await restart();

    expect(restoredSettingsPath()).toBe(SEEDED_SETTINGS_PATH);
  });

  it("restores nothing once this shell has suppressed the read", async () => {
    const seed = captureSeedFromStore();
    seedPersistedLayout(seed);
    suppressTabsLocalRestore();

    await restart();

    expect(restoredSettingsPath()).not.toBe(SEEDED_SETTINGS_PATH);
  });

  it("leaves the stored bytes alone rather than clearing them", async () => {
    const seed = captureSeedFromStore();
    seedPersistedLayout(seed);
    suppressTabsLocalRestore();

    await restart();

    // Suppressing a read is not a migration. Another shell on this origin -
    // a desktop build opened against the same profile, a future change of
    // posture - is entitled to its own answer about these bytes, and a
    // silent delete here would take that away.
    expect(window.localStorage.getItem(TABS_STORAGE_KEY)).toBe(seed);
  });
});
