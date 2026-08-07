import type {
  ModelProviderEntry,
  ModelProvidersListResult,
  ProviderModelProvidersCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sortModelProviderEntries } from "@/components/settings/panels/model-provider-connect-model";
import { ProviderModelProvidersTab } from "@/components/settings/panels/provider-model-providers-tab";
import { useModelProviderPendingAuthStore } from "@/stores/settings/model-provider-pending-auth-store";

const hostMocks = vi.hoisted(() => ({
  listResult: null as ModelProvidersListResult | null,
  listPending: false,
  listError: null as string | null,
  refetch: vi.fn(),
  authMutate: vi.fn(),
  authIsPending: false,
  awaitMutate: vi.fn(),
  cancelMutate: vi.fn(),
  openExternalLink: vi.fn(),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => ({
    hostClient: { getActiveHostId: () => "host-1" },
  }),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({ getActiveHostId: () => "host-1" }),
}));

vi.mock("@/hooks/providers/use-providers-model-providers-list-query", () => ({
  useProvidersModelProvidersList: () => ({
    data:
      hostMocks.listResult === null
        ? undefined
        : { result: hostMocks.listResult },
    isPending: hostMocks.listPending,
    isError: hostMocks.listError !== null,
    error:
      hostMocks.listError === null ? null : { message: hostMocks.listError },
    refetch: hostMocks.refetch,
  }),
}));

vi.mock("@/hooks/providers/use-providers-model-provider-auth-mutation", () => ({
  useProvidersModelProviderAuth: () => ({
    mutate: hostMocks.authMutate,
    isPending: hostMocks.authIsPending,
  }),
}));

vi.mock(
  "@/hooks/providers/use-providers-await-model-provider-auth-mutation",
  () => ({
    useProvidersAwaitModelProviderAuth: () => ({
      mutate: hostMocks.awaitMutate,
      isPending: false,
    }),
  }),
);

vi.mock(
  "@/hooks/providers/use-providers-cancel-model-provider-auth-mutation",
  () => ({
    useProvidersCancelModelProviderAuth: () => ({
      mutate: hostMocks.cancelMutate,
      isPending: false,
    }),
  }),
);

vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => ({ mutate: hostMocks.openExternalLink }),
}));

const FULL_CAPS: ProviderModelProvidersCapabilities = {
  actions: ["connect", "oauth", "disconnect"],
};

function entry(overrides: Partial<ModelProviderEntry>): ModelProviderEntry {
  return {
    id: "anthropic",
    name: "Anthropic",
    credentialKey: "ANTHROPIC_API_KEY",
    source: null,
    hasStoredCredential: false,
    canDisconnect: false,
    connected: false,
    methods: [],
    ...overrides,
  };
}

function renderTab(args: {
  readonly result: ModelProvidersListResult | null;
  readonly capabilities: ProviderModelProvidersCapabilities;
}) {
  hostMocks.listResult = args.result;
  return render(
    <ProviderModelProvidersTab
      providerId="opencode"
      providerLabel="OpenCode"
      capabilities={args.capabilities}
      packPreparing={null}
    />,
  );
}

beforeEach(() => {
  hostMocks.listResult = null;
  hostMocks.listPending = false;
  hostMocks.listError = null;
  hostMocks.authIsPending = false;
  hostMocks.refetch.mockReset();
  hostMocks.authMutate.mockReset();
  hostMocks.awaitMutate.mockReset();
  hostMocks.cancelMutate.mockReset();
  hostMocks.openExternalLink.mockReset();
  useModelProviderPendingAuthStore.setState({ entries: {} });
});

afterEach(() => {
  cleanup();
});

describe("sortModelProviderEntries", () => {
  it("puts connected providers first, then sorts by name", () => {
    // One list, not two sections: search has to be able to find a connected
    // provider, and a "connected" section above a searchable catalog is exactly
    // the shape where it cannot.
    const sorted = sortModelProviderEntries([
      entry({ id: "zzz", name: "Zed" }),
      entry({ id: "openai", name: "OpenAI", connected: true, source: "api" }),
      entry({ id: "aaa", name: "Alpha" }),
      entry({ id: "groq", name: "Groq", connected: true, source: "env" }),
    ]);
    expect(sorted.map((row) => row.name)).toEqual([
      "Groq",
      "OpenAI",
      "Alpha",
      "Zed",
    ]);
  });
});

describe("ProviderModelProvidersTab list states", () => {
  it("renders the catalog with the provider id beside the name", () => {
    renderTab({
      result: {
        ok: true,
        providers: [entry({}), entry({ id: "openai", name: "OpenAI" })],
      },
      capabilities: FULL_CAPS,
    });
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("openai")).toBeTruthy();
  });

  it("reports capability_unavailable WITHOUT a retry", () => {
    // The surface is not offered on this host at all. A retry button would be
    // guaranteed to do nothing, which is the offered-then-failed shape this
    // repo refuses everywhere else.
    renderTab({
      result: {
        ok: false,
        code: "capability_unavailable",
        detail: "Model providers are not available for this provider",
      },
      capabilities: FULL_CAPS,
    });
    expect(screen.getByText("Not available here")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers a retry for a server that would not start", () => {
    renderTab({
      result: {
        ok: false,
        code: "server_unavailable",
        detail: "spawn failed",
      },
      capabilities: FULL_CAPS,
    });
    expect(screen.getByText("spawn failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(hostMocks.refetch).toHaveBeenCalled();
  });

  it("renders a still-downloading pack as a WAIT, not a failure", () => {
    // Reaching the catalog needs a managed server, and every reason it would
    // not start arrives as one `server_unavailable`. The provider row is what
    // knows the difference.
    hostMocks.listResult = {
      ok: false,
      code: "server_unavailable",
      detail: "server did not start",
    };
    render(
      <ProviderModelProvidersTab
        providerId="opencode"
        providerLabel="OpenCode"
        capabilities={FULL_CAPS}
        packPreparing={{
          kind: "downloading",
          percent: 42,
          retryAtMs: null,
          reason: null,
          fallbackRunnable: false,
        }}
      />,
    );
    expect(screen.getByText("Preparing OpenCode… 42%")).toBeTruthy();
    expect(screen.queryByText("server did not start")).toBeNull();
  });

  it("filters the catalog by name or id", () => {
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({}),
          entry({ id: "openai", name: "OpenAI" }),
          entry({ id: "groq", name: "Groq" }),
        ],
      },
      capabilities: FULL_CAPS,
    });
    fireEvent.change(screen.getByLabelText("Search providers"), {
      target: { value: "groq" },
    });
    expect(screen.getByText("Groq")).toBeTruthy();
    expect(screen.queryByText("OpenAI")).toBeNull();
  });
});

describe("ProviderModelProvidersTab source and disconnect", () => {
  it("badges the origin ONLY for a connected provider", () => {
    // `source` is null unless connected, and a badge on a row nobody has
    // connected would claim a credential origin it does not have.
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "openai",
            name: "OpenAI",
            connected: true,
            source: "api",
            hasStoredCredential: true,
            canDisconnect: true,
          }),
          entry({}),
        ],
      },
      capabilities: FULL_CAPS,
    });
    expect(screen.getByText("Saved in Traycer")).toBeTruthy();
    expect(screen.queryByText("Environment")).toBeNull();
  });

  it("shows an env-sourced credential as read-only, with NO write affordance", () => {
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "groq",
            name: "Groq",
            connected: true,
            source: "env",
            hasStoredCredential: false,
            canDisconnect: false,
          }),
        ],
      },
      capabilities: FULL_CAPS,
    });
    expect(screen.getByText("Environment")).toBeTruthy();
    expect(screen.getByText("Managed outside Traycer")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove Groq credential" }),
    ).toBeNull();
    // Read-only means the WRITE affordance too. A "Replace" here would store a
    // key into the auth store that the env var keeps shadowing - the click
    // would appear to work and change nothing, and un-shadowing is explicitly
    // out of v1 scope.
    expect(screen.queryByRole("button", { name: /Replace/ })).toBeNull();
  });

  it("still offers Replace for a credential Traycer itself stored", () => {
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "openai",
            name: "OpenAI",
            connected: true,
            source: "api",
            hasStoredCredential: true,
            canDisconnect: true,
          }),
        ],
      },
      capabilities: FULL_CAPS,
    });
    expect(screen.getByRole("button", { name: /Replace/ })).toBeTruthy();
  });

  it("gates the disconnect affordance on canDisconnect ALONE", () => {
    // `hasStoredCredential` answers a different question, and a later host may
    // answer the two differently - reading either for the other is how a button
    // appears that the host will refuse.
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "openai",
            name: "OpenAI",
            connected: true,
            source: "api",
            hasStoredCredential: true,
            canDisconnect: false,
          }),
        ],
      },
      capabilities: FULL_CAPS,
    });
    expect(
      screen.queryByRole("button", { name: "Remove OpenAI credential" }),
    ).toBeNull();
  });

  it("hides disconnect when the HOST does not advertise the action", () => {
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "openai",
            name: "OpenAI",
            connected: true,
            source: "api",
            hasStoredCredential: true,
            canDisconnect: true,
          }),
        ],
      },
      capabilities: { actions: ["connect"] },
    });
    expect(
      screen.queryByRole("button", { name: "Remove OpenAI credential" }),
    ).toBeNull();
  });

  it("confirms before removing a stored credential", () => {
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "openai",
            name: "OpenAI",
            connected: true,
            source: "api",
            hasStoredCredential: true,
            canDisconnect: true,
          }),
        ],
      },
      capabilities: FULL_CAPS,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove OpenAI credential" }),
    );
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(hostMocks.authMutate).toHaveBeenCalledTimes(1);
    expect(hostMocks.authMutate.mock.calls[0]?.[0]).toEqual({
      providerId: "opencode",
      action: { action: "disconnect", modelProviderId: "openai" },
    });
  });

  it("hides every connect affordance when the host advertises no write action", () => {
    // A read-only catalog is a legal, honest state - the CLI version gate can
    // allow the list endpoints and not the write ones.
    renderTab({
      result: { ok: true, providers: [entry({})] },
      capabilities: { actions: [] },
    });
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
  });
});

describe("ProviderModelProvidersTab layout", () => {
  it("sizes the catalog fluidly, capped against the viewport", () => {
    // jsdom has no layout engine, so the mechanism is asserted structurally:
    // full width, a viewport-relative cap, and no fixed px/rem layout box.
    renderTab({
      result: { ok: true, providers: [entry({})] },
      capabilities: FULL_CAPS,
    });
    const list = screen.getByTestId("model-provider-list");
    expect(list.className).toContain("w-full");
    expect(list.className).toContain("max-h-[60vh]");
    // No fixed layout box in EITHER unit: a rem cap freezes with the text size
    // instead of following the window, which the px-only assertion missed.
    expect(list.className).not.toMatch(/-\[[^\]]*\d(?:px|rem)/);
  });
});
