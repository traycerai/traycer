import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderLinkDialog } from "@/components/settings/panels/provider-link-dialog";
import { useProviderLinkDialogStore } from "@/stores/providers/provider-link-dialog-store";
import {
  mountTeamPage,
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
