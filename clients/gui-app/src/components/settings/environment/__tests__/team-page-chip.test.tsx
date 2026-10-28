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
  EnvironmentHostRecordV12,
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

// A team page reads its hosts from the host list; this window's own host
// scope has no hosts here.
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const scope = hostScopeFixture({ host: null });
  return { useHostScope: () => scope };
});
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
): EnvironmentHostRecordV12 {
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
    hasLocalRow: false,
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

  it("keeps mounted host metadata fresh after an item settles, and stops on unmount", async () => {
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

    // A later report can change without another configuration write. The
    // mounted metadata reader keeps the chip current after initial apply.
    state = "not_applied";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() => expect(chipText()).toBe("1 not applied on Mac mini"));

    cleanup();
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    const reads = harness.paramsOf("environment.host.list").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
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
