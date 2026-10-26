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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentHostRecordV12 } from "@traycer/protocol/host/environment/contracts";
import { TeamGuide } from "@/components/settings/environment/team-guide";
import { TeamPlans } from "@/components/settings/environment/team-plans";
import { useProviderLinkDialogStore } from "@/stores/providers/provider-link-dialog-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { negotiateMethods } from "./mcp-skills-test-support";
import {
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

// These cases are about the preview features' on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

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
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({ pick: null });
  useProviderLinkDialogStore.setState({ target: null });
});

const host: EnvironmentHostRecordV12 = {
  hostId: "host-a",
  hostLabel: "Mac mini",
  hostPlatform: "darwin",
  enrolledByUserId: "u-1",
  kind: "personal",
  boundAt: 1,
  reachable: true,
  lastReportedAt: 1,
  hasLocalRow: false,
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
    {
      environmentId: "env-personal",
      ownerKind: "user" as const,
      ownerId: "user-me",
      roomId: "room-personal",
      label: "Me",
      effectiveRole: "owner" as const,
      kind: "personal" as const,
      hostCount: 1,
      providerHandle: null,
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

  it.each([
    ["a team", poolSource("admin"), "Couldn't read Acme's plans."],
    ["Personal", personalPoolSource(), "Couldn't read your plans."],
  ])(
    "names %s when the plans cannot be read, and Retry reads again",
    async (_name, source, line) => {
      const harness = mountTeamPage(source, {
        "environment.plans.list": () => {
          throw new Error("host unavailable");
        },
        "environment.list": () => environmentList,
      });
      render(<TeamPlans providerId="claude-code" adminNames={[]} />, {
        wrapper: harness.Wrapper,
      });

      const failure = await screen.findByText(line);
      const reads = harness.paramsOf("environment.plans.list").length;
      await userEvent.click(
        within(failure.closest("p") ?? failure).getByRole("button", {
          name: "Retry",
        }),
      );

      await waitFor(() => {
        expect(
          harness.paramsOf("environment.plans.list").length,
        ).toBeGreaterThan(reads);
      });
    },
  );

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

  // A build with no pool: the window's host serves the guide and advertises its writes.
  beforeEach(() => {
    negotiateMethods({
      "environment.configuration.guide.set": { major: 1, minor: 0 },
      "environment.configuration.guide.reset": { major: 1, minor: 0 },
    });
  });

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

  it("says the guide needs a host, exactly, when a build with no pool's host does not serve the team's room", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.host.list": () => ({ hosts: [host] }),
      "environment.list": () => environmentList,
      "environment.configuration.guide.get": () => ({ outcome: "not_served" }),
    });
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "The guide needs a host running Acme.Pick one.",
      );
    });
    expect(harness.paramsOf("environment.configuration.guide.get")).toEqual([
      { environmentId: "env-a" },
    ]);
  });

  it.each([
    [
      "a team",
      poolSource("editor"),
      "This replaces Acme's selection guide with the default for every member. Changes anyone made to it are lost.",
    ],
    [
      "Personal",
      personalPoolSource(),
      "This replaces your selection guide with the default on every computer and sandbox running Personal. Your changes to it are lost.",
    ],
  ])(
    "confirms a guide reset for %s in that configuration's words",
    async (_name, source, sentence) => {
      const harness = mountTeamPage(
        source,
        guideHandlers({ text: "Prefer sonnet", revision: "rev-1" }, {}),
      );
      render(<TeamGuide />, { wrapper: harness.Wrapper });

      await userEvent.click(await screen.findByTestId("team-guide-revert"));
      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByText("Reset to default instructions?"),
      ).toBeTruthy();
      await waitFor(() => {
        expect(within(dialog).getByText(sentence)).toBeTruthy();
      });
      expect(
        within(dialog).getByRole("button", { name: "Reset to default" }),
      ).toBeTruthy();
    },
  );

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

  it("says the guide could not be saved when the host answers not_served", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      ...guideHandlers(
        { text: "Prefer sonnet", revision: "rev-1" },
        { onSet: () => ({ outcome: "not_served" }) },
      ),
    });
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='team-guide-input']"),
      ).not.toBeNull();
    });
    replaceText("Mine");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Couldn't save the guide.",
    );
    expect(harness.paramsOf("environment.configuration.guide.set")).toEqual([
      { environmentId: "env-a", text: "Mine", revision: "rev-1" },
    ]);
  });

  it("says the guide could not be reset and closes the confirmation when the host answers not_served", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      ...guideHandlers({ text: "Prefer sonnet", revision: "rev-1" }, {}),
      "environment.configuration.guide.reset": () => ({
        outcome: "not_served",
      }),
    });
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    await userEvent.click(await screen.findByTestId("team-guide-revert"));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Reset to default",
      }),
    );

    expect((await screen.findByRole("status")).textContent).toBe(
      "Couldn't reset the guide.",
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
