import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  EnvironmentConfigurationSkillImportResponse,
  EnvironmentConfigurationSkillsListResponseV11,
  EnvironmentSkillV11,
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
  negotiateMethodsOn,
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
// The detail dialog reads SKILL.md off disk: the bytes are read again only
// when the dialog's dependencies move, as a query keyed on them is.
const skillFile = vi.hoisted(() => ({
  text: "---\nname: review\n---\n\n# Use\n",
}));
vi.mock("@/hooks/workspace/use-read-file-query", async () => {
  const react = await import("react");
  return {
    useWorkspaceReadFile: (
      _client: unknown,
      _directory: string,
      _file: string,
      dependencies: readonly unknown[],
    ) => {
      const key = JSON.stringify(dependencies);
      const read = react.useRef<{ key: string; content: string } | null>(null);
      if (read.current === null || read.current.key !== key)
        read.current = { key, content: skillFile.text };
      return {
        data: { content: read.current.content, truncated: false, error: null },
        isPending: false,
        isError: false,
        error: null,
      };
    },
  };
});
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
  skillFile.text = "---\nname: review\n---\n\n# Use\n";
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
const LIST_V11 = { major: 1, minor: 1 };
const BASE_METHODS = {
  "environment.configuration.skills.list": LIST_V11,
  "environment.configuration.skills.remove": LIST,
  "providers.nativeMutate": { major: 1, minor: 3 },
} as const;
const SWITCHES = {
  ...BASE_METHODS,
  "environment.configuration.skills.setProviders": LIST,
} as const;

const REVIEW: EnvironmentSkillV11 = {
  name: "review",
  description: "Review a change.",
  origin: "room",
  edited: false,
  offFor: [],
  policy: "evolve",
  version: null,
  updateAvailable: false,
  upstream: null,
};
const BUILT_IN: EnvironmentSkillV11 = {
  name: "find-skills",
  description: "Discover skills.",
  origin: "bundled",
  edited: false,
  offFor: [],
  policy: "auto-update",
  version: "1.0.0",
  updateAvailable: false,
  upstream: null,
};

function handlers(options: {
  readonly list: EnvironmentConfigurationSkillsListResponseV11;
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
  skills: readonly EnvironmentSkillV11[],
  policyRevision: string | null,
): EnvironmentConfigurationSkillsListResponseV11 {
  return {
    outcome: "listed",
    revision: "rev-1",
    policyRevision,
    skills: [...skills],
    deletedBundled: [],
  };
}

describe("The Skills page", () => {
  it("shows an uploaded skill without a remount", async () => {
    negotiateMethods({
      ...BASE_METHODS,
      "environment.configuration.skills.upload": LIST,
    });
    let uploaded = false;
    const base = handlers({
      list: listed([BUILT_IN], "pol-1"),
      hostSkills: [],
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...base,
      "environment.configuration.skills.list": () =>
        listed(uploaded ? [REVIEW, BUILT_IN] : [BUILT_IN], "pol-1"),
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
      const base = handlers({
        list: listed([REVIEW], "pol-1"),
        hostSkills: [],
      });
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
    const base = handlers({
      list: listed([REVIEW], "pol-1"),
      hostSkills: [managed],
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...base,
      "environment.configuration.skills.list": () =>
        listed([{ ...REVIEW, description }], "pol-1"),
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
      handlers({ list: listed([REVIEW, BUILT_IN], "pol-1"), hostSkills: [] }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("all providers")).toBeTruthy();
    expect(screen.getByText("Built-in · 1.0.0 · all providers")).toBeTruthy();
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
        list: listed([{ ...REVIEW, offFor: ["claude-code"] }], "pol-1"),
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
        list: listed(
          [
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
          ],
          "pol-1",
        ),
        hostSkills: [],
      }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Codex only")).toBeTruthy();
  });

  it("offers Edit on a written skill and Preview, with Remove, on a built-in one", async () => {
    negotiateMethods(BASE_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({ list: listed([REVIEW, BUILT_IN], "pol-1"), hostSkills: [] }),
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
      within(builtIn).getByRole("button", { name: "Remove" }),
    ).toBeTruthy();
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
        handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
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
      handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
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
        list: listed([REVIEW, BUILT_IN], "pol-1"),
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
      handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
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
      handlers({ list: listed([], "pol-1"), hostSkills: [] }),
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
      ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
      "environment.configuration.skills.list": () => {
        if (fail) throw new Error("host unavailable");
        return listed([REVIEW], "pol-1");
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
        list: listed([REVIEW], "pol-1"),
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
      handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
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
      handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
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
      handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
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
        list: listed([{ ...REVIEW, offFor: ["codex"] }], "pol-1"),
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
          list: listed([{ ...REVIEW, offFor: before }], "pol-1"),
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

  it("says a built-in skill comes with Traycer on the provider's tab, and says nothing on a written one", async () => {
    negotiateMethods(SWITCHES);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({ list: listed([REVIEW, BUILT_IN], "pol-1"), hostSkills: [] }),
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
        "Comes with Traycer. Switch it off for any provider that shouldn't use it.",
      ),
    ).toBeTruthy();
    expect(within(written).queryByText(/Comes with Traycer/)).toBeNull();
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
        handlers({ list: listed([REVIEW, BUILT_IN], "pol-1"), hostSkills: [] }),
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
      ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
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
      ["scratch", "all projects"],
      ["shared-one", "all projects"],
      ["proj-only", "app"],
      ["wt-only", "app · feature"],
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
        ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
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
      ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
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
        ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
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

describe("The Skills page's update policies", () => {
  const POLICIES = {
    ...BASE_METHODS,
    "environment.configuration.skills.setPolicy": LIST,
  } as const;
  const FROZEN: EnvironmentSkillV11 = {
    ...REVIEW,
    name: "locked",
    policy: "frozen",
  };
  const saved = {
    outcome: "saved" as const,
    revision: "pol-2",
    reason: null,
  };
  const stale = {
    outcome: "stale" as const,
    revision: "pol-2",
    reason: null,
  };

  function rowOf(name: string): HTMLElement {
    const row = screen.getByText(name).closest("li");
    if (row === null) throw new Error(`no row for ${name}`);
    return row;
  }

  it("offers Preview and not Edit on a frozen skill, and Edit on an evolve one", async () => {
    negotiateMethods(POLICIES);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({ list: listed([REVIEW, FROZEN], "pol-1"), hostSkills: [] }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await screen.findByText("review");
    const frozen = rowOf("locked");
    expect(
      within(frozen).getByRole("button", { name: "Preview" }),
    ).toBeTruthy();
    expect(within(frozen).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      within(rowOf("review")).getByRole("button", { name: "Edit" }),
    ).toBeTruthy();
  });

  it("sends the chosen policy with the list's policy revision", async () => {
    negotiateMethods(POLICIES);
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
      "environment.configuration.skills.setPolicy": () => saved,
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await screen.findByText("review");
    await userEvent.click(
      within(rowOf("review")).getByRole("button", { name: "Frozen" }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.skills.setPolicy"),
      ).toEqual([
        {
          environmentId: "env-a",
          name: "review",
          policy: "frozen",
          revision: "pol-1",
        },
      ]);
    });
  });

  it("lists again on a stale answer and sends once more against the new revision", async () => {
    negotiateMethods(POLICIES);
    let moved = false;
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
      "environment.configuration.skills.list": () =>
        listed([REVIEW], moved ? "pol-2" : "pol-1"),
      "environment.configuration.skills.setPolicy": () => {
        const first = !moved;
        moved = true;
        return first ? stale : saved;
      },
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await screen.findByText("review");
    await userEvent.click(
      within(rowOf("review")).getByRole("button", { name: "Frozen" }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.skills.setPolicy"),
      ).toMatchObject([{ revision: "pol-1" }, { revision: "pol-2" }]);
    });
    // The retry's answer is handled once the control is free again.
    await waitFor(() => {
      expect(
        within(rowOf("review"))
          .getByRole("group", { name: "Updates for review" })
          .getAttribute("aria-disabled"),
      ).toBeNull();
    });
    expect(screen.queryByText(/Changed by/)).toBeNull();
  });

  it("shows the conflict line, rather than sending a third time, when the retry is stale too", async () => {
    negotiateMethods(POLICIES);
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
      "environment.configuration.skills.setPolicy": () => stale,
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await screen.findByText("review");
    await userEvent.click(
      within(rowOf("review")).getByRole("button", { name: "Frozen" }),
    );

    expect(
      await screen.findByText("Changed by another member a moment ago"),
    ).toBeTruthy();
    expect(
      harness.paramsOf("environment.configuration.skills.setPolicy"),
    ).toHaveLength(2);
  });

  it("asks before letting an auto-update skill evolve, and sends only once confirmed", async () => {
    negotiateMethods(POLICIES);
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([BUILT_IN], "pol-1"), hostSkills: [] }),
      "environment.configuration.skills.setPolicy": () => saved,
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await screen.findByText("find-skills");
    await userEvent.click(
      within(rowOf("find-skills")).getByRole("button", { name: "Evolve" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      harness.paramsOf("environment.configuration.skills.setPolicy"),
    ).toEqual([]);

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Stop updates" }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.skills.setPolicy"),
      ).toEqual([
        {
          environmentId: "env-a",
          name: "find-skills",
          policy: "evolve",
          revision: "pol-1",
        },
      ]);
    });
  });

  describe("update and restore", () => {
    // The viewing host advertises the writes only it can make.
    const negotiateHosted = (): void => {
      negotiateMethods(POLICIES);
      negotiateMethodsOn(reachableHost.hostId, {
        "environment.configuration.skills.update": LIST,
        "environment.configuration.skills.restoreBundled": LIST,
      });
    };
    const UPDATE = "environment.configuration.skills.update";
    const applied = { outcome: "applied" as const, reason: null };
    const hasEdits = {
      outcome: "refused" as const,
      reason: "has_edits" as const,
    };
    const available = (
      policy: "evolve" | "frozen",
      edited: boolean,
    ): EnvironmentSkillV11 => ({
      ...REVIEW,
      policy,
      edited,
      updateAvailable: true,
    });

    it.each(["evolve", "frozen"] as const)(
      "asks before updating an edited %s skill, and sends the update with the confirm",
      async (policy) => {
        negotiateHosted();
        const harness = mountTeamPage(poolSource("editor"), {
          ...handlers({
            list: listed([available(policy, true)], "pol-1"),
            hostSkills: [],
          }),
          [UPDATE]: () => applied,
        });
        render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

        await userEvent.click(
          await screen.findByRole("button", { name: "Update now" }),
        );
        const dialog = await screen.findByRole("dialog");
        expect(harness.paramsOf(UPDATE)).toEqual([]);
        await userEvent.click(
          within(dialog).getByRole("button", { name: "Update now" }),
        );

        await waitFor(() => {
          expect(harness.paramsOf(UPDATE)).toEqual([
            { environmentId: "env-a", name: "review", confirm: true },
          ]);
        });
      },
    );

    it("opens the confirm when the host answers has_edits to an update the page thought was clean", async () => {
      negotiateHosted();
      let first = true;
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({
          list: listed([available("frozen", false)], "pol-1"),
          hostSkills: [],
        }),
        [UPDATE]: () => {
          const answer = first ? hasEdits : applied;
          first = false;
          return answer;
        },
      });
      render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

      await userEvent.click(
        await screen.findByRole("button", { name: "Update now" }),
      );
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Update now" }),
      );

      await waitFor(() => {
        expect(harness.paramsOf(UPDATE)).toEqual([
          { environmentId: "env-a", name: "review", confirm: false },
          { environmentId: "env-a", name: "review", confirm: true },
        ]);
      });
    });

    it("shows the new version and the new bytes in an open skill's dialog once its update is applied", async () => {
      negotiateHosted();
      let updated = false;
      const row = (): EnvironmentSkillV11 => ({
        ...REVIEW,
        origin: "bundled",
        policy: "frozen",
        version: updated ? "2.0.0" : "1.0.0",
        updateAvailable: !updated,
      });
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({
          list: listed([row()], "pol-1"),
          hostSkills: [hostSkill("review", "managed")],
        }),
        "environment.configuration.skills.list": () => listed([row()], "pol-1"),
        [UPDATE]: () => {
          updated = true;
          skillFile.text =
            "---\nname: review\n---\n\n# Use the second edition\n";
          return applied;
        },
      });
      render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

      await screen.findByText("review");
      await userEvent.click(
        within(rowOf("review")).getByRole("button", { name: "Preview" }),
      );
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByText("Built-in · 1.0.0")).toBeTruthy();
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Update from source" }),
      );

      expect(await within(dialog).findByText("Built-in · 2.0.0")).toBeTruthy();
      expect(
        await within(dialog).findByText(/Use the second edition/),
      ).toBeTruthy();
      expect(screen.getByRole("dialog")).toBe(dialog);
    });

    it("disables Edit and Update from source in an open dialog while the update is pending, and frees both once it lands", async () => {
      negotiateHosted();
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reread = false;
      const row = (): EnvironmentSkillV11 => ({
        ...REVIEW,
        origin: "bundled",
        policy: "evolve",
        // A further update stays available, so the button is still drawn.
        version: reread ? "2.0.0" : "1.0.0",
        updateAvailable: true,
      });
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({
          list: listed([row()], "pol-1"),
          hostSkills: [hostSkill("review", "managed")],
        }),
        "environment.configuration.skills.list": () => listed([row()], "pol-1"),
        [UPDATE]: async () => {
          await held;
          reread = true;
          return applied;
        },
      });
      render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

      await screen.findByText("review");
      await userEvent.click(
        within(rowOf("review")).getByRole("button", { name: "Edit" }),
      );
      const dialog = await screen.findByRole("dialog");
      const update = await within(dialog).findByRole("button", {
        name: "Update from source",
      });
      const edit = within(dialog).getByRole("button", { name: "Edit" });
      expect(update.hasAttribute("disabled")).toBe(false);
      expect(edit.hasAttribute("disabled")).toBe(false);

      await userEvent.click(update);

      await waitFor(() => {
        expect(harness.paramsOf(UPDATE)).toHaveLength(1);
      });
      const pending = within(dialog).getByRole("button", {
        name: "Update from source",
      });
      expect(pending.hasAttribute("disabled")).toBe(true);
      expect(
        within(dialog)
          .getByRole("button", { name: "Edit" })
          .hasAttribute("disabled"),
      ).toBe(true);

      release();

      await waitFor(() => {
        expect(
          within(dialog)
            .getByRole("button", { name: "Update from source" })
            .hasAttribute("disabled"),
        ).toBe(false);
        expect(
          within(dialog)
            .getByRole("button", { name: "Edit" })
            .hasAttribute("disabled"),
        ).toBe(false);
      });
    });

    describe("while the page rereads the list", () => {
      const LIST_METHOD = "environment.configuration.skills.list";

      it("holds the row's policy control disabled through the reread of a stale answer, and frees it once the reread lands", async () => {
        negotiateHosted();
        let gate: Promise<void> | null = null;
        let release: () => void = () => undefined;
        let waiting = 0;
        let chosen = false;
        const harness = mountTeamPage(poolSource("editor"), {
          ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
          [LIST_METHOD]: async () => {
            if (gate !== null) {
              waiting += 1;
              await gate;
            }
            // The reread shows the skill already holding the choice.
            return listed(
              [{ ...REVIEW, policy: chosen ? "frozen" : "evolve" }],
              "pol-2",
            );
          },
          "environment.configuration.skills.setPolicy": () => {
            chosen = true;
            gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            return stale;
          },
        });
        render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

        await screen.findByText("review");
        const group = within(rowOf("review")).getByRole("group", {
          name: "Updates for review",
        });
        await userEvent.click(
          within(group).getByRole("button", { name: "Frozen" }),
        );

        await waitFor(() => {
          expect(waiting).toBeGreaterThan(0);
        });
        expect(group.getAttribute("aria-disabled")).toBe("true");

        release();

        await waitFor(() => {
          expect(group.getAttribute("aria-disabled")).toBeNull();
        });
        expect(
          harness.paramsOf("environment.configuration.skills.setPolicy"),
        ).toHaveLength(1);
      });

      it("keeps Edit and Update from source disabled in an open dialog through the reread after an applied update", async () => {
        negotiateHosted();
        let gate: Promise<void> | null = null;
        let release: () => void = () => undefined;
        let waiting = 0;
        const row: EnvironmentSkillV11 = {
          ...REVIEW,
          origin: "bundled",
          policy: "evolve",
          updateAvailable: true,
        };
        const harness = mountTeamPage(poolSource("editor"), {
          ...handlers({
            list: listed([row], "pol-1"),
            hostSkills: [hostSkill("review", "managed")],
          }),
          [LIST_METHOD]: async () => {
            if (gate !== null) {
              waiting += 1;
              await gate;
            }
            return listed([row], "pol-1");
          },
          [UPDATE]: () => {
            gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            return applied;
          },
        });
        render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

        await screen.findByText("review");
        await userEvent.click(
          within(rowOf("review")).getByRole("button", { name: "Edit" }),
        );
        const dialog = await screen.findByRole("dialog");
        await userEvent.click(
          await within(dialog).findByRole("button", {
            name: "Update from source",
          }),
        );

        // The update has been answered; its reread is the one held.
        await waitFor(() => {
          expect(waiting).toBeGreaterThan(0);
        });
        for (const name of ["Edit", "Update from source"])
          expect(
            within(dialog)
              .getByRole("button", { name })
              .hasAttribute("disabled"),
          ).toBe(true);

        release();

        await waitFor(() => {
          for (const name of ["Edit", "Update from source"])
            expect(
              within(dialog)
                .getByRole("button", { name })
                .hasAttribute("disabled"),
            ).toBe(false);
        });
      });
    });

    it("restores a deleted built-in from the fold", async () => {
      negotiateHosted();
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
        "environment.configuration.skills.list": () => ({
          ...listed([REVIEW], "pol-1"),
          deletedBundled: ["old-skill"],
        }),
        "environment.configuration.skills.restoreBundled": () => ({
          outcome: "restored" as const,
          reason: null,
        }),
      });
      render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

      await userEvent.click(
        await screen.findByRole("button", { name: "Deleted built-ins" }),
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "Restore" }),
      );

      await waitFor(() => {
        expect(
          harness.paramsOf("environment.configuration.skills.restoreBundled"),
        ).toEqual([{ environmentId: "env-a", name: "old-skill" }]);
      });
    });
  });

  it("asks before putting an edited built-in back on Auto-update, and sends only once confirmed", async () => {
    negotiateMethods(POLICIES);
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({
        list: listed(
          [{ ...BUILT_IN, policy: "evolve", edited: true }],
          "pol-1",
        ),
        hostSkills: [],
      }),
      "environment.configuration.skills.setPolicy": () => saved,
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await screen.findByText("find-skills");
    await userEvent.click(
      within(rowOf("find-skills")).getByRole("button", {
        name: "Auto-update",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      harness.paramsOf("environment.configuration.skills.setPolicy"),
    ).toEqual([]);

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Replace changes" }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.skills.setPolicy"),
      ).toMatchObject([{ name: "find-skills", policy: "auto-update" }]);
    });
  });

  it("opens the Auto-update confirm instead of retrying when the reread shows the skill edited, and confirms against the reread's revision", async () => {
    negotiateMethods(POLICIES);
    let reread = false;
    const clean: EnvironmentSkillV11 = {
      ...BUILT_IN,
      policy: "evolve",
      edited: false,
    };
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([clean], "pol-1"), hostSkills: [] }),
      "environment.configuration.skills.list": () =>
        reread
          ? listed([{ ...clean, edited: true }], "pol-2")
          : listed([clean], "pol-1"),
      "environment.configuration.skills.setPolicy": () => {
        const first = !reread;
        reread = true;
        return first ? stale : saved;
      },
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await screen.findByText("find-skills");
    await userEvent.click(
      within(rowOf("find-skills")).getByRole("button", {
        name: "Auto-update",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      harness.paramsOf("environment.configuration.skills.setPolicy"),
    ).toHaveLength(1);

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Replace changes" }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.skills.setPolicy"),
      ).toMatchObject([{ revision: "pol-1" }, { revision: "pol-2" }]);
    });
  });

  it("offers Auto-update on a built-in and not on a skill with nothing to follow", async () => {
    negotiateMethods(POLICIES);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({ list: listed([REVIEW, BUILT_IN], "pol-1"), hostSkills: [] }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await screen.findByText("review");
    expect(
      within(rowOf("find-skills")).getByRole("button", {
        name: "Auto-update",
      }),
    ).toBeTruthy();
    expect(
      within(rowOf("review")).queryByRole("button", { name: "Auto-update" }),
    ).toBeNull();
  });
});

describe("The Skills page's skills from a source", () => {
  const STATE = "environment.configuration.skills.state";
  const UPDATE = "environment.configuration.skills.update";
  const IMPORT = "environment.configuration.skills.import";
  const UPSTREAM = { source: "https://github.com/acme/skills.git", ref: "dev" };
  const FROM_SOURCE: EnvironmentSkillV11 = {
    ...REVIEW,
    name: "triage",
    upstream: UPSTREAM,
  };

  /** The viewing host advertises the methods only it can answer. */
  function negotiateHosted(
    extra: Record<string, { major: number; minor: number }>,
  ): void {
    negotiateMethods(BASE_METHODS);
    negotiateMethodsOn(reachableHost.hostId, extra);
  }
  const listedState = (
    skills: readonly {
      name: string;
      version: string | null;
      updateAvailable: boolean;
    }[],
    deletedBundled: readonly string[],
  ) => ({
    outcome: "listed" as const,
    skills: [...skills],
    deletedBundled: [...deletedBundled],
  });

  it("shows the badge and Update now when the viewing host's state finds an update the pool's list does not", async () => {
    negotiateHosted({ [STATE]: LIST, [UPDATE]: LIST });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([FROM_SOURCE], "pol-1"), hostSkills: [] }),
      [STATE]: () =>
        listedState(
          [{ name: "triage", version: "2.0.0", updateAvailable: true }],
          [],
        ),
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Update available")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy();
  });

  it("lists the deleted built-ins the state names in place of the list's", async () => {
    negotiateHosted({ [STATE]: LIST });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
      "environment.configuration.skills.list": () => ({
        ...listed([REVIEW], "pol-1"),
        deletedBundled: ["from-list"],
      }),
      [STATE]: () => listedState([], ["from-state"]),
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Deleted built-ins" }),
    );
    expect(await screen.findByText("from-state")).toBeTruthy();
    expect(screen.queryByText("from-list")).toBeNull();
  });

  it("shows where a skill from a source came from under its name", async () => {
    negotiateHosted({ [STATE]: LIST });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([FROM_SOURCE], "pol-1"), hostSkills: [] }),
      [STATE]: () => listedState([], []),
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText("From github.com/acme/skills · dev"),
    ).toBeTruthy();
  });

  it("offers Check for updates only beside a skill with a source, and checks with a refresh", async () => {
    negotiateHosted({ [STATE]: LIST });
    const without = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
      [STATE]: () => listedState([], []),
    });
    const first = render(<EnvironmentSkillsPage />, {
      wrapper: without.Wrapper,
    });
    await screen.findByText("review");
    expect(
      screen.queryByRole("button", { name: "Check for updates" }),
    ).toBeNull();
    first.unmount();
    cleanup();

    negotiateHosted({ [STATE]: LIST });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([FROM_SOURCE], "pol-1"), hostSkills: [] }),
      [STATE]: () => listedState([], []),
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Check for updates" }),
    );
    await waitFor(() => {
      expect(harness.paramsOf(STATE)).toContainEqual({
        environmentId: "env-a",
        refresh: true,
      });
    });
  });

  it("says the source could not be reached when Update now is answered fetch_failed", async () => {
    negotiateHosted({ [STATE]: LIST, [UPDATE]: LIST });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ list: listed([FROM_SOURCE], "pol-1"), hostSkills: [] }),
      [STATE]: () =>
        listedState(
          [{ name: "triage", version: null, updateAvailable: true }],
          [],
        ),
      [UPDATE]: () => ({
        outcome: "refused" as const,
        reason: "fetch_failed" as const,
      }),
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Update now" }),
    );
    expect(
      await screen.findByText(
        "Couldn't reach this skill's source. Try again later.",
      ),
    ).toBeTruthy();
  });

  describe("Import from source", () => {
    const candidates = [
      {
        name: "triage",
        description: null,
        relPath: "skills/triage",
        installed: false,
      },
      {
        name: "review",
        description: null,
        relPath: "skills/review",
        installed: true,
      },
    ];
    const inspected: EnvironmentConfigurationSkillImportResponse = {
      outcome: "inspected",
      token: "tok-1",
      commitSha: "a".repeat(40),
      candidates,
    };

    async function readSource(
      answers: (request: {
        readonly step: "inspect" | "install";
      }) => EnvironmentConfigurationSkillImportResponse,
    ) {
      negotiateHosted({ [STATE]: LIST, [IMPORT]: LIST });
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
        [STATE]: () => listedState([], []),
        [IMPORT]: (request) => answers(request),
      });
      render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });
      await userEvent.click(
        await screen.findByRole("button", { name: "Import from source" }),
      );
      const dialog = await screen.findByRole("dialog");
      await userEvent.type(
        within(dialog).getByLabelText("Skill source"),
        "acme/skills",
      );
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Read source" }),
      );
      return { harness, dialog };
    }

    it("reads the source, leaves an installed skill unchecked, installs the rest and closes", async () => {
      const { harness, dialog } = await readSource((request) =>
        request.step === "inspect"
          ? inspected
          : { outcome: "installed", names: ["triage"] },
      );

      expect(
        (
          await within(dialog).findByRole("checkbox", { name: "triage" })
        ).getAttribute("data-state"),
      ).toBe("checked");
      expect(
        within(dialog)
          .getByRole("checkbox", { name: "review" })
          .getAttribute("data-state"),
      ).toBe("unchecked");
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Import 1 skill" }),
      );

      await waitFor(() => {
        expect(harness.paramsOf(IMPORT)).toEqual([
          { step: "inspect", environmentId: "env-a", source: "acme/skills" },
          {
            step: "install",
            environmentId: "env-a",
            token: "tok-1",
            names: ["triage"],
          },
        ]);
      });
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
    });

    it("selects the first 64 of 70 uninstalled skills, stops at the cap, and installs exactly those in order", async () => {
      const many = Array.from({ length: 70 }, (_, index) => {
        const name = `skill-${String(index + 1).padStart(2, "0")}`;
        return {
          name,
          description: null,
          relPath: `skills/${name}`,
          installed: false,
        };
      });
      const names = many.map((candidate) => candidate.name);
      const { harness, dialog } = await readSource((request) =>
        request.step === "inspect"
          ? { ...inspected, candidates: many }
          : { outcome: "installed", names: names.slice(0, 64) },
      );
      const box = (name: string) =>
        within(dialog).getByRole("checkbox", { name });

      await within(dialog).findByRole("checkbox", { name: "skill-01" });
      expect(
        within(dialog).getByText("You can import up to 64 skills at a time."),
      ).toBeTruthy();
      expect(within(dialog).getByText("64 of 70 selected")).toBeTruthy();
      expect(box("skill-64").getAttribute("data-state")).toBe("checked");
      expect(box("skill-65").getAttribute("data-state")).toBe("unchecked");
      expect(box("skill-65").hasAttribute("disabled")).toBe(true);

      const all = within(dialog).getByRole("checkbox", {
        name: "Select all skills",
      });
      await userEvent.click(all);
      expect(within(dialog).getByText("0 of 70 selected")).toBeTruthy();
      expect(box("skill-65").hasAttribute("disabled")).toBe(false);
      await userEvent.click(all);
      expect(within(dialog).getByText("64 of 70 selected")).toBeTruthy();
      expect(box("skill-65").hasAttribute("disabled")).toBe(true);

      await userEvent.click(
        within(dialog).getByRole("button", { name: "Import 64 skills" }),
      );

      await waitFor(() => {
        expect(harness.paramsOf(IMPORT)).toEqual([
          { step: "inspect", environmentId: "env-a", source: "acme/skills" },
          {
            step: "install",
            environmentId: "env-a",
            token: "tok-1",
            names: names.slice(0, 64),
          },
        ]);
      });
    });

    it.each<readonly ["exists" | "bundled_name", string, string]>([
      [
        "exists",
        "triage",
        "Acme already has a skill named triage. Remove it first.",
      ],
      [
        "bundled_name",
        "triage",
        "triage is the name of a built-in skill. It can't be imported under that name.",
      ],
    ])("names the %s refusal in its own line", async (reason, name, line) => {
      const { dialog } = await readSource((request) =>
        request.step === "inspect"
          ? inspected
          : { outcome: "refused", reason, name },
      );
      await userEvent.click(
        await within(dialog).findByRole("button", { name: "Import 1 skill" }),
      );

      expect(await within(dialog).findByText(line)).toBeTruthy();
    });

    it("returns to the source step when the install is answered expired", async () => {
      const { dialog } = await readSource((request) =>
        request.step === "inspect"
          ? inspected
          : { outcome: "refused", reason: "expired", name: null },
      );
      await userEvent.click(
        await within(dialog).findByRole("button", { name: "Import 1 skill" }),
      );

      expect(
        await within(dialog).findByText(
          "This source changed since it was read. Read it again.",
        ),
      ).toBeTruthy();
      expect(
        within(dialog).getByRole("button", { name: "Read source" }),
      ).toBeTruthy();
    });

    it("offers no Import button when the viewing host does not support skills.import", async () => {
      negotiateHosted({ [STATE]: LIST });
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({ list: listed([REVIEW], "pol-1"), hostSkills: [] }),
        [STATE]: () => listedState([], []),
      });
      render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

      await screen.findByText("review");
      expect(
        screen.queryByRole("button", { name: "Import from source" }),
      ).toBeNull();
    });
  });
});
