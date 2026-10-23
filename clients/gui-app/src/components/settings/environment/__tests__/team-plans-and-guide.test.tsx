import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@uiw/react-codemirror";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentHostRecordV11 } from "@traycer/protocol/host/environment/contracts";
import { TeamGuide } from "@/components/settings/environment/team-guide";
import { TeamPlans } from "@/components/settings/environment/team-plans";
import { useProviderLinkDialogStore } from "@/stores/providers/provider-link-dialog-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
// The link dialog imports the hook from the runtime module itself.
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
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

// Opening a URL is the external egress; the link dialog only needs the opener.
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => () => Promise.resolve(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSettingsEnvironmentPickStore.setState({ pick: null });
  useProviderLinkDialogStore.setState({ target: null });
});

const host: EnvironmentHostRecordV11 = {
  hostId: "host-a",
  hostLabel: "Mac mini",
  hostPlatform: "darwin",
  enrolledByUserId: "u-1",
  kind: "personal",
  boundAt: 1,
  reachable: true,
  lastReportedAt: 1,
  applied: [],
};

const environmentList = {
  environments: [
    {
      environmentId: "env-a",
      ownerKind: "organization" as const,
      ownerId: "team-a",
      roomId: "room-a",
      label: "Acme",
      effectiveRole: "admin" as const,
      kind: "team" as const,
      hostCount: 1,
      providerHandle: "handle-a",
    },
  ],
};

describe("TeamPlans", () => {
  const plans = {
    plans: [
      {
        profileId: "prof-1",
        harness: "claude",
        status: "linked" as const,
        linkedBy: { name: "Ada", you: false },
      },
      {
        profileId: "prof-2",
        harness: "claude",
        status: "pending" as const,
        linkedBy: null,
      },
      // Another harness's plan and an empty profile are not this card's.
      {
        profileId: "prof-3",
        harness: "codex",
        status: "linked" as const,
        linkedBy: { name: "Grace", you: false },
      },
      {
        profileId: "prof-4",
        harness: "claude",
        status: "empty" as const,
        linkedBy: null,
      },
    ],
  };

  it("reads this team's plans by environment id and lists only this provider's non-empty ones", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.plans.list": () => plans,
      "environment.list": () => environmentList,
    });
    render(<TeamPlans providerId="claude-code" adminNames={["Ada"]} />, {
      wrapper: harness.Wrapper,
    });

    expect(await screen.findByText(/Ada.s .* plan/)).toBeTruthy();
    expect(harness.paramsOf("environment.plans.list")).toEqual([
      { environmentId: "env-a" },
    ]);
    expect(screen.queryByText(/Grace/)).toBeNull();
    expect(screen.getAllByText(/ plan$/i).length).toBeGreaterThanOrEqual(1);
  });

  it("gives a viewer no Link, Unlink or Add a profile verbs, and names the admins", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.plans.list": () => plans,
      "environment.list": () => environmentList,
    });
    render(<TeamPlans providerId="claude-code" adminNames={["Ada"]} />, {
      wrapper: harness.Wrapper,
    });

    await screen.findByText(/Ada.s .* plan/);
    expect(screen.queryByRole("button", { name: /link a plan/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull();
    expect(screen.queryByText(/add a profile/i)).toBeNull();
    expect(screen.getByText("Admins link a plan: Ada.")).toBeTruthy();
  });

  it("holds Unlink until its preview resolves, then unlinks the picked profile in this team", async () => {
    let resolvePreview: (value: {
      activeTurns: number | null;
      localHostId: string | null;
      keepsWorking: string[];
    }) => void = () => undefined;
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.plans.list": () => plans,
      "environment.list": () => environmentList,
      "environment.plans.unlinkPreview": () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
      "environment.plans.unlink": () => ({ outcome: "unlinked" }),
    });
    render(<TeamPlans providerId="claude-code" adminNames={["Ada"]} />, {
      wrapper: harness.Wrapper,
    });

    const card = await screen.findByRole("region", { name: "Plans" });
    await userEvent.click(
      within(card).getAllByRole("button", { name: "Unlink" })[0],
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.plans.unlinkPreview")).toEqual([
        { environmentId: "env-a", profileId: "prof-1" },
      ]);
    });
    // The consequences are not known yet: no confirm, no unlink.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(harness.paramsOf("environment.plans.unlink")).toHaveLength(0);

    act(() => {
      resolvePreview({
        activeTurns: 2,
        localHostId: null,
        keepsWorking: ["Team key"],
      });
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/2 active turns/)).toBeTruthy();
    expect(harness.paramsOf("environment.plans.unlink")).toHaveLength(0);

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Unlink" }),
    );
    await waitFor(() => {
      expect(harness.paramsOf("environment.plans.unlink")).toEqual([
        { environmentId: "env-a", profileId: "prof-1" },
      ]);
    });
  });

  it("opens the link dialog on this team's environment", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.plans.list": () => plans,
      "environment.list": () => environmentList,
    });
    render(<TeamPlans providerId="claude-code" adminNames={[]} />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      await screen.findByRole("button", { name: /link a plan/i }),
    );
    expect(useProviderLinkDialogStore.getState().target).toMatchObject({
      providerId: "claude-code",
      profileId: null,
      environmentId: "env-a",
    });
  });
});

describe("TeamGuide", () => {
  const guideHandlers = (
    state: { text: string; revision: string },
    handlers: { onSet?: () => { outcome: "set" | "conflict" | "not_served" } },
  ) =>
    ({
      "environment.host.list": () => ({ hosts: [host] }),
      "environment.list": () => environmentList,
      "environment.configuration.guide.get": () => ({
        outcome: "ok" as const,
        ...state,
      }),
      "environment.configuration.guide.set": () =>
        handlers.onSet?.() ?? { outcome: "set" as const },
    }) as const;

  function editorOf(): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      "[data-testid='team-guide-input']",
    );
    if (element === null) throw new Error("guide editor not rendered");
    return element;
  }
  function replaceText(text: string): void {
    act(() => {
      const view = EditorView.findFromDOM(editorOf());
      if (view === null) throw new Error("no CodeMirror view");
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    });
  }

  it("says the guide needs a host, exactly, and reads nothing when the team has no eligible host", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.host.list": () => ({ hosts: [] }),
      "environment.list": () => environmentList,
    });
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    const line = await screen.findByRole("status");
    await waitFor(() => {
      expect(line.textContent).toBe(
        "The guide needs a host running Acme. Pick one.",
      );
    });
    expect(
      harness.paramsOf("environment.configuration.guide.get"),
    ).toHaveLength(0);
  });

  it("shows the same line when the picked host does not serve the team's room", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.host.list": () => ({ hosts: [host] }),
      "environment.list": () => environmentList,
      "environment.configuration.guide.get": () => ({ outcome: "not_served" }),
    });
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "The guide needs a host running Acme. Pick one.",
      );
    });
    expect(harness.paramsOf("environment.configuration.guide.get")).toEqual([
      { environmentId: "env-a" },
    ]);
  });

  it("gives a viewer the guide text with no editor verbs", async () => {
    const harness = mountTeamPage(
      poolSource("viewer"),
      guideHandlers({ text: "Prefer sonnet", revision: "rev-1" }, {}),
    );
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='team-guide-read-only']"),
      ).not.toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByTestId("team-guide-revert")).toBeNull();
    expect(
      document.querySelector("[data-testid='team-guide-input']"),
    ).toBeNull();
  });

  it("quotes the opaque revision on set, and a conflict rereads the current text beside the conflict line", async () => {
    let state = { text: "Prefer sonnet", revision: "rev-opaque-1" };
    const harness = mountTeamPage(poolSource("editor"), {
      ...guideHandlers(state, {}),
      "environment.configuration.guide.get": () => ({
        outcome: "ok" as const,
        ...state,
      }),
      "environment.configuration.guide.set": () => {
        state = { text: "Prefer opus", revision: "rev-opaque-2" };
        return { outcome: "conflict" };
      },
    });
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='team-guide-input']"),
      ).not.toBeNull();
    });
    replaceText("Mine");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(harness.paramsOf("environment.configuration.guide.set")).toEqual([
      { environmentId: "env-a", text: "Mine", revision: "rev-opaque-1" },
    ]);
    expect(
      await screen.findByText("Changed by another member a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      const view = EditorView.findFromDOM(editorOf());
      expect(view?.state.doc.toString()).toBe("Prefer opus");
    });
  });
});
