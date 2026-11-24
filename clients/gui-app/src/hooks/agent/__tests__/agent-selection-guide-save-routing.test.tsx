import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { settingsSaveIdFromRequestId } from "@traycer/protocol/framework/settings-save-request-id";
import {
  mountTeamPage,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useAgentSelectionGuideSetGlobalMutation } from "../use-agent-selection-guide-set-global-mutation";
import { useAgentSelectionGuideResetGlobalMutation } from "../use-agent-selection-guide-reset-global-mutation";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));

vi.mock("@/hooks/environment/use-environment-cloud", () => ({
  useEnvironmentCloud: () => () => ({
    authnBaseUrl: "https://authn.example.test/",
    bearer: { kind: "cloud", getBearerToken: () => "synthetic-test-bearer" },
    transport: () =>
      Promise.reject(new Error("A Guide save must use the host")),
    onOriginSignIn: () => true,
  }),
}));

afterEach(() => {
  cleanup();
  useSettingsEnvironmentPickStore.getState().setPick(null);
  resetTeamPageHarness();
});

it.each(["personal", "local"] as const)(
  "carries save IDs to the host only under a %s Guide scope",
  async (kind) => {
    useSettingsEnvironmentPickStore
      .getState()
      .setPick(
        kind === "personal"
          ? { kind }
          : { kind, hostId: "test-host", hostName: "Test host" },
      );
    const host = mountTeamPage(
      { kind: "host" },
      {
        "agent.selectionGuide.setGlobal": ({ content }) => ({
          content,
          generatedDefaultContent: "default guide",
        }),
        "agent.selectionGuide.resetGlobalToDefault": () => ({
          content: "default guide",
          generatedDefaultContent: "default guide",
        }),
      },
    );
    const rendered = renderHook(
      () => ({
        set: useAgentSelectionGuideSetGlobalMutation(),
        reset: useAgentSelectionGuideResetGlobalMutation(),
      }),
      { wrapper: host.Wrapper },
    );
    await act(async () => {
      await rendered.result.current.set.mutateAsync({ content: "my guide" });
      await rendered.result.current.reset.mutateAsync({});
    });

    const saves = host.messenger.calls.filter(
      ({ method }) =>
        method === "agent.selectionGuide.setGlobal" ||
        method === "agent.selectionGuide.resetGlobalToDefault",
    );
    expect(saves.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: "agent.selectionGuide.setGlobal",
        params: { content: "my guide" },
      },
      { method: "agent.selectionGuide.resetGlobalToDefault", params: {} },
    ]);
    const saveIds = saves.map(({ requestId }) =>
      settingsSaveIdFromRequestId(requestId),
    );
    if (kind === "local") {
      expect(saveIds).toEqual([null, null]);
    } else {
      expect(saveIds).toEqual([expect.any(String), expect.any(String)]);
      expect(new Set(saveIds).size).toBe(2);
    }
  },
);
