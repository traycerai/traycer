import { afterEach, describe, expect, it } from "vitest";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

afterEach(() => {
  useSettingsHostScopeStore.getState().reset();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
});

describe("Settings host id adoption", () => {
  it("moves matching selections, Local keys, and pending targets while keeping unrelated selections", () => {
    const store = useSettingsHostScopeStore.getState();
    store.selectHost(
      { kind: "local", hostId: "host-old", hostName: "Old computer" },
      { hostId: "host-old", name: "Old computer" },
    );
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-old", hostName: "Old computer" },
      defaultPick: {
        kind: "local",
        hostId: "host-old",
        hostName: "Old default computer",
      },
    });
    store.selectHost(PERSONAL_PICK, {
      hostId: "host-old",
      name: "Personal computer",
    });
    store.selectHost(
      { kind: "team", environmentId: "team-1" },
      { hostId: "host-other", name: "Other computer" },
    );
    store.requestHost("host-old");

    store.adoptHostId("host-old", "host-new");

    expect({
      hostByEnvironment: useSettingsHostScopeStore.getState().hostByEnvironment,
      pendingHostId: useSettingsHostScopeStore.getState().pendingHostId,
      pick: useSettingsEnvironmentPickStore.getState().pick,
      defaultPick: useSettingsEnvironmentPickStore.getState().defaultPick,
    }).toEqual({
      hostByEnvironment: {
        "local:host-new": { hostId: "host-new", name: "Old computer" },
        personal: { hostId: "host-new", name: "Personal computer" },
        "team:team-1": { hostId: "host-other", name: "Other computer" },
      },
      pendingHostId: "host-new",
      pick: { kind: "local", hostId: "host-new", hostName: "Old computer" },
      defaultPick: {
        kind: "local",
        hostId: "host-new",
        hostName: "Old default computer",
      },
    });
  });
});

describe("Settings host entry requests", () => {
  it("preserves a newer request on stale abandon and reset clears pending state", () => {
    const store = useSettingsHostScopeStore.getState();
    store.requestHost("older-host");
    store.abandonHostEntry("different-host");
    expect(useSettingsHostScopeStore.getState().pendingHostId).toBe(
      "older-host",
    );

    store.requestHost("newer-host");
    store.abandonHostEntry("older-host");
    expect(useSettingsHostScopeStore.getState().pendingHostId).toBe(
      "newer-host",
    );

    store.reset();
    expect(useSettingsHostScopeStore.getState().pendingHostId).toBeNull();
  });
});
