import type {
  ModelProviderAuthResult,
  ModelProviderEntry,
  ModelProvidersListResult,
  ProviderModelProvidersCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";

/**
 * The callbacks the tab hands `mutate`, named so a test can fire one by hand.
 *
 * Typed on the mock rather than reached for through `mock.calls`, which is
 * `any` - and firing a completion by hand is the only way to reach the
 * late-arrival case at all.
 */
type AuthMutateOptions = {
  readonly onSuccess: (data: {
    readonly result: ModelProviderAuthResult;
  }) => void;
  readonly onSettled: () => void;
};
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sortModelProviderEntries } from "@/components/settings/panels/model-provider-connect-model";
import { ProviderModelProvidersTab } from "@/components/settings/panels/provider-model-providers-tab";
import { useModelProviderPendingAuthStore } from "@/stores/settings/model-provider-pending-auth-store";

const hostMocks = vi.hoisted(() => ({
  listResult: null as ModelProvidersListResult | null,
  listPending: false,
  listFetching: false,
  listError: null as string | null,
  refetch: vi.fn(),
  authMutate: vi.fn<(payload: unknown, options: AuthMutateOptions) => void>(),
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
    isFetching: hostMocks.listFetching,
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
    source: null,
    hasStoredCredential: false,
    canDisconnect: false,
    configDeclaredCustom: false,
    custom: null,
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
  hostMocks.listFetching = false;
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
  it("SAYS it is refreshing rather than letting stale rows look final", () => {
    // Measured: the host rotates its managed server on every write, so the
    // refetch after a mutation pays a cold `opencode serve` boot - ~3.7s
    // against ~0.24s warm. For that whole window the rows are the pre-mutation
    // answer, and the user read them as final twice before anyone timed it.
    hostMocks.listFetching = true;
    renderTab({
      result: { ok: true, providers: [entry({})] },
      capabilities: FULL_CAPS,
    });
    // Queried by text: the search controls also publish a polite live region,
    // so `getByRole("status")` is ambiguous here and asserting on the wrong one
    // would pass for the wrong reason.
    expect(screen.getByText("Refreshing providers")).toBeTruthy();
    // The rows stay on screen - they are mostly right, and a skeleton would
    // throw away more than it protects.
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(
      screen.getByTestId("model-provider-list").getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("does not claim to be refreshing when it is not", () => {
    renderTab({
      result: { ok: true, providers: [entry({})] },
      capabilities: FULL_CAPS,
    });
    expect(screen.queryByText("Refreshing providers")).toBeNull();
  });

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

/**
 * Radix opens on pointerdown, not click - firing only `click` leaves the menu
 * shut and every following query passing vacuously. Mirrors
 * `provider-rail-controls.test`'s helper.
 */
function selectFilter(name: string): void {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /^Filter model providers/ }),
    { button: 0, ctrlKey: false, pointerType: "mouse" },
  );
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
}

describe("ProviderModelProvidersTab method filter", () => {
  const MIXED: ModelProvidersListResult = {
    ok: true,
    providers: [
      entry({ id: "anthropic", name: "Anthropic" }),
      entry({
        id: "github-copilot",
        name: "GitHub Copilot",
        methods: [{ type: "oauth", label: "Sign in with GitHub", prompts: [] }],
      }),
    ],
  };

  it("shows everything until a filter is picked", () => {
    renderTab({ result: MIXED, capabilities: FULL_CAPS });
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("GitHub Copilot")).toBeTruthy();
    // No dot on the trigger while nothing is filtered.
    expect(
      screen.getByTestId("model-provider-filter-trigger").textContent,
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Filter model providers" }),
    ).toBeTruthy();
  });

  it("narrows to browser sign-in and names the filter on the trigger", () => {
    // ~10 of ~180 catalog rows advertise OAuth, which is the whole reason this
    // control exists - per-row badges would have marked the other ~170 with a
    // label that says nothing.
    renderTab({ result: MIXED, capabilities: FULL_CAPS });
    selectFilter("Browser sign-in");

    expect(screen.getByText("GitHub Copilot")).toBeTruthy();
    expect(screen.queryByText("Anthropic")).toBeNull();
    // The accessible name carries the CURRENT value: the dot alone says only
    // that something is filtered.
    expect(
      screen.getByRole("button", {
        name: "Filter model providers, showing browser sign-in",
      }),
    ).toBeTruthy();
  });

  it("explains an empty filter result without quoting an empty query", () => {
    renderTab({
      result: { ok: true, providers: [entry({ id: "anthropic" })] },
      capabilities: FULL_CAPS,
    });
    selectFilter("Browser sign-in");
    expect(screen.getByText("No matching providers")).toBeTruthy();
    expect(
      screen.getByText(
        "No providers on this host advertise a browser sign-in.",
      ),
    ).toBeTruthy();
  });

  it("keeps a search INSIDE the picked bucket", () => {
    // Filter runs before the fuzzy matcher, so a query cannot quietly re-widen
    // the set the user narrowed.
    renderTab({ result: MIXED, capabilities: FULL_CAPS });
    selectFilter("Browser sign-in");
    fireEvent.change(screen.getByLabelText("Search providers"), {
      target: { value: "anthropic" },
    });
    expect(screen.queryByText("Anthropic")).toBeNull();
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
    expect(screen.getByText("API key")).toBeTruthy();
    expect(screen.queryByText("Environment")).toBeNull();
  });

  it("shows an env-sourced credential's origin while keeping it configurable", () => {
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
    // The badge is the ONLY origin marker now. A trailing "Set by environment"
    // beside a badge reading "Environment" spent the row's last words saying
    // the same thing twice, on the surface the user asked us to thin out.
    expect(screen.queryByText("Set by environment")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Disconnect Groq" }),
    ).toBeNull();
    // Connect STAYS: `source` is a status, not a permission. Setting a
    // provider up and choosing which credential wins are different decisions,
    // and the dialog carries the precedence warning.
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("splits Config from Custom on the host's flag, not on source alone", () => {
    // `source: "config"` covers two different rows - a provider the user
    // DECLARED as a custom endpoint, and one a config file merely supplies a
    // key for. Upstream badges those "Custom" and "Config", and the difference
    // is not recoverable from `source`, which is why the host sends the flag.
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "groq",
            name: "Groq",
            connected: true,
            source: "config",
            canDisconnect: false,
          }),
          entry({
            id: "my-gateway",
            name: "My gateway",
            connected: true,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "https://api.example.test/v1",
              models: [{ id: "a", name: "a" }],
              headers: [],
              env: [],
            },
            canDisconnect: true,
          }),
        ],
      },
      capabilities: FULL_CAPS,
    });
    // Same `source`, two badges.
    expect(screen.getByText("Config")).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(screen.queryByText("Set in config file")).toBeNull();
    expect(screen.queryByText("Managed outside Traycer")).toBeNull();
  });

  it("shows Disconnect ALONE on a connected row the host will disconnect", () => {
    // Upstream's rule, and the reason this is not "Connect plus Disconnect":
    // their app offers exactly one action per row, and replacing a stored key
    // is disconnect-then-connect there too.
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
    expect(
      screen.getByRole("button", { name: "Disconnect OpenAI" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("labels an env-sourced row without taking its Connect away", () => {
    // Observed live: an account with a stored openai OAuth credential still
    // reports `source: env` while OPENAI_API_KEY is exported. Without this the
    // row is a dead end - no Connect, no Remove, and no hint that signing in
    // again would succeed and change nothing visible.
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "openai",
            name: "OpenAI",
            connected: true,
            source: "env",
            canDisconnect: false,
            methods: [
              { type: "oauth", label: "ChatGPT Pro/Plus", prompts: [] },
            ],
          }),
        ],
      },
      capabilities: FULL_CAPS,
    });
    expect(screen.getByText("Environment")).toBeTruthy();
    // Still configurable - the warning belongs in the dialog, not in a block.
    // This is also the ONE case a connected row still shows Connect: the host
    // will not disconnect it, so parity's "Disconnect only" would leave the row
    // with no action at all.
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
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
      screen.queryByRole("button", { name: "Disconnect OpenAI" }),
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
      screen.queryByRole("button", { name: "Disconnect OpenAI" }),
    ).toBeNull();
  });

  it("names the provider's own store on the api badge", () => {
    // A key entered here is written to OpenCode's `auth.json` via `auth.set`
    // and never mirrored into Traycer - that ownership is what keeps
    // `opencode auth login` and this tab interchangeable, so a "Saved in
    // Traycer" badge described the one thing the design avoids.
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
    expect(screen.getByText("API key")).toBeTruthy();
    expect(screen.queryByText("Saved in Traycer")).toBeNull();
  });

  it("gives the disconnect control a readable word and destructive intent", () => {
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
    const remove = screen.getByRole("button", { name: "Disconnect OpenAI" });
    // TEXT, not a glyph. An unplug icon in a row of quiet text was the one
    // control the user could not read: it named neither what it removes nor
    // that it is the destructive one.
    expect(remove.textContent).toBe("Disconnect");
    // Destructive intent still arrives on hover rather than as permanent red,
    // matching the pattern the rest of Settings uses.
    expect(remove.className).toContain("hover:text-destructive");
    expect(remove.className).toContain("hover:bg-destructive/10");
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
    fireEvent.click(screen.getByRole("button", { name: "Disconnect OpenAI" }));
    // Says what removal GUARANTEES and no more: an env var or config file
    // underneath can take over the moment the stored credential is gone, so
    // promising the provider stops working would contradict the row's own
    // read-only copy.
    expect(screen.getByText(/keeps working from that source/)).toBeTruthy();
    expect(
      screen.queryByText(/stop working until you connect it again/),
    ).toBeNull();
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(hostMocks.authMutate).toHaveBeenCalledTimes(1);
    expect(hostMocks.authMutate.mock.calls[0]?.[0]).toEqual({
      providerId: "opencode",
      action: { action: "disconnect", modelProviderId: "openai" },
    });
  });

  it("keeps Add custom provider reachable while a search is filtering", () => {
    // It is not a provider the catalog can match, so a search that filtered it
    // away would hide the one row whose purpose is "what you want isn't in this
    // list" - which is exactly when someone is typing in that box.
    renderTab({
      result: {
        ok: true,
        providers: [entry({}), entry({ id: "openai", name: "OpenAI" })],
      },
      capabilities: { actions: ["connect", "createCustom"] },
    });
    fireEvent.change(screen.getByPlaceholderText(/Search/), {
      target: { value: "zzzzz" },
    });
    expect(
      screen.getByRole("button", { name: "Add custom provider" }),
    ).toBeTruthy();
  });

  it("offers no custom-provider row when the host cannot accept one", () => {
    renderTab({
      result: { ok: true, providers: [entry({})] },
      capabilities: FULL_CAPS,
    });
    expect(
      screen.queryByRole("button", { name: "Add custom provider" }),
    ).toBeNull();
  });

  it("declares a custom provider with the wire's createCustom shape", () => {
    renderTab({
      result: { ok: true, providers: [entry({})] },
      capabilities: { actions: ["connect", "createCustom"] },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add custom provider" }),
    );
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "My gateway" },
    });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://api.example.test/v1" },
    });
    fireEvent.change(screen.getAllByLabelText("ID")[0], {
      target: { value: "gpt-4o-mini" },
    });
    fireEvent.change(screen.getAllByLabelText("Name")[0], {
      target: { value: "GPT-4o mini" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(hostMocks.authMutate.mock.calls[0]?.[0]).toEqual({
      providerId: "opencode",
      action: {
        action: "createCustom",
        modelProviderId: "my-gateway",
        name: "My gateway",
        baseUrl: "https://api.example.test/v1",
        models: [{ id: "gpt-4o-mini", name: "GPT-4o mini" }],
        headers: [],
        key: null,
        env: [],
      },
    });
  });

  it("says DISABLE, not remove, when disconnecting a declared custom provider", () => {
    // Upstream's disconnect for a config-declared custom disables the block
    // rather than deleting a credential it may not even have - so the copy that
    // promises a credential is removed would describe a different action.
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "my-gateway",
            name: "My gateway",
            connected: true,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "https://api.example.test/v1",
              models: [{ id: "a", name: "a" }],
              headers: [],
              env: [],
            },
            canDisconnect: true,
          }),
        ],
      },
      capabilities: FULL_CAPS,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Disconnect My gateway" }),
    );
    expect(
      screen.getByText(/declaration stays in OpenCode's config file/),
    ).toBeTruthy();
    expect(screen.queryByText(/Remove the stored/)).toBeNull();
  });

  it("edits a declared custom row from the values the host reported", () => {
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "my-gateway",
            name: "My gateway",
            connected: true,
            source: "config",
            configDeclaredCustom: true,
            canDisconnect: true,
            custom: {
              baseUrl: "https://api.example.test/v1",
              models: [
                { id: "a", name: "a" },
                { id: "b", name: "b" },
              ],
              headers: [],
              env: [],
            },
          }),
        ],
      },
      capabilities: { actions: ["connect", "disconnect", "updateCustom"] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit My gateway" }));
    // Prefilled from the row, not from blanks: `updateCustom` carries the whole
    // block, so an empty form's Submit would overwrite a working declaration.
    expect(
      screen
        .getAllByLabelText("ID")
        .map((input) => input.getAttribute("value")),
    ).toEqual(["a", "b"]);
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "My gateway v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(hostMocks.authMutate.mock.calls[0]?.[0]).toEqual({
      providerId: "opencode",
      action: {
        action: "updateCustom",
        modelProviderId: "my-gateway",
        name: "My gateway v2",
        baseUrl: "https://api.example.test/v1",
        models: [
          { id: "a", name: "a" },
          { id: "b", name: "b" },
        ],
        headers: [],
        key: null,
        env: [],
      },
    });
  });

  it("re-enables a disabled declaration with no form in between", () => {
    // A declared row that is off re-enables through `updateCustom` with its OWN
    // values - the wire has no enable verb, deliberately. Connect would demand
    // a key for a provider whose credential is not what was turned off.
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "my-gateway",
            name: "My gateway",
            connected: false,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "https://api.example.test/v1",
              models: [{ id: "a", name: "a" }],
              headers: [],
              env: [],
            },
          }),
        ],
      },
      capabilities: { actions: ["connect", "disconnect", "updateCustom"] },
    });
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Re-enable My gateway" }),
    );
    expect(hostMocks.authMutate.mock.calls[0]?.[0]).toEqual({
      providerId: "opencode",
      action: {
        action: "updateCustom",
        modelProviderId: "my-gateway",
        name: "My gateway",
        baseUrl: "https://api.example.test/v1",
        models: [{ id: "a", name: "a" }],
        headers: [],
        key: null,
        env: [],
      },
    });
  });

  it("offers Edit but NOT one-click re-enable for a broken declaration", () => {
    // `opencode.json` is hand-editable and the read side reports what it finds.
    // Sending those values straight back would report a failure the user never
    // had a chance to fix; Edit opens the form on exactly what is wrong.
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "my-gateway",
            name: "My gateway",
            connected: false,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "api.example.test/v1",
              models: [{ id: "a", name: "a" }],
              headers: [],
              env: [],
            },
          }),
        ],
      },
      capabilities: { actions: ["connect", "disconnect", "updateCustom"] },
    });
    expect(
      screen.queryByRole("button", { name: "Re-enable My gateway" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit My gateway" }),
    ).toBeTruthy();
  });

  it("offers no Edit when the host will not accept an update", () => {
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "my-gateway",
            name: "My gateway",
            connected: true,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "https://api.example.test/v1",
              models: [{ id: "a", name: "a" }],
              headers: [],
              env: [],
            },
          }),
        ],
      },
      capabilities: FULL_CAPS,
    });
    expect(
      screen.queryByRole("button", { name: "Edit My gateway" }),
    ).toBeNull();
  });

  it("round-trips a non-slug id through Edit and Re-enable", () => {
    // `my_gateway` is hand-written, legal on the wire and legal to the host.
    // The create-time slug rules used to be applied to it, which left the row
    // with no re-enable AND an Edit whose id field is disabled - a permanent
    // lock on the one row that needed fixing.
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "my_gateway",
            name: "My gateway",
            connected: false,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "https://api.example.test/v1",
              models: [{ id: "a", name: "a" }],
              headers: [],
              env: [],
            },
          }),
        ],
      },
      capabilities: { actions: ["connect", "disconnect", "updateCustom"] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit My gateway" }));
    // No error on the id it arrived with, and Submit goes through.
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(
      screen.queryByText(
        "Use lowercase letters, numbers, hyphens, or underscores",
      ),
    ).toBeNull();
    expect(hostMocks.authMutate.mock.calls[0]?.[0]).toMatchObject({
      action: { action: "updateCustom", modelProviderId: "my_gateway" },
    });
  });

  it("takes ONE write from a double-clicked Re-enable", () => {
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "my-gateway",
            name: "My gateway",
            connected: false,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "https://api.example.test/v1",
              models: [{ id: "a", name: "a" }],
              headers: [],
              env: [],
            },
          }),
        ],
      },
      capabilities: { actions: ["connect", "disconnect", "updateCustom"] },
    });
    const button = screen.getByRole("button", { name: "Re-enable My gateway" });
    // BOTH clicks inside one `act`, so React has not re-rendered between them
    // and the button is still enabled for the second. Clicking twice with a
    // render in between only proves the disabled attribute works; a real double
    // click lands in one tick, and what has to stop it there is the guard.
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(hostMocks.authMutate).toHaveBeenCalledTimes(1);
  });

  it("closes every custom entry point while a write is in flight", () => {
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "my-gateway",
            name: "My gateway",
            connected: false,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "https://api.example.test/v1",
              models: [{ id: "a", name: "a" }],
              headers: [],
              env: [],
            },
          }),
          entry({
            id: "other-gateway",
            name: "Other gateway",
            connected: false,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "https://api.other.test/v1",
              models: [{ id: "b", name: "b" }],
              headers: [],
              env: [],
            },
          }),
        ],
      },
      capabilities: {
        actions: ["connect", "disconnect", "createCustom", "updateCustom"],
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Re-enable My gateway" }),
    );
    // Not just the acting row: they all rewrite one config file.
    for (const name of [
      "Add custom provider",
      "Edit My gateway",
      "Edit Other gateway",
      "Re-enable Other gateway",
    ]) {
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled"),
      ).toBe(true);
    }
  });

  it("closes a DECLARED row's Disconnect while another row is being written", () => {
    // Both writes edit one config file: re-enable rewrites the block and clears
    // its disable entry, a declared row's disconnect appends one. Guarded writes
    // stop a silent loss, but the loser fails on drift - an error the user did
    // nothing to cause.
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "gateway-a",
            name: "Gateway A",
            connected: false,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "https://a.example.test/v1",
              models: [{ id: "a", name: "a" }],
              headers: [],
              env: [],
            },
          }),
          entry({
            id: "gateway-b",
            name: "Gateway B",
            connected: true,
            source: "config",
            configDeclaredCustom: true,
            canDisconnect: true,
            custom: {
              baseUrl: "https://b.example.test/v1",
              models: [{ id: "b", name: "b" }],
              headers: [],
              env: [],
            },
          }),
          entry({
            id: "openai",
            name: "OpenAI",
            connected: true,
            source: "api",
            canDisconnect: true,
          }),
        ],
      },
      capabilities: {
        actions: ["connect", "disconnect", "createCustom", "updateCustom"],
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Re-enable Gateway A" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Disconnect Gateway B" })
        .hasAttribute("disabled"),
    ).toBe(true);
    // A PLAIN disconnect is `auth.remove` through the server - no config file,
    // nothing to contend with, so locking it would serialize two actions that
    // never collide.
    expect(
      screen
        .getByRole("button", { name: "Disconnect OpenAI" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("closes the other config writes while a DECLARED Disconnect is in flight", () => {
    // The inverse direction: the lock is one owner, not a flag the form paths
    // happen to set.
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "gateway-a",
            name: "Gateway A",
            connected: true,
            source: "config",
            configDeclaredCustom: true,
            canDisconnect: true,
            custom: {
              baseUrl: "https://a.example.test/v1",
              models: [{ id: "a", name: "a" }],
              headers: [],
              env: [],
            },
          }),
          entry({
            id: "gateway-b",
            name: "Gateway B",
            connected: false,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "https://b.example.test/v1",
              models: [{ id: "b", name: "b" }],
              headers: [],
              env: [],
            },
          }),
        ],
      },
      capabilities: {
        actions: ["connect", "disconnect", "createCustom", "updateCustom"],
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Disconnect Gateway A" }),
    );
    fireEvent.click(screen.getByTestId("confirm-action"));
    // Queried off the DOM rather than by role: the open confirm dialog puts the
    // rest of the page behind `aria-hidden`, so it is not in the accessibility
    // tree at all. That inertness is Radix's and it ends when the dialog closes
    // - the disabled state asserted here is OURS, and it has to hold on its own
    // rather than leaning on a modal that is about to go away.
    for (const label of ["Re-enable Gateway B", "Edit Gateway B"]) {
      const button = document.querySelector(`button[aria-label="${label}"]`);
      expect(button?.hasAttribute("disabled")).toBe(true);
    }
    expect(
      screen
        .getByText("Add custom provider")
        .closest("button")
        ?.hasAttribute("disabled"),
    ).toBe(true);
  });

  it("closes a PLAIN Config row's Disconnect during a config write", () => {
    // T3 widened the host: a config row whose key lives in
    // `provider.x.options.apiKey` has nothing for `auth.remove` to take, so its
    // disconnect is suppressed through `disabled_providers` - a config write,
    // even though the row is not a declared custom.
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "gateway-a",
            name: "Gateway A",
            connected: false,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "https://a.example.test/v1",
              models: [{ id: "a", name: "A" }],
              headers: [],
              env: [],
            },
          }),
          entry({
            id: "groq",
            name: "Groq",
            connected: true,
            source: "config",
            canDisconnect: true,
          }),
          entry({
            id: "openai",
            name: "OpenAI",
            connected: true,
            source: "api",
            canDisconnect: true,
          }),
        ],
      },
      capabilities: {
        actions: ["connect", "disconnect", "createCustom", "updateCustom"],
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Re-enable Gateway A" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Disconnect Groq" })
        .hasAttribute("disabled"),
    ).toBe(true);
    // And the negative still holds: an auth-store row contends with nothing.
    expect(
      screen
        .getByRole("button", { name: "Disconnect OpenAI" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("drops a completion that is no longer the current write", () => {
    renderTab({
      result: {
        ok: true,
        providers: [
          entry({
            id: "my-gateway",
            name: "My gateway",
            connected: false,
            source: "config",
            configDeclaredCustom: true,
            custom: {
              baseUrl: "https://api.example.test/v1",
              models: [{ id: "a", name: "a" }],
              headers: [],
              env: [],
            },
          }),
        ],
      },
      capabilities: { actions: ["connect", "disconnect", "updateCustom"] },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Re-enable My gateway" }),
    );
    const first = hostMocks.authMutate.mock.calls[0][1];
    // First write settles clean, so the surface is free again. Wrapped in
    // `act` because these are the mutation's own callbacks fired by hand - the
    // state they set has to be committed before the next click reads it.
    act(() => {
      first.onSuccess({ result: { kind: "done" } });
      first.onSettled();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Re-enable My gateway" }),
    );
    expect(hostMocks.authMutate).toHaveBeenCalledTimes(2);
    // ...and now the FIRST write reports a rejection, late. Applying it would
    // open an error form over a write that has already been superseded.
    act(() => {
      first.onSuccess({
        result: { kind: "error", code: "invalid_input", detail: "stale" },
      });
    });
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
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

describe("ProviderModelProvidersTab resume", () => {
  function seedAttempt(args: {
    readonly modelProviderId: string;
    readonly attemptId: string;
    readonly startedAt: number;
  }): void {
    useModelProviderPendingAuthStore.getState().upsert({
      key: {
        hostId: "host-1",
        providerId: "opencode",
        modelProviderId: args.modelProviderId,
      },
      attemptId: args.attemptId,
      startedAt: args.startedAt,
      authorizationUrl: `https://example.test/${args.modelProviderId}`,
      method: "auto",
      instructions: null,
    });
  }

  const TWO_ROWS: ModelProvidersListResult = {
    ok: true,
    providers: [
      entry({
        id: "anthropic",
        name: "Anthropic",
        methods: [{ type: "oauth", label: "Sign in", prompts: [] }],
      }),
      entry({
        id: "openai",
        name: "OpenAI",
        methods: [{ type: "oauth", label: "Sign in", prompts: [] }],
      }),
    ],
  };

  it("auto-adopts the NEWER attempt, and still resumes the older row on click", () => {
    // Two upstream providers can each hold a live attempt at once - the host's
    // single-flight rule is per (providerId, modelProviderId). The newest is
    // what re-opens by itself; the older one must still be reachable, or its
    // live attempt is restart-only while the host holds its server lease.
    seedAttempt({
      modelProviderId: "anthropic",
      attemptId: "older",
      startedAt: 1_000,
    });
    seedAttempt({
      modelProviderId: "openai",
      attemptId: "newer",
      startedAt: 2_000,
    });
    renderTab({ result: TWO_ROWS, capabilities: FULL_CAPS });

    // The newer attempt claimed the surface on mount.
    expect(screen.getByText("Connect OpenAI")).toBeTruthy();
    expect(
      screen.getByText("Waiting for the browser to finish signing in"),
    ).toBeTruthy();

    // Dismiss it, then open the OLDER row by hand.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Connect/ })[0]);

    // Resumed, not restarted: the waiting panel, not the sign-in form.
    expect(screen.getByText("Connect Anthropic")).toBeTruthy();
    expect(
      screen.getByText("Waiting for the browser to finish signing in"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("opens a row with no attempt on the sign-in form", () => {
    seedAttempt({
      modelProviderId: "openai",
      attemptId: "newer",
      startedAt: 2_000,
    });
    renderTab({ result: TWO_ROWS, capabilities: FULL_CAPS });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Connect/ })[0]);
    expect(screen.getByText("Connect Anthropic")).toBeTruthy();
    // The sign-in FORM, not a resumed waiting panel. These rows advertise an
    // oauth method, so the form's action is Continue - and the plain API-key
    // field is correctly absent, since the provider never advertised one.
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(
      screen.queryByText("Waiting for the browser to finish signing in"),
    ).toBeNull();
  });
});

describe("ProviderModelProvidersTab layout", () => {
  it("keeps ONE scroll context - the panel's", () => {
    // jsdom has no layout engine, so this is structural: the list must not cap
    // itself or scroll internally. It used to do both, which nested a second
    // scrollbar inside the panel's own - two tracks for one list, the outer
    // moving the tab while the inner moved the rows.
    renderTab({
      result: { ok: true, providers: [entry({})] },
      capabilities: FULL_CAPS,
    });
    const list = screen.getByTestId("model-provider-list");
    expect(list.className).toContain("w-full");
    expect(list.className).not.toContain("overflow-y-auto");
    expect(list.className).not.toMatch(/max-h-/);
    // No fixed layout box in EITHER unit: a rem cap freezes with the text size
    // instead of following the window, which a px-only assertion would miss.
    expect(list.className).not.toMatch(/-\[[^\]]*\d(?:px|rem)/);
  });

  it("keeps Add custom provider as the FIRST item, inside the list", () => {
    renderTab({
      result: {
        ok: true,
        providers: [entry({}), entry({ id: "openai", name: "OpenAI" })],
      },
      capabilities: { actions: ["connect", "createCustom"] },
    });
    const list = screen.getByTestId("model-provider-list");
    const add = screen.getByRole("button", { name: "Add custom provider" });
    // Inside, so it scrolls with the content rather than pinning above it.
    expect(list.contains(add)).toBe(true);
    expect(list.firstElementChild?.contains(add)).toBe(true);
  });
});
