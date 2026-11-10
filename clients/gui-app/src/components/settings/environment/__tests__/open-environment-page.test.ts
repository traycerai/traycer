import { afterEach, describe, expect, it, vi } from "vitest";
import { openEnvironmentPage } from "@/components/settings/environment/open-environment-page";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const navigation = vi.hoisted(() => ({ navigateToSettingsSection: vi.fn() }));
vi.mock("@/lib/settings-navigation", () => navigation);

afterEach(() => {
  useSettingsEnvironmentPickStore.setState({ pick: null });
  vi.clearAllMocks();
});

describe("openEnvironmentPage", () => {
  it.each(["personal", "team-environment"])(
    "opens Agent memories for configuration %s",
    (configurationId) => {
      openEnvironmentPage({ configurationId, pageId: "agent-memories" });

      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        configurationId === "personal"
          ? { kind: "personal" }
          : { kind: "team", environmentId: configurationId },
      );
      expect(
        navigation.navigateToSettingsSection,
      ).toHaveBeenCalledExactlyOnceWith("agent-memories");
    },
  );
});
