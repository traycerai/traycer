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
        credentialKey: null,
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
    expect(screen.getByText("Saved in OpenCode")).toBeTruthy();
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
    // The label names the controlling PARTY as a fact; the badge beside the
    // name already says where the credential comes from.
    expect(screen.getByText("Set by environment")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove saved Groq key" }),
    ).toBeNull();
    // Connect STAYS: `source` is a status, not a permission. Setting a
    // provider up and choosing which credential wins are different decisions,
    // and the dialog carries the precedence warning.
    expect(screen.getByRole("button", { name: /Replace/ })).toBeTruthy();
  });

  it("names the controlling party per source", () => {
    // `config` and `custom` share a line on purpose - both resolve to something
    // edited in OpenCode's own files - and the badge is what distinguishes
    // them.
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
            id: "poe",
            name: "Poe",
            connected: true,
            source: "custom",
            canDisconnect: false,
          }),
        ],
      },
      capabilities: FULL_CAPS,
    });
    expect(screen.getByText("Set in config file")).toBeTruthy();
    // `custom` gets its OWN line: that loader is frequently fed by the auth
    // store (xai signs in through OAuth and still reports `custom`), so
    // pointing at a config file would send the user where the credential isn't.
    expect(screen.getByText("Set by a custom loader")).toBeTruthy();
    expect(screen.getByText("Config file")).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(screen.queryByText("Managed outside Traycer")).toBeNull();
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
            credentialKey: "OPENAI_API_KEY",
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
    expect(screen.getByTestId("model-provider-source-label").textContent).toBe(
      "Set by environment",
    );
    // Still configurable - the warning belongs in the dialog, not in a block.
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
      screen.queryByRole("button", { name: "Remove saved OpenAI key" }),
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
      screen.queryByRole("button", { name: "Remove saved OpenAI key" }),
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
    expect(screen.getByText("Saved in OpenCode")).toBeTruthy();
    expect(screen.queryByText("Saved in Traycer")).toBeNull();
  });

  it("gives the remove control destructive intent and a tooltip", () => {
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
    const remove = screen.getByRole("button", {
      name: "Remove saved OpenAI key",
    });
    // The icon-level destructive pattern the rest of Settings uses: quiet until
    // hovered, rather than a permanently-red button among neutral rows.
    expect(remove.className).toContain("hover:text-destructive");
    expect(remove.className).toContain("hover:bg-destructive/10");
    // Radix renders tooltip CONTENT only once open, which jsdom's layout-free
    // environment cannot drive. `TooltipWrapper` renders a bare Slot when its
    // label is empty and a real `TooltipTrigger` otherwise, so this slot is the
    // structural proof that a tooltip is wired at all.
    expect(remove.getAttribute("data-slot")).toBe("tooltip-trigger");
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
      screen.getByRole("button", { name: "Remove saved OpenAI key" }),
    );
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
