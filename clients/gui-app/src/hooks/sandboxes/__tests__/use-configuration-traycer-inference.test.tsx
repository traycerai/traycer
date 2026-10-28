import "../../../../__tests__/test-browser-apis";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentConfigurationItemsResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { useConfigurationTraycerInference } from "@/hooks/sandboxes/use-configuration-traycer-inference";
import {
  configurationItem,
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

const environments = {
  environments: [
    {
      environmentId: "env-personal",
      ownerKind: "user" as const,
      ownerId: "user-me",
      roomId: "room-p",
      label: "Personal",
      effectiveRole: "owner" as const,
      kind: "personal" as const,
      hostCount: 1,
      providerHandle: null,
    },
    {
      environmentId: "env-a",
      ownerKind: "organization" as const,
      ownerId: "team-a",
      roomId: "room-a",
      label: "Acme",
      effectiveRole: "editor" as const,
      kind: "team" as const,
      hostCount: 0,
      providerHandle: "handle-a",
    },
  ],
};

/** Reads one configuration's setting through the window's host answering `items`. */
function readThrough(
  configurationKey: string,
  items: (environmentId: string) => EnvironmentConfigurationItemsResponse,
) {
  const harness = mountTeamPage(poolSource("editor"), {
    "environment.list": () => environments,
    "environment.configuration.items": (params: {
      readonly environmentId: string;
    }) => items(params.environmentId),
  });
  const hook = renderHook(
    () => useConfigurationTraycerInference(configurationKey),
    { wrapper: harness.Wrapper },
  );
  return { harness, hook };
}

const traycerOn = configurationItem({
  kind: "traycer_inference",
  key: "traycer",
  value: { enabled: true },
  revision: 6,
});

describe("useConfigurationTraycerInference", () => {
  it("reads a team's setting on, from its own environment, before any host of it exists", async () => {
    const { harness, hook } = readThrough("team-a", (environmentId) =>
      environmentId === "env-a"
        ? { items: [traycerOn], servedKinds: ["traycer_inference"] }
        : { items: [], servedKinds: ["traycer_inference"] },
    );

    await waitFor(() => {
      expect(hook.result.current).toEqual({
        kind: "ready",
        enabled: true,
        revision: 6,
      });
    });
    expect(harness.paramsOf("environment.configuration.items")).toEqual([
      { environmentId: "env-a" },
    ]);
  });

  it("reads Personal's unset setting as off", async () => {
    const { hook } = readThrough("personal", () => ({
      items: [],
      servedKinds: ["managed_profile", "traycer_inference"],
    }));

    await waitFor(() => {
      expect(hook.result.current).toEqual({
        kind: "ready",
        enabled: false,
        revision: null,
      });
    });
  });

  it("reads unknown through a host older than the setting, whatever its items say", async () => {
    // An older host never asks the cloud for the kind, so an absent item
    // there is not an off.
    const { hook } = readThrough("personal", () => ({ items: [traycerOn] }));

    await waitFor(() => {
      expect(hook.result.current).toEqual({ kind: "unknown" });
    });
  });

  it("reads unknown while the cloud has not served the kind yet", async () => {
    // A newer host over a cloud that answers the kind only once its first
    // value is in place: the kind is missing from what it served.
    const { hook } = readThrough("personal", () => ({
      items: [],
      servedKinds: ["managed_profile"],
    }));

    await waitFor(() => {
      expect(hook.result.current).toEqual({ kind: "unknown" });
    });
  });
});
