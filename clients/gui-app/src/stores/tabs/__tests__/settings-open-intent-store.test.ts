import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  acknowledgeSettingsOpenIntent,
  armSettingsOpenIntent,
  resetSettingsOpenIntentForTests,
  useSettingsOpenIntentStore,
  useSettingsOpenIntent,
} from "@/stores/tabs/settings-open-intent-store";
import type { OpenSettingsModalOpts } from "@/stores/tabs/system-overlay-types";

function opts(
  overrides: Partial<OpenSettingsModalOpts>,
): OpenSettingsModalOpts {
  return {
    section: "permissions",
    resetToGeneral: false,
    tab: null,
    draft: null,
    hostId: null,
    ...overrides,
  };
}

afterEach(() => {
  resetSettingsOpenIntentForTests();
});

describe("armSettingsOpenIntent", () => {
  it("records a tab and a draft under the named section", () => {
    armSettingsOpenIntent(
      opts({
        tab: "rules",
        draft: { section: "allow", text: "Force push for `git push --force`" },
      }),
    );

    const intent = useSettingsOpenIntentStore.getState().intent;
    expect(intent).not.toBeNull();
    expect(intent).toMatchObject({
      section: "permissions",
      tab: "rules",
      draft: { section: "allow", text: "Force push for `git push --force`" },
    });
  });

  it("increases the id on every arm, so the same tab/draft opened twice are two intents", () => {
    armSettingsOpenIntent(opts({ tab: "judge" }));
    const firstId = useSettingsOpenIntentStore.getState().intent?.id;

    armSettingsOpenIntent(opts({ tab: "judge" }));
    const secondId = useSettingsOpenIntentStore.getState().intent?.id;

    expect(firstId).not.toBeUndefined();
    expect(secondId).not.toBeUndefined();
    expect(secondId).not.toBe(firstId);
  });

  it("clears the pending intent when called with no tab and no draft", () => {
    armSettingsOpenIntent(opts({ tab: "judge" }));
    expect(useSettingsOpenIntentStore.getState().intent).not.toBeNull();

    armSettingsOpenIntent(opts({ tab: null, draft: null }));

    expect(useSettingsOpenIntentStore.getState().intent).toBeNull();
  });

  it("clears the pending intent when called with a null section", () => {
    armSettingsOpenIntent(opts({ tab: "judge" }));
    expect(useSettingsOpenIntentStore.getState().intent).not.toBeNull();

    armSettingsOpenIntent(opts({ section: null, tab: "rules" }));

    expect(useSettingsOpenIntentStore.getState().intent).toBeNull();
  });

  it("carries the hostId on the intent", () => {
    armSettingsOpenIntent(opts({ tab: "judge", hostId: "host-b" }));

    expect(useSettingsOpenIntentStore.getState().intent).toMatchObject({
      tab: "judge",
      hostId: "host-b",
    });
  });

  it("still stores an intent for an arm with only a hostId", () => {
    armSettingsOpenIntent(opts({ tab: null, draft: null, hostId: "host-b" }));

    expect(useSettingsOpenIntentStore.getState().intent).toMatchObject({
      section: "permissions",
      tab: null,
      draft: null,
      hostId: "host-b",
    });
  });

  it("clears the pending intent when tab, draft and hostId are all null", () => {
    armSettingsOpenIntent(opts({ hostId: "host-b" }));
    expect(useSettingsOpenIntentStore.getState().intent).not.toBeNull();

    armSettingsOpenIntent(opts({ tab: null, draft: null, hostId: null }));

    expect(useSettingsOpenIntentStore.getState().intent).toBeNull();
  });

  it("replaces an unconsumed intent left by an earlier call", () => {
    armSettingsOpenIntent(opts({ tab: "judge" }));
    armSettingsOpenIntent(opts({ tab: "rules" }));

    expect(useSettingsOpenIntentStore.getState().intent).toMatchObject({
      tab: "rules",
    });
  });
});

describe("acknowledgeSettingsOpenIntent", () => {
  it("clears the intent it names", () => {
    armSettingsOpenIntent(opts({ tab: "judge" }));
    const id = useSettingsOpenIntentStore.getState().intent?.id;
    if (id === undefined) throw new Error("expected a pending intent");

    acknowledgeSettingsOpenIntent(id);

    expect(useSettingsOpenIntentStore.getState().intent).toBeNull();
  });

  it("does not clear a newer intent when acknowledging a stale id", () => {
    armSettingsOpenIntent(opts({ tab: "judge" }));
    const staleId = useSettingsOpenIntentStore.getState().intent?.id;
    if (staleId === undefined) throw new Error("expected a pending intent");

    armSettingsOpenIntent(opts({ tab: "rules" }));

    acknowledgeSettingsOpenIntent(staleId);

    expect(useSettingsOpenIntentStore.getState().intent).toMatchObject({
      tab: "rules",
    });
  });

  it("is a no-op when there is no pending intent", () => {
    acknowledgeSettingsOpenIntent(999);
    expect(useSettingsOpenIntentStore.getState().intent).toBeNull();
  });
});

describe("useSettingsOpenIntent", () => {
  it("returns the pending intent for the matching section", () => {
    armSettingsOpenIntent(opts({ section: "permissions", tab: "judge" }));
    const { result } = renderHook(() => useSettingsOpenIntent("permissions"));

    expect(result.current).toMatchObject({
      section: "permissions",
      tab: "judge",
    });
  });

  it("returns null for a section that does not match the pending intent", () => {
    armSettingsOpenIntent(opts({ section: "permissions", tab: "judge" }));
    const { result } = renderHook(() => useSettingsOpenIntent("host"));

    expect(result.current).toBeNull();
  });

  it("returns null when there is no pending intent", () => {
    const { result } = renderHook(() => useSettingsOpenIntent("permissions"));

    expect(result.current).toBeNull();
  });
});

describe("resetSettingsOpenIntentForTests", () => {
  it("drops any pending intent and restarts the id sequence", () => {
    armSettingsOpenIntent(opts({ tab: "judge" }));
    resetSettingsOpenIntentForTests();

    expect(useSettingsOpenIntentStore.getState()).toEqual({
      intent: null,
      lastId: 0,
    });

    armSettingsOpenIntent(opts({ tab: "judge" }));
    expect(useSettingsOpenIntentStore.getState().intent?.id).toBe(1);
  });
});
