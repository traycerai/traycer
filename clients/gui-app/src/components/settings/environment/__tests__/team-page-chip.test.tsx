import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentHostItemApply,
  EnvironmentHostRecordV11,
} from "@traycer/protocol/host/environment/contracts";
import { PageChip } from "@/components/settings/personal/page-chip";
import { TeamVariablesAndShells } from "@/components/settings/environment/team-variables-and-shells";
import {
  configurationItem,
  mountTeamPage,
  poolSource,
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
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetTeamPageHarness();
});

const PICK = { kind: "team", environmentId: "env-a" } as const;

function hostReporting(
  state: EnvironmentHostItemApply["state"],
): EnvironmentHostRecordV11 {
  return {
    hostId: "host-a",
    hostLabel: "Mac mini",
    hostPlatform: "darwin",
    enrolledByUserId: "u-1",
    kind: "personal",
    boundAt: 1,
    reachable: true,
    lastReportedAt: 1,
    applied: [
      {
        itemKey: "variable:NODE_ENV",
        state,
        reason: state === "not_applied" ? "invalid_value" : null,
        at: 1,
      },
    ],
  };
}

function chipText(): string {
  return screen.getByTestId("page-chip").textContent;
}

describe("the team page chip", () => {
  it("says No hosts yet while the team has no host", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(
      <div data-testid="page-chip">
        <PageChip section="shell" pick={PICK} />
      </div>,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => {
      expect(chipText()).toBe("No hosts yet");
    });
  });

  it("rereads the host reports while an item is still applying and stops once it settles", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let state: EnvironmentHostItemApply["state"] = "received";
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.host.list": () => ({ hosts: [hostReporting(state)] }),
    });
    render(
      <div data-testid="page-chip">
        <PageChip section="shell" pick={PICK} />
      </div>,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => {
      expect(chipText()).toBe("Applying on Mac mini…");
    });
    state = "applied";
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    await waitFor(() => {
      expect(chipText()).toBe("✓ On Mac mini");
    });

    const reads = harness.paramsOf("environment.host.list").length;
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(harness.paramsOf("environment.host.list")).toHaveLength(reads);
  });

  it("rereads the host reports until a host that has never reported does", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let lastReportedAt: number | null = null;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.host.list": () => ({
        hosts: [{ ...hostReporting("applied"), applied: [], lastReportedAt }],
      }),
    });
    render(
      <div data-testid="page-chip">
        <PageChip section="shell" pick={PICK} />
      </div>,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => {
      expect(chipText()).toBe("Applying on Mac mini…");
    });
    lastReportedAt = 1;
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    await waitFor(() => {
      expect(chipText()).toBe("✓ On Mac mini");
    });
  });

  it("rereads the host reports after a save, so a later failure replaces the success", async () => {
    let state: EnvironmentHostItemApply["state"] = "applied";
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [
          configurationItem({
            kind: "variable",
            key: "NODE_ENV",
            os: "any",
            value: { value: "production" },
            revision: 3,
          }),
        ],
      }),
      "environment.configuration.items.put": () => {
        state = "not_applied";
        return { outcome: "saved", revision: 4 };
      },
      "environment.host.list": () => ({ hosts: [hostReporting(state)] }),
    });
    render(
      <>
        <div data-testid="page-chip">
          <PageChip section="shell" pick={PICK} />
        </div>
        <TeamVariablesAndShells />
      </>,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => {
      expect(chipText()).toBe("✓ On Mac mini");
    });
    await userEvent.type(await screen.findByLabelText("NODE_ENV value"), "!");
    await userEvent.click(
      within(screen.getByRole("region", { name: "NODE_ENV" })).getByRole(
        "button",
        { name: "Save" },
      ),
    );

    await waitFor(() => {
      expect(chipText()).toBe("1 not applied on Mac mini");
    });
  });
});
