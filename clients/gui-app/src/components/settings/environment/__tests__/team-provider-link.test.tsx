import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { ProviderLinkDialog } from "@/components/settings/panels/provider-link-dialog";
import { hostQueryKeys } from "@/lib/query-keys";
import { useProviderLinkDialogStore } from "@/stores/providers/provider-link-dialog-store";
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
  useProviderLinkDialogStore.setState({ target: null });
});

const PASTED_CODE = "ONE-TIME-CODE-4821";

const linkHandlers = {
  "providers.link": () => ({
    linkId: "link-1",
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
  }),
} as const;

async function linkWithCode(harness: TeamPageHarness): Promise<void> {
  render(<ProviderLinkDialog />, { wrapper: harness.Wrapper });
  await userEvent.click(await screen.findByTestId("provider-link-continue"));
  await userEvent.type(
    await screen.findByLabelText("Paste the code"),
    PASTED_CODE,
  );
  await userEvent.click(screen.getByRole("button", { name: "Link" }));
  await screen.findByRole("button", { name: "Done" });
}

function floorOf(harness: TeamPageHarness, method: string): unknown {
  return harness.messenger.calls.find((call) => call.method === method)
    ?.requiredHostMethodVersion;
}

describe("ProviderLinkDialog", () => {
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
      { providerId: "claude-code", profileId: null, environmentId: "env-a" },
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

  it("sends a pasted code through the complete mutation, and its pending state disables Link", async () => {
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
    await userEvent.click(screen.getByRole("button", { name: "Link" }));

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
      screen.getByRole("button", { name: "Link" }).hasAttribute("disabled"),
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
    ).toBe("Linking a plan needs an updated host.");
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
    ).toBe("Linking a plan needs an updated host.");
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
      { providerId: "claude-code", profileId: null, environmentId: null },
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
