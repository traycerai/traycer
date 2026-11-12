import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { QueryKey } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { ProviderLinkDialog } from "@/components/settings/panels/provider-link-dialog";
import { LINK_INTRO } from "@/lib/providers/provider-link-copy";
import { hostQueryKeys } from "@/lib/query-keys";
import { useProviderLinkDialogStore } from "@/stores/providers/provider-link-dialog-store";
import {
  mountTeamPageNegotiating,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
// The dialog imports the hook from the runtime module itself.
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
// Opening a URL is the external egress.
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => () => Promise.resolve(),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useProviderLinkDialogStore.setState({ target: null });
});

const PASTED_CODE = "ONE-TIME-CODE-4821";
const TEAM_LEGACY_SIGN_IN_MANIFEST = {
  "providers.link": { major: 1, minor: 1 },
  "providers.linkComplete": { major: 1, minor: 1 },
} as const;

const linkHandlers = {
  "providers.link": () => ({
    linkId: "link-1",
    environmentProfileId: null,
    prompt: {
      kind: "sign_in_url" as const,
      url: "https://claude.ai/login",
      codePrompt: "Paste the code",
    },
  }),
  "providers.linkComplete": () => ({
    state: "linked",
    code: null,
    account: "ada@example.com",
    expectedAccount: null,
    environmentProfileId: null,
    profileId: null,
  }),
} as const;

async function linkWithCode(harness: TeamPageHarness): Promise<void> {
  render(<ProviderLinkDialog />, { wrapper: harness.Wrapper });
  await userEvent.click(await screen.findByTestId("provider-link-continue"));
  await userEvent.type(
    await screen.findByLabelText("Paste the code"),
    PASTED_CODE,
  );
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("button", { name: "Done" });
}

function floorOf(harness: TeamPageHarness, method: string): unknown {
  return harness.messenger.calls.find((call) => call.method === method)
    ?.requiredHostMethodVersion;
}

function isPublicQueryKey(value: unknown): value is QueryKey {
  return Array.isArray(value);
}

const TEAM_LIST = {
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

describe("ProviderLinkDialog", () => {
  it("introduces a team's link with the team's name, and Personal's with the plain intro", async () => {
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: null,
        environmentId: "env-a",
      },
    });
    const teamManifest = {
      ...TEAM_LEGACY_SIGN_IN_MANIFEST,
      "environment.list": { major: 1, minor: 1 },
    } as const;
    const team = mountTeamPageNegotiating(
      poolSource("admin"),
      {
        ...linkHandlers,
        "environment.list": () => TEAM_LIST,
      },
      teamManifest,
    );
    recordNegotiatedHostManifest(mockLocalHostEntry.hostId, teamManifest);
    render(<ProviderLinkDialog />, { wrapper: team.Wrapper });
    expect(
      await screen.findByRole("heading", { name: "Sign in to Acme" }),
    ).toBeTruthy();
    expect(screen.getByRole("dialog").textContent.match(/Acme/g)).toHaveLength(
      1,
    );
    await screen.findByText(
      "This signs Traycer in to your plan once. The team's agents use it on every host running this environment; it counts as a device on your plan.",
    );
    cleanup();

    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: null,
        environmentId: "env-personal",
      },
    });
    const personal = mountTeamPageNegotiating(
      personalPoolSource(),
      linkHandlers,
      TEAM_LEGACY_SIGN_IN_MANIFEST,
    );
    recordNegotiatedHostManifest(
      mockLocalHostEntry.hostId,
      TEAM_LEGACY_SIGN_IN_MANIFEST,
    );
    render(<ProviderLinkDialog />, { wrapper: personal.Wrapper });
    expect(await screen.findByText(LINK_INTRO)).toBeTruthy();
  });

  it("links a team's plan with its environment id behind the 1.1 floor, and keeps the code out of every cache", async () => {
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: null,
        environmentId: "env-a",
      },
    });
    const harness = mountTeamPageNegotiating(
      poolSource("admin"),
      linkHandlers,
      TEAM_LEGACY_SIGN_IN_MANIFEST,
    );
    recordNegotiatedHostManifest(
      mockLocalHostEntry.hostId,
      TEAM_LEGACY_SIGN_IN_MANIFEST,
    );
    await linkWithCode(harness);

    expect(harness.paramsOf("providers.link")).toEqual([
      {
        providerId: "claude-code",
        profileId: null,
        environmentId: "env-a",
        createProfile: null,
        replaceAccount: false,
      },
    ]);
    expect(harness.paramsOf("providers.linkComplete")).toEqual([
      { linkId: "link-1", code: PASTED_CODE, environmentId: "env-a" },
    ]);
    expect(floorOf(harness, "providers.link")).toEqual({
      method: "providers.link",
      version: { major: 1, minor: 1 },
    });
    expect(floorOf(harness, "providers.linkComplete")).toEqual({
      method: "providers.linkComplete",
      version: { major: 1, minor: 1 },
    });

    const queries = harness.queryClient
      .getQueryCache()
      .getAll()
      .map((query) => JSON.stringify([query.queryKey, query.state.data]));
    const mutations = harness.queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) =>
        JSON.stringify([mutation.state.variables, mutation.state.data]),
      );
    expect([...queries, ...mutations].join("\n")).not.toContain(PASTED_CODE);
  });

  it("links a team's plan through the link mutations, polls a handoff through a host query, and rereads configuration after installation starts", async () => {
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: "profile-1",
        environmentId: "env-a",
      },
    });
    const completeAnswers = [
      {
        state: "pending" as const,
        code: null,
        account: null,
        expectedAccount: null,
        environmentProfileId: null,
        profileId: null,
      },
      {
        state: "installing" as const,
        code: null,
        account: null,
        expectedAccount: null,
        environmentProfileId: null,
        profileId: null,
      },
    ];
    const harness = mountTeamPageNegotiating(
      poolSource("admin"),
      {
        ...linkHandlers,
        "providers.link": () => ({
          linkId: "link-2",
          environmentProfileId: null,
          prompt: { kind: "local_handoff" as const },
        }),
        "providers.linkComplete": () => {
          const answer = completeAnswers.shift();
          if (answer === undefined) {
            return linkHandlers["providers.linkComplete"]();
          }
          return answer;
        },
      },
      TEAM_LEGACY_SIGN_IN_MANIFEST,
    );
    recordNegotiatedHostManifest(
      mockLocalHostEntry.hostId,
      TEAM_LEGACY_SIGN_IN_MANIFEST,
    );
    const plansKey = [
      ...hostQueryKeys.method(
        mockLocalHostEntry.hostId,
        "environment.plans.list",
        { environmentId: "env-a" },
      ),
      "user-me",
    ];
    const itemsKey = [
      ...hostQueryKeys.method(
        mockLocalHostEntry.hostId,
        "environment.configuration.items",
        { environmentId: "env-a" },
      ),
      "user-me",
      "providers",
    ];
    // The Plans card's read, kept as if the card were open behind the dialog.
    harness.queryClient.setQueryDefaults(plansKey, {
      gcTime: Number.POSITIVE_INFINITY,
    });
    harness.queryClient.setQueryData(plansKey, { plans: [] });
    harness.queryClient.setQueryDefaults(itemsKey, {
      gcTime: Number.POSITIVE_INFINITY,
    });
    harness.queryClient.setQueryData(itemsKey, { items: [] });
    const pendingObserved = Promise.withResolvers<void>();
    const installingObserved = Promise.withResolvers<void>();
    const pollIntervalRegistered = Promise.withResolvers<void>();
    const unsubscribe = harness.queryClient
      .getQueryCache()
      .subscribe((event) => {
        const queryKey: unknown = event.query.queryKey;
        const data: unknown = event.query.state.data;
        if (
          event.type !== "updated" ||
          !isPublicQueryKey(queryKey) ||
          !hostQueryKeys.matchesMethodOnAnyHost(
            queryKey,
            "providers.linkComplete",
          )
        )
          return;
        if (typeof data !== "object" || data === null || !("state" in data)) {
          return;
        }
        if (data.state === "pending") pendingObserved.resolve();
        if (data.state === "installing") installingObserved.resolve();
      });
    render(<ProviderLinkDialog />, { wrapper: harness.Wrapper });
    const continueButton = await screen.findByTestId("provider-link-continue");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const intervalWindow: Pick<Window, "setInterval"> = window;
    const realSetInterval = intervalWindow.setInterval.bind(intervalWindow);
    const intervalSpy = vi
      .spyOn(intervalWindow, "setInterval")
      .mockImplementation((handler, timeout) => {
        const intervalId = realSetInterval(handler, timeout);
        if (timeout === 2_000) pollIntervalRegistered.resolve();
        return intervalId;
      });
    try {
      fireEvent.click(continueButton);
      await pendingObserved.promise;
      await pollIntervalRegistered.promise;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      await installingObserved.promise;
      expect(await screen.findByRole("button", { name: "Done" })).toBeTruthy();
    } finally {
      intervalSpy.mockRestore();
      unsubscribe();
    }

    expect(
      harness.queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.options.mutationKey),
    ).toEqual([["providers.link"]]);
    expect(
      harness.queryClient
        .getQueryCache()
        .findAll({
          predicate: (query) =>
            hostQueryKeys.matchesMethodOnAnyHost(
              query.queryKey,
              "providers.linkComplete",
            ),
        })
        .map((query) => query.state.data),
    ).toEqual([
      {
        state: "installing",
        code: null,
        account: null,
        expectedAccount: null,
        environmentProfileId: null,
        profileId: null,
      },
    ]);
    expect(harness.paramsOf("providers.linkComplete")).toEqual([
      { linkId: "link-2", code: null, environmentId: "env-a" },
      { linkId: "link-2", code: null, environmentId: "env-a" },
    ]);
    expect(floorOf(harness, "providers.linkComplete")).toEqual({
      method: "providers.linkComplete",
      version: { major: 1, minor: 1 },
    });
    expect(harness.queryClient.getQueryState(plansKey)?.isInvalidated).toBe(
      true,
    );
    expect(harness.queryClient.getQueryState(itemsKey)?.isInvalidated).toBe(
      true,
    );
  });

  it("creates a team profile through @1.2 and invalidates plans after installation starts", async () => {
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: null,
        environmentId: "env-a",
      },
    });
    const manifest = {
      "providers.link": { major: 1, minor: 2 },
      "providers.linkComplete": { major: 1, minor: 2 },
      "providers.linkCancel": { major: 1, minor: 0 },
      "environment.list": { major: 1, minor: 1 },
    } as const;
    const harness = mountTeamPageNegotiating(
      poolSource("admin"),
      {
        ...linkHandlers,
        "environment.list": () => TEAM_LIST,
        "providers.link": () => ({
          linkId: "link-team-profile",
          environmentProfileId: "environment-profile-team",
          prompt: {
            kind: "sign_in_url" as const,
            url: "https://claude.ai/login",
            codePrompt: "Paste the code",
          },
        }),
        "providers.linkComplete": () => ({
          state: "installing",
          code: null,
          account: null,
          expectedAccount: null,
          environmentProfileId: "environment-profile-team",
          profileId: null,
        }),
        "providers.linkCancel": () => ({}),
      },
      manifest,
    );
    recordNegotiatedHostManifest(mockLocalHostEntry.hostId, manifest);
    const plansKey = [
      ...hostQueryKeys.method(
        mockLocalHostEntry.hostId,
        "environment.plans.list",
        { environmentId: "env-a" },
      ),
      "user-me",
    ];
    const itemsKey = [
      ...hostQueryKeys.method(
        mockLocalHostEntry.hostId,
        "environment.configuration.items",
        { environmentId: "env-a" },
      ),
      "user-me",
      "providers",
    ];
    harness.queryClient.setQueryDefaults(plansKey, {
      gcTime: Number.POSITIVE_INFINITY,
    });
    harness.queryClient.setQueryData(plansKey, { plans: [] });
    harness.queryClient.setQueryDefaults(itemsKey, {
      gcTime: Number.POSITIVE_INFINITY,
    });
    harness.queryClient.setQueryData(itemsKey, { items: [] });

    render(<ProviderLinkDialog />, { wrapper: harness.Wrapper });
    await userEvent.clear(await screen.findByLabelText("Profile name"));
    await userEvent.type(screen.getByLabelText("Profile name"), "Acme Claude");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByLabelText("Paste the code");

    expect(harness.paramsOf("providers.link")).toEqual([
      {
        providerId: "claude-code",
        profileId: null,
        environmentId: "env-a",
        createProfile: { label: "Acme Claude", shareSkillsAndPlugins: false },
        replaceAccount: false,
      },
    ]);
    expect(floorOf(harness, "providers.link")).toEqual({
      method: "providers.link",
      version: { major: 1, minor: 2 },
    });

    await userEvent.type(screen.getByLabelText("Paste the code"), PASTED_CODE);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("status")).textContent).toBe("Signed in.");
    expect(harness.paramsOf("providers.linkComplete")).toEqual([
      {
        linkId: "link-team-profile",
        code: PASTED_CODE,
        environmentId: "env-a",
      },
    ]);
    expect(floorOf(harness, "providers.linkComplete")).toEqual({
      method: "providers.linkComplete",
      version: { major: 1, minor: 2 },
    });
    expect(harness.queryClient.getQueryState(plansKey)?.isInvalidated).toBe(
      true,
    );
    expect(harness.queryClient.getQueryState(itemsKey)?.isInvalidated).toBe(
      true,
    );
  });

  it("sends a pasted code through the complete mutation, and its pending state disables Sign in", async () => {
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: null,
        environmentId: "env-a",
      },
    });
    let answerComplete: (() => void) | null = null;
    const harness = mountTeamPageNegotiating(
      poolSource("admin"),
      {
        ...linkHandlers,
        "providers.linkComplete": () =>
          new Promise((resolve) => {
            answerComplete = () =>
              resolve(linkHandlers["providers.linkComplete"]());
          }),
      },
      TEAM_LEGACY_SIGN_IN_MANIFEST,
    );
    recordNegotiatedHostManifest(
      mockLocalHostEntry.hostId,
      TEAM_LEGACY_SIGN_IN_MANIFEST,
    );
    render(<ProviderLinkDialog />, { wrapper: harness.Wrapper });
    await userEvent.click(await screen.findByTestId("provider-link-continue"));
    await userEvent.type(
      await screen.findByLabelText("Paste the code"),
      PASTED_CODE,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled"),
    ).toBe(true);
    act(() => answerComplete?.());
    await screen.findByRole("button", { name: "Done" });
  });

  it("shows an older host's floor refusal as the needs-update line, before anything is sent", async () => {
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: null,
        environmentId: "env-a",
      },
    });
    const manifest = { "providers.link": { major: 1, minor: 0 } } as const;
    const harness = mountTeamPageNegotiating(
      poolSource("admin"),
      linkHandlers,
      manifest,
    );
    recordNegotiatedHostManifest(mockLocalHostEntry.hostId, manifest);
    render(<ProviderLinkDialog />, { wrapper: harness.Wrapper });
    await userEvent.click(await screen.findByTestId("provider-link-continue"));

    expect(
      (await screen.findByTestId("provider-link-failed")).textContent,
    ).toBe("Signing in needs an updated host.");
    expect(harness.paramsOf("providers.link")).toEqual([]);
  });

  it("shows a poll's floor refusal as the needs-update line", async () => {
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: "profile-1",
        environmentId: "env-a",
      },
    });
    const manifest = {
      "providers.linkComplete": { major: 1, minor: 0 },
    } as const;
    const harness = mountTeamPageNegotiating(
      poolSource("admin"),
      {
        ...linkHandlers,
        "providers.link": () => ({
          linkId: "link-3",
          environmentProfileId: null,
          prompt: { kind: "local_handoff" as const },
        }),
      },
      manifest,
    );
    recordNegotiatedHostManifest(mockLocalHostEntry.hostId, manifest);
    render(<ProviderLinkDialog />, { wrapper: harness.Wrapper });
    await userEvent.click(await screen.findByTestId("provider-link-continue"));

    expect(
      (
        await screen.findByTestId(
          "provider-link-failed",
          {},
          { timeout: 4_000 },
        )
      ).textContent,
    ).toBe("Signing in needs an updated host.");
    expect(harness.paramsOf("providers.linkComplete")).toEqual([]);
  });

  it("keeps the host source on the host's own environment with no floor", async () => {
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: null,
        environmentId: null,
      },
    });
    const harness = mountTeamPageNegotiating(
      { kind: "host" },
      linkHandlers,
      TEAM_LEGACY_SIGN_IN_MANIFEST,
    );
    recordNegotiatedHostManifest(
      mockLocalHostEntry.hostId,
      TEAM_LEGACY_SIGN_IN_MANIFEST,
    );
    await linkWithCode(harness);

    expect(harness.paramsOf("providers.link")).toEqual([
      {
        providerId: "claude-code",
        profileId: null,
        environmentId: null,
        createProfile: null,
        replaceAccount: false,
      },
    ]);
    expect(harness.paramsOf("providers.linkComplete")).toEqual([
      { linkId: "link-1", code: PASTED_CODE, environmentId: null },
    ]);
    expect(floorOf(harness, "providers.link")).toBeNull();
    expect(floorOf(harness, "providers.linkComplete")).toBeNull();
  });

  it("renders no dialog for a target that belongs to another source", () => {
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: null,
        environmentId: "env-other",
      },
    });
    const harness = mountTeamPageNegotiating(
      poolSource("admin"),
      linkHandlers,
      TEAM_LEGACY_SIGN_IN_MANIFEST,
    );
    recordNegotiatedHostManifest(
      mockLocalHostEntry.hostId,
      TEAM_LEGACY_SIGN_IN_MANIFEST,
    );
    render(<ProviderLinkDialog />, { wrapper: harness.Wrapper });

    expect(screen.queryByTestId("provider-link-dialog")).toBeNull();
  });
});
