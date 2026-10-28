import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  EnvironmentConfigurationSkillsListResponse,
  EnvironmentSkill,
} from "@traycer/protocol/host/environment/configuration-contracts";
import type { ProviderSkill } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  EnvironmentProviderSkillsTab,
  EnvironmentSkillsPage,
} from "@/components/settings/environment/environment-skills";
import type { HostRpcRegistry } from "@/lib/host";
import {
  hostPlaceKey,
  hostSkill,
  nativeScopeTargets,
  negotiateMethods,
  projectScopedProviderState,
  providerState,
  reachableHost,
  teamEnvironments,
} from "./mcp-skills-test-support";
import {
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
// The ambient host binding is what the viewing-host binding re-provides.
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => requireTeamHostClient(),
  useHostBinding: () => ({
    hostId: "host-local",
    hostClient: requireTeamHostClient(),
  }),
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
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));
// The detail dialog reads SKILL.md off disk.
vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => ({
    data: {
      content: "---\nname: review\n---\n\n# Use\n",
      truncated: false,
      error: null,
    },
    isPending: false,
    isError: false,
    error: null,
  }),
}));
vi.mock("@/components/settings/panels/use-provider-native-scope", async () => {
  const support = await import("./mcp-skills-test-support");
  return { useProviderNativeScope: support.nativeScopeFor };
});
const navigation = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: (section: string): void => {
    navigation.opened.push(section);
  },
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  navigation.opened = [];
  nativeScopeTargets.current = [];
});

/** The providers of the viewing host that list skills, in rail order. */
const CAPABLE: readonly ProviderId[] = [
  "codex",
  "claude-code",
  "opencode",
  "traycer",
  "openrouter",
  "huggingface",
];

const LIST = { major: 1, minor: 0 };
const BASE_METHODS = {
  "environment.configuration.skills.list": LIST,
  "environment.configuration.skills.remove": LIST,
  "providers.nativeMutate": { major: 1, minor: 3 },
} as const;
const SWITCHES = {
  ...BASE_METHODS,
  "environment.configuration.skills.setProviders": LIST,
} as const;

const REVIEW: EnvironmentSkill = {
  name: "review",
  description: "Review a change.",
  origin: "room",
  edited: false,
  offFor: [],
};
const BUILT_IN: EnvironmentSkill = {
  name: "find-skills",
  description: "Discover skills.",
  origin: "bundled",
  edited: false,
  offFor: [],
};

function handlers(options: {
  readonly list: EnvironmentConfigurationSkillsListResponse;
  /** What the viewing host lists for a provider by itself. */
  readonly hostSkills: readonly ProviderSkill[];
}): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.configuration.skills.list": () => options.list,
    "environment.configuration.skills.remove": () => ({
      outcome: "removed" as const,
      reason: null,
    }),
    "environment.configuration.skills.setProviders": () => ({
      outcome: "saved" as const,
      revision: "rev-2",
      reason: null,
    }),
    "providers.nativeMutate": () => ({
      result: { ok: true, kind: "skills", skills: [] },
    }),
    "environment.host.list": () => ({ hosts: [reachableHost] }),
    "environment.list": () => teamEnvironments,
    "providers.list": (request) =>
      request.native === null
        ? {
            providers: CAPABLE.map((id) =>
              providerState(id, { mcp: false, skills: true }),
            ),
            native: null,
          }
        : {
            providers: [],
            native: {
              ok: true as const,
              kind: "skills" as const,
              skills: [...options.hostSkills],
            },
          },
  };
}

function listed(
  skills: readonly EnvironmentSkill[],
): EnvironmentConfigurationSkillsListResponse {
  return { outcome: "listed", revision: "rev-1", skills: [...skills] };
}

describe("The Skills page", () => {
  it("shows an uploaded skill without a remount", async () => {
    negotiateMethods({
      ...BASE_METHODS,
      "environment.configuration.skills.upload": LIST,
    });
    let uploaded = false;
    const base = handlers({ list: listed([BUILT_IN]), hostSkills: [] });
    const harness = mountTeamPage(poolSource("editor"), {
      ...base,
      "environment.configuration.skills.list": () =>
        listed(uploaded ? [REVIEW, BUILT_IN] : [BUILT_IN]),
      "environment.configuration.skills.upload": () => {
        uploaded = true;
        return { outcome: "saved" as const, reason: null };
      },
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await userEvent.type(await screen.findByLabelText("Skill name"), "review");
    await userEvent.upload(
      screen.getByLabelText("Skill folder archive"),
      new File([new Uint8Array([1, 2, 3, 4])], "review.tar.gz", {
        type: "application/gzip",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Add a skill" }));

    expect(await screen.findByText("Review a change.")).toBeTruthy();
  });

  describe("a skill's files that cannot be read", () => {
    async function openReview(
      nativeSkills: () => readonly ProviderSkill[],
    ): Promise<void> {
      negotiateMethods(BASE_METHODS);
      const base = handlers({ list: listed([REVIEW]), hostSkills: [] });
      const harness = mountTeamPage(poolSource("editor"), {
        ...base,
        "providers.list": (request) => {
          if (request.native === null) {
            return {
              providers: CAPABLE.map((id) =>
                providerState(id, { mcp: false, skills: true }),
              ),
              native: null,
            };
          }
          return {
            providers: [],
            native: {
              ok: true as const,
              kind: "skills" as const,
              skills: [...nativeSkills()],
            },
          };
        },
      });
      render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });
      const row = (await screen.findByText("review")).closest("li");
      if (row === null) throw new Error("no row for review");
      await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
    }

    it("says the files could not be read when the read fails, and Retry opens the skill once it answers", async () => {
      let failing = true;
      await openReview(() => {
        if (failing) throw new Error("host unavailable");
        return [hostSkill("review", "managed")];
      });

      expect((await screen.findByRole("status")).textContent).toBe(
        "Couldn't read this skill's files.Retry",
      );
      expect(screen.queryByRole("dialog")).toBeNull();

      failing = false;
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));

      expect(await screen.findByRole("dialog")).toBeTruthy();
    });

    it("says the files could not be found when the read answers without the skill", async () => {
      await openReview(() => [hostSkill("other", "managed")]);

      expect((await screen.findByRole("status")).textContent).toBe(
        "Couldn't find this skill's files.Retry",
      );
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("shows an edited description in the list once the edit dialog closes", async () => {
    negotiateMethods(BASE_METHODS);
    let description = REVIEW.description;
    const managed = hostSkill("review", "managed");
    const base = handlers({ list: listed([REVIEW]), hostSkills: [managed] });
    const harness = mountTeamPage(poolSource("editor"), {
      ...base,
      "environment.configuration.skills.list": () =>
        listed([{ ...REVIEW, description }]),
      "providers.nativeMutate": () => {
        description = "Review every change.";
        return { result: { ok: true, kind: "skills", skills: [managed] } };
      },
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    const row = (await screen.findByText("review")).closest("li");
    expect(row).not.toBeNull();
    if (row === null) return;
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "When to use" }),
      {
        target: { value: "Review every change." },
      },
    );
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Save changes" }),
    );
    await waitFor(() => {
      expect(harness.paramsOf("providers.nativeMutate")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(
        within(dialog).queryByRole("button", { name: "Save changes" }),
      ).toBeNull();
    });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    expect(await screen.findByText("Review every change.")).toBeTruthy();
  });

  it("reads each skill's name, description, source and providers as the serving host lists them", async () => {
    negotiateMethods(BASE_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({ list: listed([REVIEW, BUILT_IN]), hostSkills: [] }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("all providers")).toBeTruthy();
    expect(screen.getByText("Built-in · all providers")).toBeTruthy();
    expect(screen.queryByText(/written in Settings/)).toBeNull();
    expect(screen.getByText("review")).toBeTruthy();
    expect(screen.getByText("Review a change.")).toBeTruthy();
    expect(harness.paramsOf("environment.configuration.skills.list")).toEqual([
      { environmentId: "env-a" },
    ]);
    expect(
      await screen.findByText(
        "Instructions agents follow for a kind of task. Acme's skills reach every provider on every host running Acme.",
      ),
    ).toBeTruthy();
  });

  it("says all providers while the host cannot switch per provider, whatever offFor holds", async () => {
    negotiateMethods(BASE_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        list: listed([{ ...REVIEW, offFor: ["claude-code"] }]),
        hostSkills: [],
      }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("all providers")).toBeTruthy();
  });

  it("draws the providers from offFor once the host switches per provider", async () => {
    negotiateMethods(SWITCHES);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        list: listed([
          {
            ...REVIEW,
            offFor: [
              "claude-code",
              "opencode",
              "traycer",
              "openrouter",
              "huggingface",
            ],
          },
        ]),
        hostSkills: [],
      }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Codex only")).toBeTruthy();
  });

  it("offers Edit on a written skill and Preview, with no Remove, on a built-in one", async () => {
    negotiateMethods(BASE_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({ list: listed([REVIEW, BUILT_IN]), hostSkills: [] }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    const written = (await screen.findByText("review")).closest("li");
    const builtIn = screen.getByText("find-skills").closest("li");
    expect(written).not.toBeNull();
    expect(builtIn).not.toBeNull();
    if (written === null || builtIn === null) return;
    expect(within(written).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(
      within(written).getByRole("button", { name: "Remove" }),
    ).toBeTruthy();
    expect(
      within(builtIn).getByRole("button", { name: "Preview" }),
    ).toBeTruthy();
    expect(
      within(builtIn).queryByRole("button", { name: "Remove" }),
    ).toBeNull();
  });

  it.each([
    {
      source: personalPoolSource(),
      line: "This removes review from every provider on every computer and sandbox running Personal.",
    },
    {
      source: poolSource("editor"),
      line: "This removes review from every provider on every host running Acme.",
    },
  ])(
    "asks before removing a written skill: $line",
    async ({ source, line }) => {
      negotiateMethods(BASE_METHODS);
      const harness = mountTeamPage(
        source,
        handlers({ list: listed([REVIEW]), hostSkills: [] }),
      );
      render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

      await userEvent.click(
        await screen.findByRole("button", { name: "Remove" }),
      );
      const dialog = await screen.findByRole("dialog");

      expect(within(dialog).getByText("Remove review?")).toBeTruthy();
      expect(within(dialog).getByText(line)).toBeTruthy();
      expect(
        harness.paramsOf("environment.configuration.skills.remove"),
      ).toHaveLength(0);
    },
  );

  it("sends nothing when the removal is cancelled, and one remove by name when it is confirmed", async () => {
    negotiateMethods(BASE_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({ list: listed([REVIEW]), hostSkills: [] }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Remove" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(
      harness.paramsOf("environment.configuration.skills.remove"),
    ).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Remove skill",
      }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.skills.remove"),
      ).toEqual([{ environmentId: "env-a", name: "review" }]);
    });
  });

  it("opens a written skill's dialog editable and a built-in one's read-only, from the viewing host's managed rows", async () => {
    negotiateMethods(BASE_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        list: listed([REVIEW, BUILT_IN]),
        hostSkills: [
          hostSkill("review", "managed"),
          hostSkill("find-skills", "managed"),
        ],
      }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    const written = (await screen.findByText("review")).closest("li");
    const builtIn = screen.getByText("find-skills").closest("li");
    expect(written).not.toBeNull();
    expect(builtIn).not.toBeNull();
    if (written === null || builtIn === null) return;
    await userEvent.click(
      within(written).getByRole("button", { name: "Edit" }),
    );
    const editable = await screen.findByRole("dialog");
    expect(within(editable).getByRole("button", { name: "Edit" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await userEvent.click(
      within(builtIn).getByRole("button", { name: "Preview" }),
    );
    const readOnly = await screen.findByRole("dialog");
    expect(within(readOnly).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("gives a viewer Preview alone, with no Remove", async () => {
    negotiateMethods(BASE_METHODS);
    const harness = mountTeamPage(
      poolSource("viewer"),
      handlers({ list: listed([REVIEW]), hostSkills: [] }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(await screen.findByRole("button", { name: "Preview" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("says skills need a host when the viewing host does not serve the configuration", async () => {
    negotiateMethods(BASE_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({ list: { outcome: "not_served" }, hostSkills: [] }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Skills need a host running Acme.Pick one.",
      );
    });
  });

  it("names Personal on Personal's page and lists for Personal's environment", async () => {
    negotiateMethods(BASE_METHODS);
    const harness = mountTeamPage(
      personalPoolSource(),
      handlers({ list: listed([]), hostSkills: [] }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText(
        "Instructions agents follow for a kind of task. Personal's skills reach every provider on every computer and sandbox running Personal.",
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.skills.list")).toEqual(
        [{ environmentId: "env-personal" }],
      );
    });
    expect(
      await screen.findByText(
        "Skills give agents instructions for a kind of task.",
      ),
    ).toBeTruthy();
  });

  it("says the read failed, naming the configuration, and Retry reads again", async () => {
    negotiateMethods(BASE_METHODS);
    let fail = true;
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([REVIEW]), hostSkills: [] }),
      "environment.configuration.skills.list": () => {
        if (fail) throw new Error("host unavailable");
        return listed([REVIEW]);
      },
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    const failure = await screen.findByText("Couldn't read Acme's skills.");
    fail = false;
    await userEvent.click(
      failure.closest("p")?.querySelector("button") ?? failure,
    );

    expect(await screen.findByText("review")).toBeTruthy();
  });

  it("falls back to the older view on a host that has not negotiated the list", async () => {
    negotiateMethods({ "providers.nativeMutate": { major: 1, minor: 3 } });
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        list: listed([REVIEW]),
        hostSkills: [hostSkill("legacy", "shared")],
      }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("combobox", { name: "Provider for skills" }),
    ).toBeTruthy();
    expect(
      harness.paramsOf("environment.configuration.skills.list"),
    ).toHaveLength(0);
  });
});

describe("A provider's Skills tab on Personal or a team", () => {
  it("heads the card with the configuration and provider, and links to Manage skills", async () => {
    negotiateMethods(SWITCHES);
    const harness = mountTeamPage(
      personalPoolSource(),
      handlers({ list: listed([REVIEW]), hostSkills: [] }),
    );
    render(<EnvironmentProviderSkillsTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    expect(
      await screen.findByRole("heading", {
        name: "Personal's skills · for Claude Code",
      }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Manage skills" }),
    );
    expect(navigation.opened).toEqual(["skills"]);
  });

  it("disables the switches with a line until the host switches per provider, and enables them once it does", async () => {
    negotiateMethods(BASE_METHODS);
    const before = mountTeamPage(
      poolSource("editor"),
      handlers({ list: listed([REVIEW]), hostSkills: [] }),
    );
    const { unmount } = render(
      <EnvironmentProviderSkillsTab providerId="claude-code" />,
      { wrapper: before.Wrapper },
    );

    expect(
      await screen.findByText(
        "Choosing skills per provider isn't available in this version. Every skill reaches every provider.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "review for Claude Code" }),
    ).toHaveProperty("disabled", true);
    unmount();
    cleanup();
    resetTeamPageHarness();

    negotiateMethods(SWITCHES);
    const after = mountTeamPage(
      poolSource("editor"),
      handlers({ list: listed([REVIEW]), hostSkills: [] }),
    );
    render(<EnvironmentProviderSkillsTab providerId="claude-code" />, {
      wrapper: after.Wrapper,
    });

    const enabled = await screen.findByRole("switch", {
      name: "review for Claude Code",
    });
    expect(enabled).toHaveProperty("disabled", false);
    expect(
      screen.queryByText(/Choosing skills per provider isn't available/),
    ).toBeNull();
  });

  it("switches a skill off for this provider alone against the revision it read", async () => {
    negotiateMethods(SWITCHES);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        list: listed([{ ...REVIEW, offFor: ["codex"] }]),
        hostSkills: [],
      }),
    );
    render(<EnvironmentProviderSkillsTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      await screen.findByRole("switch", { name: "review for Claude Code" }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.skills.setProviders"),
      ).toEqual([
        {
          environmentId: "env-a",
          name: "review",
          offFor: ["codex", "claude-code"],
          revision: "rev-1",
        },
      ]);
    });
  });

  it.each([
    {
      move: "off",
      before: ["codex"],
      after: ["codex", "opencode", "traycer", "openrouter", "huggingface"],
    },
    {
      move: "on",
      before: ["codex", "opencode", "traycer", "openrouter", "huggingface"],
      after: ["codex"],
    },
  ])(
    "moves the OpenCode family together when OpenCode's switch goes $move",
    async ({ before, after }) => {
      negotiateMethods(SWITCHES);
      const harness = mountTeamPage(
        poolSource("editor"),
        handlers({
          list: listed([{ ...REVIEW, offFor: before }]),
          hostSkills: [],
        }),
      );
      render(<EnvironmentProviderSkillsTab providerId="opencode" />, {
        wrapper: harness.Wrapper,
      });

      await userEvent.click(
        await screen.findByRole("switch", { name: "review for OpenCode" }),
      );

      await waitFor(() => {
        expect(
          harness.paramsOf("environment.configuration.skills.setProviders"),
        ).toEqual([
          {
            environmentId: "env-a",
            name: "review",
            offFor: after,
            revision: "rev-1",
          },
        ]);
      });
    },
  );

  it("says a built-in skill can't be removed on the provider's tab, and says nothing on a written one", async () => {
    negotiateMethods(SWITCHES);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({ list: listed([REVIEW, BUILT_IN]), hostSkills: [] }),
    );
    render(<EnvironmentProviderSkillsTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    const builtIn = (await screen.findByText("find-skills")).closest("li");
    const written = screen.getByText("review").closest("li");
    expect(builtIn).not.toBeNull();
    expect(written).not.toBeNull();
    if (builtIn === null || written === null) return;
    expect(
      within(builtIn).getByText(
        "Comes with Traycer and can't be removed. Switch it off for any provider that shouldn't use it.",
      ),
    ).toBeTruthy();
    expect(within(written).queryByText(/can't be removed/)).toBeNull();
  });

  it.each([
    { source: personalPoolSource(), word: "Personal" },
    { source: poolSource("editor"), word: "Acme" },
  ])(
    "names the configuration's own skill by $word, never as written in Settings",
    async ({ source, word }) => {
      negotiateMethods(SWITCHES);
      const harness = mountTeamPage(
        source,
        handlers({ list: listed([REVIEW, BUILT_IN]), hostSkills: [] }),
      );
      render(<EnvironmentProviderSkillsTab providerId="claude-code" />, {
        wrapper: harness.Wrapper,
      });

      const written = (await screen.findByText("review")).closest("li");
      const builtIn = screen.getByText("find-skills").closest("li");
      expect(written).not.toBeNull();
      expect(builtIn).not.toBeNull();
      if (written === null || builtIn === null) return;
      expect(within(written).getByText(word)).toBeTruthy();
      expect(within(builtIn).getByText("Built-in")).toBeTruthy();
      expect(screen.queryByText(/written in Settings/)).toBeNull();
    },
  );

  it("names where each on-host skill lives, hides the configuration's names at every scope, and adds one at its scope and folder", async () => {
    negotiateMethods(SWITCHES);
    nativeScopeTargets.current = [
      { path: "/Users/dev/app", name: "app", branch: null, isWorktree: false },
      {
        path: "/Users/dev/app-wt",
        name: "app",
        branch: "feature",
        isWorktree: true,
      },
    ];
    const held: Record<string, readonly ProviderSkill[]> = {
      [hostPlaceKey("global", null)]: [
        hostSkill("review", "provider"),
        hostSkill("scratch", "provider"),
        hostSkill("shared-one", "shared"),
        hostSkill("built", "managed"),
      ],
      [hostPlaceKey("project", "/Users/dev/app")]: [
        hostSkill("review", "provider"),
        hostSkill("proj-only", "provider"),
      ],
      [hostPlaceKey("project", "/Users/dev/app-wt")]: [
        hostSkill("wt-only", "shared"),
      ],
    };
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([REVIEW]), hostSkills: [] }),
      "providers.list": (request) =>
        request.native === null
          ? {
              providers: [projectScopedProviderState("claude-code")],
              native: null,
            }
          : {
              providers: [],
              native: {
                ok: true as const,
                kind: "skills" as const,
                skills: [
                  ...(held[
                    hostPlaceKey(
                      request.native.scope,
                      request.native.workspaceRoot,
                    )
                  ] ?? []),
                ],
              },
            },
    });
    render(<EnvironmentProviderSkillsTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    const card = await screen.findByRole("region", {
      name: "On Mac mini only · not shared",
    });
    await waitFor(() => {
      expect(within(card).getAllByRole("listitem")).toHaveLength(4);
    });
    expect(
      within(card)
        .getAllByRole("listitem")
        .map((row) =>
          Array.from(row.querySelectorAll(":scope > div > div")).map(
            (cell) => cell.textContent,
          ),
        ),
    ).toEqual([
      ["scratch", "folder on this computer"],
      ["shared-one", "folder on this computer"],
      ["proj-only", "folder on this computer · app"],
      ["wt-only", "folder on this computer · app · feature"],
    ]);
    const add = (entry: string): HTMLElement => {
      const row = within(card).getByText(entry).closest("li");
      if (row === null) throw new Error(`no row for ${entry}`);
      return within(row).getByRole("button", { name: "Add to Acme" });
    };
    await userEvent.click(add("scratch"));
    await userEvent.click(add("wt-only"));

    await waitFor(() => {
      expect(harness.paramsOf("providers.nativeMutate")).toEqual([
        {
          providerId: "claude-code",
          mutation: {
            kind: "promoteToPersonal",
            entryKind: "skills",
            scope: "global",
            workspaceRoot: null,
            name: "scratch",
          },
          executableWriteGrant: null,
          expectedEnvironmentId: "env-a",
        },
        {
          providerId: "claude-code",
          mutation: {
            kind: "promoteToPersonal",
            entryKind: "skills",
            scope: "project",
            workspaceRoot: "/Users/dev/app-wt",
            name: "wt-only",
          },
          executableWriteGrant: null,
          expectedEnvironmentId: "env-a",
        },
      ]);
    });
  });
});

describe("A refused skill write", () => {
  const FORBIDDEN = "You no longer have access to change these settings.";

  it.each([
    {
      outcome: "forbidden" as const,
      line: FORBIDDEN,
    },
    {
      outcome: "refused" as const,
      line: "Couldn't save these settings.",
    },
  ])(
    "says $line when a provider switch is answered $outcome",
    async ({ outcome, line }) => {
      negotiateMethods(SWITCHES);
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({ list: listed([REVIEW]), hostSkills: [] }),
        "environment.configuration.skills.setProviders": () => ({
          outcome,
          revision: null,
          reason: null,
        }),
      });
      render(<EnvironmentProviderSkillsTab providerId="claude-code" />, {
        wrapper: harness.Wrapper,
      });

      await userEvent.click(
        await screen.findByRole("switch", { name: "review for Claude Code" }),
      );

      expect((await screen.findByRole("status")).textContent).toBe(line);
    },
  );

  it("shows the conflict line when a provider switch is answered stale", async () => {
    negotiateMethods(SWITCHES);
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([REVIEW]), hostSkills: [] }),
      "environment.configuration.skills.setProviders": () => ({
        outcome: "stale" as const,
        revision: "rev-9",
        reason: null,
      }),
    });
    render(<EnvironmentProviderSkillsTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      await screen.findByRole("switch", { name: "review for Claude Code" }),
    );

    expect(
      await screen.findByText("Changed by another member a moment ago"),
    ).toBeTruthy();
  });

  it.each([
    { outcome: "forbidden" as const, line: FORBIDDEN },
    { outcome: "refused" as const, line: "Couldn't remove this skill." },
  ])(
    "says $line when a removal is answered $outcome",
    async ({ outcome, line }) => {
      negotiateMethods(BASE_METHODS);
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({ list: listed([REVIEW]), hostSkills: [] }),
        "environment.configuration.skills.remove": () => ({
          outcome,
          reason: null,
        }),
      });
      render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

      await userEvent.click(
        await screen.findByRole("button", { name: "Remove" }),
      );
      await userEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", {
          name: "Remove skill",
        }),
      );

      await waitFor(() => {
        expect(
          harness.paramsOf("environment.configuration.skills.remove"),
        ).toHaveLength(1);
      });
      expect((await screen.findByRole("status")).textContent).toBe(line);
    },
  );
});

describe("A provider's skill switch while its own write is in flight", () => {
  /** The page's own read cadence for the skills list. */
  const POLL_MS = 5_000;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The OpenCode family a switch moves as one. */
  const FAMILY = ["opencode", "traycer", "openrouter", "huggingface"];

  type SetAnswer = {
    readonly outcome: "saved" | "forbidden" | "refused";
    readonly revision: string | null;
    readonly reason: null;
  };
  interface Gate {
    readonly promise: Promise<SetAnswer>;
    readonly resolve: (answer: SetAnswer) => void;
    readonly reject: (error: Error) => void;
  }

  function gate(): Gate {
    let resolve: Gate["resolve"] = () => undefined;
    let reject: Gate["reject"] = () => undefined;
    const promise = new Promise<SetAnswer>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  const SAVED: SetAnswer = {
    outcome: "saved",
    revision: "rev-2",
    reason: null,
  };

  /** The host's own switch state and the write it has been asked to make. */
  function mountSwitch(providerId: ProviderId, offFor: readonly string[]) {
    negotiateMethods(SWITCHES);
    const world: { offFor: readonly string[] } = { offFor };
    const write = gate();
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([REVIEW]), hostSkills: [] }),
      "environment.configuration.skills.list": () =>
        listed([{ ...REVIEW, offFor: [...world.offFor] }]),
      "environment.configuration.skills.setProviders": () => write.promise,
    });
    render(<EnvironmentProviderSkillsTab providerId={providerId} />, {
      wrapper: harness.Wrapper,
    });
    const switchOf = (label: string): HTMLElement =>
      screen.getByRole("switch", { name: `review for ${label}` });
    const writes = (): number =>
      harness.paramsOf("environment.configuration.skills.setProviders").length;
    const listReads = (): number =>
      harness.paramsOf("environment.configuration.skills.list").length;
    /** The host's state changes; the page's own poll reads it a cadence later. */
    const observe = async (next: readonly string[]): Promise<void> => {
      world.offFor = next;
      const before = listReads();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS);
      });
      await waitFor(() => {
        expect(listReads()).toBeGreaterThan(before);
      });
    };
    const answer = async (result: SetAnswer): Promise<void> => {
      await act(async () => {
        write.resolve(result);
        await Promise.resolve();
      });
    };
    return { harness, write, switchOf, writes, listReads, observe, answer };
  }

  const click = (element: HTMLElement): void => {
    fireEvent.click(element);
  };
  const on = (element: HTMLElement): boolean =>
    element.getAttribute("aria-checked") === "true";
  const disabled = (element: HTMLElement): boolean =>
    element instanceof HTMLButtonElement && element.disabled;

  it("shows the submitted position at once and holds the switch disabled until a read matches it", async () => {
    const { switchOf, writes, listReads, observe, answer } = mountSwitch(
      "claude-code",
      [],
    );
    await screen.findByRole("switch", { name: "review for Claude Code" });
    expect(on(switchOf("Claude Code"))).toBe(true);

    click(switchOf("Claude Code"));

    // In flight: the position asked for, and no second write possible.
    expect(on(switchOf("Claude Code"))).toBe(false);
    expect(disabled(switchOf("Claude Code"))).toBe(true);
    await waitFor(() => expect(writes()).toBe(1));
    click(switchOf("Claude Code"));
    expect(writes()).toBe(1);

    // Accepted, and the read that follows still shows the old state: the
    // switch must not snap back, and stays disabled.
    const reads = listReads();
    await answer(SAVED);
    await waitFor(() => expect(listReads()).toBeGreaterThan(reads));
    expect(on(switchOf("Claude Code"))).toBe(false);
    expect(disabled(switchOf("Claude Code"))).toBe(true);

    // A read that shows it off for this provider: the switch is the host's,
    // and usable again.
    await observe(["claude-code"]);
    await waitFor(() => {
      expect(disabled(switchOf("Claude Code"))).toBe(false);
    });
    expect(on(switchOf("Claude Code"))).toBe(false);
    expect(writes()).toBe(1);
  });

  it("holds OpenCode's switch until a read shows the whole family off, not one member", async () => {
    const { harness, switchOf, observe, answer } = mountSwitch("opencode", []);
    await screen.findByRole("switch", { name: "review for OpenCode" });

    click(switchOf("OpenCode"));
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.skills.setProviders"),
      ).toEqual([
        {
          environmentId: "env-a",
          name: "review",
          offFor: FAMILY,
          revision: "rev-1",
        },
      ]);
    });
    await answer(SAVED);

    // Only OpenCode itself reads off: the family has not all moved yet.
    await observe(["opencode"]);
    expect(on(switchOf("OpenCode"))).toBe(false);
    expect(disabled(switchOf("OpenCode"))).toBe(true);

    await observe(FAMILY);
    await waitFor(() => {
      expect(disabled(switchOf("OpenCode"))).toBe(false);
    });
    expect(on(switchOf("OpenCode"))).toBe(false);
  });

  it.each([
    { change: "removed", skills: [BUILT_IN] },
    {
      change: "switched for different providers",
      skills: [{ ...REVIEW, offFor: ["codex"] }, BUILT_IN],
    },
  ])(
    "unlocks the provider card when an accepted skill is $change by another member",
    async ({ skills }) => {
      negotiateMethods(SWITCHES);
      const write = gate();
      let resolveRead: (
        answer: EnvironmentConfigurationSkillsListResponse,
      ) => void = () => undefined;
      let nextRead = new Promise<EnvironmentConfigurationSkillsListResponse>(
        (resolve) => {
          resolveRead = resolve;
        },
      );
      let readingAfterWrite = false;
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({ list: listed([REVIEW, BUILT_IN]), hostSkills: [] }),
        "environment.configuration.skills.list": () =>
          readingAfterWrite ? nextRead : listed([REVIEW, BUILT_IN]),
        "environment.configuration.skills.setProviders": () => {
          readingAfterWrite = true;
          return write.promise;
        },
      });
      render(<EnvironmentProviderSkillsTab providerId="claude-code" />, {
        wrapper: harness.Wrapper,
      });
      click(
        await screen.findByRole("switch", { name: "review for Claude Code" }),
      );
      const otherSwitch = (): HTMLElement =>
        screen.getByRole("switch", { name: "find-skills for Claude Code" });
      expect(disabled(otherSwitch())).toBe(true);
      await act(async () => {
        write.resolve(SAVED);
        await write.promise;
      });
      await waitFor(() => expect(harness.queryClient.isMutating()).toBe(0));
      expect(disabled(otherSwitch())).toBe(true);

      // An unchanged-revision read still holds the submitted position.
      await act(async () => {
        resolveRead(listed([REVIEW, BUILT_IN]));
        await nextRead;
      });
      const skillList = {
        predicate: (query: { readonly queryKey: readonly unknown[] }) =>
          query.queryKey.includes("environment.configuration.skills.list"),
      };
      await waitFor(() =>
        expect(harness.queryClient.isFetching(skillList)).toBe(0),
      );
      expect(disabled(otherSwitch())).toBe(true);

      // The accepted write is superseded before its result reaches the list.
      nextRead = Promise.resolve({
        outcome: "listed",
        revision: "rev-3",
        skills,
      });
      await act(async () => harness.queryClient.refetchQueries(skillList));
      await waitFor(() => expect(disabled(otherSwitch())).toBe(false));
      if (skills.some((skill) => skill.name === REVIEW.name)) {
        expect(
          on(screen.getByRole("switch", { name: "review for Claude Code" })),
        ).toBe(true);
      } else {
        expect(
          screen.queryByRole("switch", { name: "review for Claude Code" }),
        ).toBeNull();
      }
      click(otherSwitch());
      await waitFor(() => {
        expect(
          harness.paramsOf("environment.configuration.skills.setProviders"),
        ).toEqual([
          {
            environmentId: "env-a",
            name: "review",
            offFor: ["claude-code"],
            revision: "rev-1",
          },
          {
            environmentId: "env-a",
            name: "find-skills",
            offFor: ["claude-code"],
            revision: "rev-3",
          },
        ]);
      });
    },
  );

  it.each([
    { outcome: "refused" as const, line: "Couldn't save these settings." },
    {
      outcome: "forbidden" as const,
      line: "You no longer have access to change these settings.",
    },
  ])(
    "puts the switch back to the host's state and re-enables it when the write is answered $outcome",
    async ({ outcome, line }) => {
      const { switchOf, answer } = mountSwitch("claude-code", []);
      await screen.findByRole("switch", { name: "review for Claude Code" });

      click(switchOf("Claude Code"));
      expect(on(switchOf("Claude Code"))).toBe(false);
      await answer({ outcome, revision: null, reason: null });

      await waitFor(() => {
        expect(on(switchOf("Claude Code"))).toBe(true);
      });
      expect(disabled(switchOf("Claude Code"))).toBe(false);
      expect((await screen.findByRole("status")).textContent).toBe(line);
    },
  );

  it("puts the switch back and re-enables it when the write itself fails", async () => {
    const { switchOf, write } = mountSwitch("claude-code", []);
    await screen.findByRole("switch", { name: "review for Claude Code" });

    click(switchOf("Claude Code"));
    expect(on(switchOf("Claude Code"))).toBe(false);
    await act(async () => {
      write.reject(new Error("the host could not be reached"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(on(switchOf("Claude Code"))).toBe(true);
    });
    expect(disabled(switchOf("Claude Code"))).toBe(false);
  });
});
