import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderSkill,
  ProvidersSkillsMutateAction,
} from "@traycer/protocol/host/provider-native-schemas";
import type {
  ProviderCliState,
  ProvidersNativeMutateResponseV14,
} from "@traycer/protocol/host/provider-schemas";
import { ProviderSkillsTab } from "@/components/settings/panels/provider-skills-tab";
import { GLOBAL_ONLY_NATIVE_SCOPE } from "@/components/settings/panels/__tests__/provider-native-scope-test-mocks";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useProvidersSkillsList } from "@/hooks/providers/use-providers-skills-list-query";
import { useProvidersSkillsMutate } from "@/hooks/providers/use-providers-skills-mutate-mutation";
import {
  mountTeamPage,
  mountTeamPageNegotiating,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
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
// The scope picker needs the app's workspace stores; skills are global here.
vi.mock("@/components/settings/panels/use-provider-native-scope", () => ({
  useProviderNativeScope: () => GLOBAL_ONLY_NATIVE_SCOPE,
}));
// The detail dialog reads SKILL.md off disk.
vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => ({
    data: {
      content: "---\nname: find-skills\n---\n\n# Use\n",
      truncated: false,
      error: null,
    },
    isPending: false,
    isError: false,
    error: null,
  }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

const SKILL: ProviderSkill = {
  name: "find-skills",
  description: "Discover skills.",
  path: "/Users/dev/.agents/skills/find-skills",
  source: "shared",
};

const REMOVE: ProvidersSkillsMutateAction = {
  action: "remove",
  name: SKILL.name,
  path: SKILL.path,
};

const EDIT: ProvidersSkillsMutateAction = {
  action: "edit",
  path: SKILL.path,
  expectedHash: "a".repeat(64),
  name: SKILL.name,
  description: "Discover skills.",
  body: "# Body\n",
};

const MISMATCH_COPY = "This host no longer runs this team. Pick another host.";

function nativeHandlers(
  mutate: (params: unknown) => ProvidersNativeMutateResponseV14,
  counts: { list: number; hostList: number },
) {
  return {
    "providers.list": () => {
      counts.list += 1;
      return {
        providers: [],
        native: { ok: true as const, kind: "skills" as const, skills: [SKILL] },
      };
    },
    "providers.nativeMutate": (params: unknown) => mutate(params),
    "environment.host.list": () => {
      counts.hostList += 1;
      return { hosts: [] };
    },
  };
}

function mismatch(detail: string): ProvidersNativeMutateResponseV14 {
  return {
    result: {
      ok: false,
      code: "environment_mismatch",
      detail,
    },
  };
}

function removed(): ProvidersNativeMutateResponseV14 {
  return { result: { ok: true, kind: "skills", skills: [] } };
}

function floorOfMutate(harness: TeamPageHarness): unknown {
  return harness.messenger.calls.find(
    (call) => call.method === "providers.nativeMutate",
  )?.requiredHostMethodVersion;
}

describe("useProvidersSkillsMutate on a team", () => {
  it.each([
    ["remove", REMOVE],
    ["edit", EDIT],
  ] as const)(
    "sends %s with the team's expected environment behind the nativeMutate 1.4 floor",
    async (_name, mutation) => {
      const counts = { list: 0, hostList: 0 };
      const harness = mountTeamPage(
        poolSource("editor"),
        nativeHandlers(removed, counts),
      );
      const { result } = renderHook(() => useProvidersSkillsMutate(), {
        wrapper: harness.Wrapper,
      });

      await act(async () => {
        await result.current.mutateAsync({
          environmentId: "env-a",
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          mutation,
          suppressToast: true,
        });
      });

      expect(harness.paramsOf("providers.nativeMutate")[0]).toMatchObject({
        providerId: "codex",
        expectedEnvironmentId: "env-a",
        mutation: { kind: "skills", mutation },
      });
      expect(floorOfMutate(harness)).toEqual({
        method: "providers.nativeMutate",
        version: { major: 1, minor: 4 },
      });
    },
  );

  it("sends the host path with a null expected environment and no floor", async () => {
    const counts = { list: 0, hostList: 0 };
    const harness = mountTeamPage(
      { kind: "host" },
      nativeHandlers(removed, counts),
    );
    const { result } = renderHook(() => useProvidersSkillsMutate(), {
      wrapper: harness.Wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        mutation: REMOVE,
        suppressToast: true,
      });
    });

    expect(harness.paramsOf("providers.nativeMutate")[0]).toMatchObject({
      expectedEnvironmentId: null,
    });
    expect(floorOfMutate(harness)).toBeNull();
  });

  it("answers environment_mismatch with the pick-another-host copy over the server's detail, rereads the host list, and does not reread the host's native skills", async () => {
    const counts = { list: 0, hostList: 0 };
    const harness = mountTeamPage(
      poolSource("editor"),
      nativeHandlers(
        () => mismatch("server says: different environment"),
        counts,
      ),
    );
    const { result } = renderHook(
      () => ({
        mutate: useProvidersSkillsMutate(),
        skills: useProvidersSkillsList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          enabled: true,
        }),
        hosts: useHostQuery({
          client: requireTeamHostClient(),
          cacheKeyIdentity: undefined,
          method: "environment.host.list",
          params: { environmentId: "env-a" },
          options: { enabled: true, staleTime: 0 },
        }),
      }),
      { wrapper: harness.Wrapper },
    );
    await waitFor(() => {
      expect(result.current.skills.data?.skills).toEqual([SKILL]);
      expect(result.current.hosts.data).toBeDefined();
    });
    const listsBefore = counts.list;
    const hostListsBefore = counts.hostList;

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.mutate.mutateAsync({
          environmentId: "env-a",
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          mutation: REMOVE,
          suppressToast: true,
        });
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(MISMATCH_COPY);
    await waitFor(() => {
      expect(counts.hostList).toBeGreaterThan(hostListsBefore);
    });
    expect(counts.list).toBe(listsBefore);
  });
});

function skillsState(): ProviderCliState {
  return {
    providerId: "codex",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      supportedTabs: ["skills"],
      mcp: null,
      plugins: null,
      skills: {
        actionScopes: {
          list: ["global"],
          add: [],
          create: [],
          import: [],
          remove: ["global"],
          edit: ["global"],
        },
      },
      modelProviders: null,
    },
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

async function openSkill(): Promise<void> {
  await userEvent.click(
    await screen.findByRole("button", { name: "Open find-skills (Shared)" }),
  );
}

async function confirmRemove(): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
  const dialog = await screen.findByTestId("confirm-destructive-dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
}

describe("ProviderSkillsTab on a team", () => {
  it("captures the picked team's environment id when it removes a skill", async () => {
    const counts = { list: 0, hostList: 0 };
    const harness = mountTeamPage(
      poolSource("editor"),
      nativeHandlers(removed, counts),
    );
    render(<ProviderSkillsTab state={skillsState()} />, {
      wrapper: harness.Wrapper,
    });

    await openSkill();
    await confirmRemove();

    await waitFor(() => {
      expect(harness.paramsOf("providers.nativeMutate")).toHaveLength(1);
    });
    expect(harness.paramsOf("providers.nativeMutate")[0]).toMatchObject({
      expectedEnvironmentId: "env-a",
      mutation: { kind: "skills", mutation: REMOVE },
    });
    expect(floorOfMutate(harness)).toEqual({
      method: "providers.nativeMutate",
      version: { major: 1, minor: 4 },
    });
  });

  it("keeps the host source on a null expected environment with no floor", async () => {
    const counts = { list: 0, hostList: 0 };
    const harness = mountTeamPage(
      { kind: "host" },
      nativeHandlers(removed, counts),
    );
    render(<ProviderSkillsTab state={skillsState()} />, {
      wrapper: harness.Wrapper,
    });

    await openSkill();
    await confirmRemove();

    await waitFor(() => {
      expect(harness.paramsOf("providers.nativeMutate")).toHaveLength(1);
    });
    expect(harness.paramsOf("providers.nativeMutate")[0]).toMatchObject({
      expectedEnvironmentId: null,
    });
    expect(floorOfMutate(harness)).toBeNull();
  });

  it("gives a viewer the skill with no edit or remove verbs", async () => {
    const counts = { list: 0, hostList: 0 };
    const harness = mountTeamPage(
      poolSource("viewer"),
      nativeHandlers(removed, counts),
    );
    render(<ProviderSkillsTab state={skillsState()} />, {
      wrapper: harness.Wrapper,
    });

    await openSkill();
    await screen.findByTestId("skill-detail-instructions").catch(() => null);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(harness.paramsOf("providers.nativeMutate")).toHaveLength(0);
  });

  it("shows the pick-another-host copy in the tab, not the server's detail, on environment_mismatch", async () => {
    const counts = { list: 0, hostList: 0 };
    const harness = mountTeamPage(
      poolSource("editor"),
      nativeHandlers(
        () => mismatch("server says: different environment"),
        counts,
      ),
    );
    render(<ProviderSkillsTab state={skillsState()} />, {
      wrapper: harness.Wrapper,
    });

    await openSkill();
    await confirmRemove();

    expect(await screen.findByText(MISMATCH_COPY)).toBeTruthy();
    expect(screen.queryByText(/server says/)).toBeNull();
  });

  it("shows the update remedy, and sends nothing, when the host negotiated below the nativeMutate floor", async () => {
    const counts = { list: 0, hostList: 0 };
    const harness = mountTeamPageNegotiating(
      poolSource("editor"),
      nativeHandlers(removed, counts),
      { "providers.nativeMutate": { major: 1, minor: 3 } },
    );
    render(<ProviderSkillsTab state={skillsState()} />, {
      wrapper: harness.Wrapper,
    });

    await openSkill();
    await confirmRemove();

    expect(
      await screen.findByText("Changing skills needs an updated host."),
    ).toBeTruthy();
    expect(harness.paramsOf("providers.nativeMutate")).toHaveLength(0);
  });
});
