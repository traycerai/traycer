import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { TeamVariablesAndShells } from "@/components/settings/environment/team-variables-and-shells";
import {
  mountTeamPage,
  personalPoolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

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
  vi.useRealTimers();
  resetTeamPageHarness();
});

const personal: EnvironmentDescriptorV11 = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 1,
  providerHandle: null,
};

describe("a configuration page whose read never answers", () => {
  it("says it couldn't read Personal's variables and shells after 15 seconds, with Retry", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const harness = mountTeamPage(personalPoolSource(), {
      "environment.list": () => ({ environments: [personal] }),
      "environment.configuration.items": () => new Promise(() => undefined),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(
      screen.queryByText("Couldn't read Personal's variables and shells."),
    ).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(
      screen.getByText("Couldn't read Personal's variables and shells."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
