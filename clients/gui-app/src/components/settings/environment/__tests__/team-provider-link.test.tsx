import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  mountTeamPage,
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
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useProviderLinkDialogStore.setState({ target: null });
});

const PASTED_CODE = "ONE-TIME-CODE-4821";

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
    const team = mountTeamPage(poolSource("admin"), {
      ...linkHandlers,
      "environment.list": () => TEAM_LIST,
    });
    render(<ProviderLinkDialog />, { wrapper: team.Wrapper });
    expect(
      await screen.findByRole("heading", { name: "Sign in to Acme" }),
    ).toBeTruthy();
    expect(screen.getByRole("dialog").textContent.match(/Acme/g)).toHaveLength(
      1,
    );
    await waitFor(() => {
      expect(
        screen.getByText(
          "This signs Traycer in to your plan once. The team's agents use it on every host running this environment; it counts as a device on your plan.",
        ),
      ).toBeTruthy();
    });
    cleanup();

    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: null,
        environmentId: "env-personal",
      },
    });
    const personal = mountTeamPage(personalPoolSource(), linkHandlers);
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
    const harness = mountTeamPage(poolSource("admin"), linkHandlers);
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

  it("links a team's plan through the link mutations, polls a handoff through a host query, and rereads the plans once linked", async () => {
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: "profile-1",
        environmentId: "env-a",
      },
    });
    let polls = 0;
    const harness = mountTeamPage(poolSource("admin"), {
      ...linkHandlers,
      "providers.link": () => ({
        linkId: "link-2",
        environmentProfileId: null,
        prompt: { kind: "local_handoff" as const },
      }),
      "providers.linkComplete": () => {
        polls += 1;
        return polls === 1
          ? {
              state: "pending",
              code: null,
              account: null,
              expectedAccount: null,
              environmentProfileId: null,
              profileId: null,
            }
          : linkHandlers["providers.linkComplete"]();
      },
    });
    const plansKey = [
      ...hostQueryKeys.method(
        mockLocalHostEntry.hostId,
        "environment.plans.list",
        { environmentId: "env-a" },
      ),
      "user-me",
    ];
    // The Plans card's read, kept as if the card were open behind the dialog.
    harness.queryClient.setQueryDefaults(plansKey, {
      gcTime: Number.POSITIVE_INFINITY,
    });
    harness.queryClient.setQueryData(plansKey, { plans: [] });
    render(<ProviderLinkDialog />, { wrapper: harness.Wrapper });
    await userEvent.click(await screen.findByTestId("provider-link-continue"));
    await screen.findByRole("button", { name: "Done" }, { timeout: 4_000 });

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
        state: "linked",
        code: null,
        account: "ada@example.com",
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
  });

  it("creates a team profile through @1.2 and invalidates plans after installation starts", async () => {
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: null,
        environmentId: "env-a",
      },
    });
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
      {
        "providers.link": { major: 1, minor: 2 },
        "providers.linkComplete": { major: 1, minor: 2 },
        "providers.linkCancel": { major: 1, minor: 0 },
      },
    );
    recordNegotiatedHostManifest(mockLocalHostEntry.hostId, {
      "providers.link": { major: 1, minor: 2 },
      "providers.linkComplete": { major: 1, minor: 2 },
      "providers.linkCancel": { major: 1, minor: 0 },
    });
    const plansKey = [
      ...hostQueryKeys.method(
        mockLocalHostEntry.hostId,
        "environment.plans.list",
        { environmentId: "env-a" },
      ),
      "user-me",
    ];
    harness.queryClient.setQueryDefaults(plansKey, {
      gcTime: Number.POSITIVE_INFINITY,
    });
    harness.queryClient.setQueryData(plansKey, { plans: [] });

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
    await waitFor(() => {
      expect(harness.queryClient.getQueryState(plansKey)?.isInvalidated).toBe(
        true,
      );
    });
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
    const harness = mountTeamPage(poolSource("admin"), {
      ...linkHandlers,
      "providers.linkComplete": () =>
        new Promise((resolve) => {
          answerComplete = () =>
            resolve(linkHandlers["providers.linkComplete"]());
        }),
    });
    render(<ProviderLinkDialog />, { wrapper: harness.Wrapper });
    await userEvent.click(await screen.findByTestId("provider-link-continue"));
    await userEvent.type(
      await screen.findByLabelText("Paste the code"),
      PASTED_CODE,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(
        harness.queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => [
            mutation.options.mutationKey,
            mutation.state.status,
          ]),
      ).toEqual([
        [["providers.link"], "success"],
        [["providers.linkComplete"], "pending"],
      ]);
    });
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
    const harness = mountTeamPageNegotiating(
      poolSource("admin"),
      linkHandlers,
      { "providers.link": { major: 1, minor: 0 } },
    );
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
      { "providers.linkComplete": { major: 1, minor: 0 } },
    );
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
    const harness = mountTeamPage({ kind: "host" }, linkHandlers);
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
    const harness = mountTeamPage(poolSource("admin"), linkHandlers);
    render(<ProviderLinkDialog />, { wrapper: harness.Wrapper });

    expect(screen.queryByTestId("provider-link-dialog")).toBeNull();
  });
});
