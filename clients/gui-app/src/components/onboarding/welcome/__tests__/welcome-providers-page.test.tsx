import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  ProviderAuth,
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";

/**
 * The page over a REAL `providers.list` query and a REAL `setEnabled`
 * mutation, each with a controllable request: what renders for each row,
 * what a switch flip sends, and when Continue is on offer. The Continue
 * gate (`useWelcomeRoster`) is fed by the query client's caches, so stubs
 * returning result objects would leave those caches silent and the gate
 * vacuous. Tooltips are Radix, so their text is asserted by opening them
 * with a pointer move rather than by reading a `title`.
 */
interface Deferred<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

const fixtures = vi.hoisted(() => ({
  providers: [] as ProviderCliState[],
  /** Seed the query with `providers` at mount, as the modal usually has. */
  resolved: true,
  /**
   * What a fetch answers: `"ask"` parks it on `deferred` for the test to
   * settle; `"providers"` answers the current `providers` at once - a fetch
   * that starts and lands inside one render interval.
   */
  answer: "ask" as "ask" | "providers",
  deferred: null as Deferred<{ providers: ProviderCliState[] }> | null,
  fetches: 0,
  /** The host the list is keyed on; toggles name theirs in `onMutate`. */
  hostId: "host-a",
}));

vi.mock("@/hooks/providers/use-providers-list-query", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  const { welcomeRosterQueryKey } =
    await import("@/stores/onboarding/welcome-roster-freshness-store");
  return {
    useProvidersList: () =>
      useQuery({
        queryKey: welcomeRosterQueryKey(fixtures.hostId),
        queryFn: () => {
          fixtures.fetches += 1;
          if (fixtures.answer === "providers") {
            return Promise.resolve({ providers: fixtures.providers });
          }
          return new Promise<{ providers: ProviderCliState[] }>(
            (resolve, reject) => {
              fixtures.deferred = { resolve, reject };
            },
          );
        },
        initialData: fixtures.resolved
          ? { providers: fixtures.providers }
          : undefined,
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
      }),
  };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => fixtures.hostId,
}));

/**
 * A REAL mutation under the hook's own key, with a controllable request:
 * the page's Continue gate reads the mutation cache (`useWelcomeRoster`),
 * so a stub returning `{ mutate, isPending }` would leave that cache empty
 * and the gate vacuous. `deferred` holds the in-flight request's resolvers.
 */
const setEnabledFixture = vi.hoisted(() => ({
  requests: [] as unknown[],
  deferred: null as {
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  } | null,
  /** The host the toggle is aimed at - what `useHostScopedMutation` captures. */
  hostId: "host-a",
}));

vi.mock("@/hooks/providers/use-providers-set-enabled-mutation", async () => {
  const { useMutation, useQueryClient } = await import("@tanstack/react-query");
  const { providersMutationKeys } = await import("@/lib/query-keys");
  const { welcomeRosterQueryKey } =
    await import("@/stores/onboarding/welcome-roster-freshness-store");
  return {
    useProvidersSetEnabled: () => {
      const queryClient = useQueryClient();
      return useMutation({
        mutationKey: providersMutationKeys.setEnabled(),
        // Not paused offline: the paused-refresh case takes the app offline
        // to pause the LIST, and the toggle must still land.
        networkMode: "always",
        // The shape `useHostScopedMutation` captures at `onMutate` ...
        onMutate: () => ({
          hostId: setEnabledFixture.hostId,
          captured: undefined,
        }),
        // ... and the invalidation it fires inside `onSuccess`, un-awaited,
        // BEFORE the mutation's status flips to success.
        onSuccess: (_data, _variables, context) => {
          void queryClient.invalidateQueries({
            queryKey: welcomeRosterQueryKey(context.hostId),
          });
        },
        mutationFn: (variables: unknown) => {
          setEnabledFixture.requests.push(variables);
          return new Promise<void>((resolve, reject) => {
            setEnabledFixture.deferred = { resolve, reject };
          });
        },
      });
    },
  };
});

import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { WelcomeProvidersPage } from "@/components/onboarding/welcome/welcome-providers-page";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ORDERED_PROVIDERS } from "@/lib/provider-ordering";

const UNKNOWN_AUTH: ProviderAuth = {
  status: "unknown",
  badgeText: null,
  label: null,
  detail: null,
};

function providerState(input: {
  readonly providerId: ProviderId;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly auth: ProviderAuth;
}): ProviderCliState {
  return {
    providerId: input.providerId,
    enabled: input.enabled,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: input.installed
      ? [
          {
            kind: "path",
            path: "/usr/bin/x",
            available: true,
            version: "1.0.0",
            versionPending: false,
          },
        ]
      : [],
    auth: input.auth,
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
  };
}

function defaultProviders(): ProviderCliState[] {
  return [
    providerState({
      providerId: "claude-code",
      enabled: true,
      installed: true,
      auth: {
        status: "authenticated",
        badgeText: null,
        label: "jane@example.com",
        detail: "Signed in as jane@example.com",
      },
    }),
    providerState({
      providerId: "codex",
      enabled: true,
      installed: true,
      auth: { ...UNKNOWN_AUTH, status: "unauthenticated" },
    }),
    providerState({
      providerId: "cursor",
      enabled: false,
      installed: false,
      auth: UNKNOWN_AUTH,
    }),
    providerState({
      providerId: "grok",
      enabled: false,
      installed: true,
      auth: UNKNOWN_AUTH,
    }),
    providerState({
      providerId: "opencode",
      enabled: true,
      installed: true,
      auth: UNKNOWN_AUTH,
    }),
    providerState({
      providerId: "traycer",
      enabled: false,
      installed: false,
      auth: UNKNOWN_AUTH,
    }),
    providerState({
      providerId: "kimi",
      enabled: false,
      installed: true,
      auth: UNKNOWN_AUTH,
    }),
  ];
}

let rerenderMounted: ((ui: ReactElement) => void) | null = null;
const onContinueMock = vi.fn();
const onSkipMock = vi.fn();
// One client per test, held here so a test can reach its caches.
let queryClient = newQueryClient();

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function pageElement(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <WelcomeProvidersPage onContinue={onContinueMock} onSkip={onSkipMock} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function renderPage(): { onContinue: Mock; onSkip: Mock } {
  rerenderMounted = render(pageElement()).rerender;
  return { onContinue: onContinueMock, onSkip: onSkipMock };
}

/** The variables of the n-th `providers.setEnabled` request, once it is sent. */
async function sentRequest(index: number): Promise<unknown> {
  await waitFor(() => {
    expect(setEnabledFixture.requests.length).toBeGreaterThan(index);
  });
  return setEnabledFixture.requests[index];
}

async function settleRequest(outcome: "success" | "failure"): Promise<void> {
  await waitFor(() => {
    expect(setEnabledFixture.deferred).not.toBeNull();
  });
  const deferred = setEnabledFixture.deferred;
  if (deferred === null) throw new Error("no request in flight");
  setEnabledFixture.deferred = null;
  await act(async () => {
    if (outcome === "success") deferred.resolve();
    else deferred.reject(new Error("host refused"));
    await Promise.resolve();
  });
}

/** Re-render with the fixtures' current values (the mocks read them live). */
function rerenderPage(): void {
  if (rerenderMounted === null) throw new Error("page not rendered");
  rerenderMounted(pageElement());
}

/** Wait for the n-th list fetch to have asked, then answer it. */
async function answerFetch(
  ordinal: number,
  outcome:
    | { readonly providers: ProviderCliState[] }
    | { readonly error: string },
): Promise<void> {
  await waitFor(() => {
    expect(fixtures.fetches).toBeGreaterThanOrEqual(ordinal);
    expect(fixtures.deferred).not.toBeNull();
  });
  const deferred = fixtures.deferred;
  if (deferred === null) throw new Error("no fetch in flight");
  fixtures.deferred = null;
  await act(async () => {
    if ("error" in outcome) deferred.reject(new Error(outcome.error));
    else deferred.resolve({ providers: outcome.providers });
    await Promise.resolve();
  });
}

function tile(providerId: ProviderId): HTMLElement {
  const match = screen
    .getAllByTestId("welcome-provider-tile")
    .find((element) => element.dataset.providerId === providerId);
  if (match === undefined) throw new Error(`no tile for ${providerId}`);
  return match;
}

/** The switch is named for what it does, so its name flips with its state. */
function switchFor(name: string): HTMLElement {
  return screen.getByRole("switch", {
    name: (accessibleName) =>
      accessibleName === `Enable ${name}` ||
      accessibleName === `Disable ${name}`,
  });
}

describe("<WelcomeProvidersPage />", () => {
  beforeEach(() => {
    fixtures.providers = defaultProviders();
    fixtures.resolved = true;
    fixtures.answer = "ask";
    fixtures.deferred = null;
    fixtures.fetches = 0;
    fixtures.hostId = "host-a";
    setEnabledFixture.requests.length = 0;
    setEnabledFixture.deferred = null;
    setEnabledFixture.hostId = "host-a";
    onContinueMock.mockReset();
    onSkipMock.mockReset();
    onlineManager.setOnline(true);
    queryClient = newQueryClient();
  });

  afterEach(() => {
    cleanup();
    rerenderMounted = null;
    onlineManager.setOnline(true);
  });

  it("renders the six major tiles in order, then a disclosure for the rest", () => {
    renderPage();
    expect(
      screen
        .getAllByTestId("welcome-provider-tile")
        .map((element) => element.dataset.providerId),
    ).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "traycer",
    ]);
    const minorCount = ORDERED_PROVIDERS.length - 6;
    const more = screen.getByRole("button", {
      name: `${minorCount} more providers`,
    });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("welcome-provider-row")).toBeNull();

    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const rows = screen.getAllByTestId("welcome-provider-row");
    expect(rows).toHaveLength(minorCount);
    // Minors keep the catalogue order; Kimi is in there with its live badge.
    expect(rows.map((element) => element.dataset.providerId)).toEqual(
      ORDERED_PROVIDERS.map((provider) => provider.providerId).filter(
        (providerId) =>
          ![
            "claude-code",
            "codex",
            "cursor",
            "grok",
            "opencode",
            "traycer",
          ].includes(providerId),
      ),
    );
    const kimi = rows.find((element) => element.dataset.providerId === "kimi");
    if (kimi === undefined) throw new Error("no kimi row");
    expect(within(kimi).getByTestId("welcome-provider-badge").textContent).toBe(
      "Installed",
    );
  });

  it("shows the badge, subtitle and switch state per tile", async () => {
    renderPage();
    const claude = tile("claude-code");
    expect(
      within(claude).getByTestId("welcome-provider-badge").textContent,
    ).toBe("Installed");
    const claudeSubtitle = within(claude).getByTestId(
      "welcome-provider-subtitle",
    );
    expect(claudeSubtitle.textContent).toBe("jane@example.com");
    // The account line is the one thing that truncates, so its full text is
    // a hover away; the name never truncates (QA B9: "Claude…").
    expect(claudeSubtitle.classList.contains("truncate")).toBe(true);
    fireEvent.pointerMove(claudeSubtitle);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "jane@example.com",
    );
    expect(
      within(claude).getByText("Claude Code").classList.contains("truncate"),
    ).toBe(false);
    expect(switchFor("Claude Code").getAttribute("aria-checked")).toBe("true");
    // Named for the action it performs, so the name flips with the state.
    expect(switchFor("Claude Code").getAttribute("aria-label")).toBe(
      "Disable Claude Code",
    );
    expect(switchFor("Grok").getAttribute("aria-label")).toBe("Enable Grok");

    // Unauthenticated: enabled, no subtitle (the state lives in the tooltip).
    const codex = tile("codex");
    expect(within(codex).queryByTestId("welcome-provider-subtitle")).toBeNull();
    expect(switchFor("Codex").getAttribute("aria-checked")).toBe("true");

    // Not found: info-only.
    const cursor = tile("cursor");
    expect(
      within(cursor).getByTestId("welcome-provider-badge").textContent,
    ).toBe("Not found");
    expect(switchFor("Cursor").hasAttribute("disabled")).toBe(true);

    // Built in, off: connected (the ready line stays) with the switch off.
    const traycer = tile("traycer");
    expect(
      within(traycer).getByTestId("welcome-provider-badge").textContent,
    ).toBe("Built in");
    expect(
      within(traycer).getByTestId("welcome-provider-subtitle").textContent,
    ).toBe("Ready with your Traycer subscription");
    expect(switchFor("Traycer Inference").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(switchFor("Traycer Inference").hasAttribute("disabled")).toBe(false);
  });

  it("flipping a switch calls providers.setEnabled with no profile action", async () => {
    renderPage();
    fireEvent.click(switchFor("Grok"));
    expect(await sentRequest(0)).toEqual({
      providerId: "grok",
      enabled: true,
      profileAction: null,
    });
    await settleRequest("success");
    await waitFor(() => {
      expect(switchFor("Traycer Inference").hasAttribute("disabled")).toBe(
        false,
      );
    });
    fireEvent.click(switchFor("Traycer Inference"));
    expect(await sentRequest(1)).toEqual({
      providerId: "traycer",
      enabled: true,
      profileAction: null,
    });
  });

  it("disables every switch while the shared mutation is in flight", async () => {
    renderPage();
    fireEvent.click(switchFor("Grok"));
    await sentRequest(0);
    await waitFor(() => {
      for (const element of screen.getAllByRole("switch")) {
        expect(element.hasAttribute("disabled")).toBe(true);
      }
    });
    fireEvent.click(switchFor("Codex"));
    expect(setEnabledFixture.requests).toHaveLength(1);
  });

  it("refuses to turn off the last enabled provider and says why", async () => {
    fixtures.providers = [
      providerState({
        providerId: "claude-code",
        enabled: true,
        installed: true,
        auth: UNKNOWN_AUTH,
      }),
      providerState({
        providerId: "grok",
        enabled: false,
        installed: true,
        auth: UNKNOWN_AUTH,
      }),
    ];
    renderPage();
    const claude = switchFor("Claude Code");
    expect(claude.hasAttribute("disabled")).toBe(true);
    expect(switchFor("Grok").hasAttribute("disabled")).toBe(false);
    const guard = claude.parentElement;
    if (guard === null) throw new Error("no guard span");
    fireEvent.pointerMove(guard);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain(
      "At least one provider must stay enabled.",
    );
  });

  it("explains a missing install on hover", async () => {
    renderPage();
    fireEvent.pointerMove(
      within(tile("cursor")).getByTestId("welcome-provider-identity"),
    );
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain(
      "Install Cursor on this machine to use it.",
    );
  });

  it("offers no sign-in anywhere on the page", () => {
    renderPage();
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
    expect(screen.queryByText(/sign in/i)).toBeNull();
  });

  it("Continue and Skip setup call the props", () => {
    const { onContinue, onSkip } = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  const continueButton = (): HTMLElement =>
    screen.getByRole("button", { name: "Continue" });

  const grokEnabled = (): ProviderCliState[] =>
    defaultProviders().map((provider) =>
      provider.providerId === "grok"
        ? { ...provider, enabled: true }
        : provider,
    );

  /** Click Grok on, let the host accept it, and let its invalidation refetch ask. */
  async function toggleGrokOn(): Promise<void> {
    fireEvent.click(switchFor("Grok"));
    await sentRequest(setEnabledFixture.requests.length);
    await settleRequest("success");
  }

  it("withholds Continue until providers.list resolves, showing Detecting… tiles meanwhile", async () => {
    fixtures.resolved = false;
    const { onContinue } = renderPage();
    expect(continueButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();
    expect(
      within(tile("claude-code")).getByTestId("welcome-provider-badge")
        .textContent,
    ).toBe("Detecting…");
    for (const element of screen.getAllByRole("switch")) {
      expect(element.hasAttribute("disabled")).toBe(true);
    }

    await answerFetch(1, { providers: defaultProviders() });
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("withholds Continue through a toggle in flight AND until a fetch that started after its success completes", async () => {
    const { onContinue } = renderPage();
    expect(continueButton().hasAttribute("disabled")).toBe(false);

    // The toggle is sent; the mutation is pending.
    fireEvent.click(switchFor("Grok"));
    await sentRequest(0);
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(true);
    });
    fireEvent.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();

    // The host accepts; the refetch its success invalidates into asks. It
    // started BEFORE the mutation reported success, so it is stamped with
    // the old generation.
    await settleRequest("success");
    await waitFor(() => {
      expect(fixtures.fetches).toBe(1);
    });
    expect(continueButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();

    // It lands - with the pre-toggle roster, as a read that raced the write
    // can. Not a receipt: the tracker asks for one more fetch, exactly one,
    // and Continue stays withheld.
    await answerFetch(1, { providers: defaultProviders() });
    await waitFor(() => {
      expect(fixtures.fetches).toBe(2);
    });
    expect(continueButton().hasAttribute("disabled")).toBe(true);
    rerenderPage();
    expect(fixtures.fetches).toBe(2);

    // That fetch started under the new generation and lands the new roster.
    await answerFetch(2, { providers: grokEnabled() });
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(false);
    });
    expect(switchFor("Grok").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(fixtures.fetches).toBe(2);
  });

  it("receipts a fetch that starts and lands inside one render interval", async () => {
    // Every fetch answers at once: the invalidation refetch and the extra
    // one both start and land with no render in between.
    fixtures.answer = "providers";
    const { onContinue } = renderPage();
    fixtures.providers = grokEnabled();
    await toggleGrokOn();
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(false);
    });
    expect(fixtures.fetches).toBe(2);
    expect(switchFor("Grok").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("a failed refresh after a successful toggle keeps Continue withheld and offers Retry, until a retry lands the new roster", async () => {
    const { onContinue } = renderPage();
    await toggleGrokOn();
    // The invalidation refetch fails: TanStack keeps the OLD data.
    await answerFetch(1, { error: "host went away" });
    await waitFor(() => {
      expect(screen.getByTestId("welcome-providers-error")).not.toBeNull();
    });
    expect(continueButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();
    // Cached data or not, the way forward is the retry - nothing fetches on
    // its own over an error.
    expect(switchFor("Grok").getAttribute("aria-checked")).toBe("false");
    rerenderPage();
    expect(fixtures.fetches).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    // The retry started after the toggle and lands the post-toggle roster.
    await answerFetch(2, { providers: grokEnabled() });
    await waitFor(() => {
      expect(screen.queryByTestId("welcome-providers-error")).toBeNull();
      expect(continueButton().hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(fixtures.fetches).toBe(2);
  });

  it("a paused refresh is not a receipt", async () => {
    const { onContinue } = renderPage();
    // Offline: the toggle still lands (its mode is `always`), but the list
    // refetch it invalidates into pauses before reading anything.
    onlineManager.setOnline(false);
    await toggleGrokOn();
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(true);
    });
    rerenderPage();
    expect(fixtures.fetches).toBe(0);
    fireEvent.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();

    // Back online: it continues, reads, and lands the post-toggle roster.
    act(() => {
      onlineManager.setOnline(true);
    });
    await answerFetch(1, { providers: grokEnabled() });
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(false);
    });
    expect(fixtures.fetches).toBe(1);
  });

  it("a FAILED toggle requires no refresh: Continue returns once the mutation settles", async () => {
    const { onContinue } = renderPage();
    fireEvent.click(switchFor("Grok"));
    await sentRequest(0);
    await settleRequest("failure");
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(false);
    });
    expect(fixtures.fetches).toBe(0);
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("a toggle aimed at ANOTHER host is not this roster's business", async () => {
    setEnabledFixture.hostId = "host-b";
    const { onContinue } = renderPage();
    fireEvent.click(switchFor("Grok"));
    await sentRequest(0);
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(true);
    });
    await settleRequest("success");
    // Host B's list was invalidated, not this one: no fetch, nothing owed.
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(false);
    });
    expect(fixtures.fetches).toBe(0);
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("still requires a refresh for a new toggle after older toggles left the mutation cache", async () => {
    const { onContinue } = renderPage();
    // First toggle, fully receipted.
    await toggleGrokOn();
    await answerFetch(1, { providers: defaultProviders() });
    await answerFetch(2, { providers: grokEnabled() });
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(false);
    });

    // The cache forgets the settled mutation (what gcTime does later).
    act(() => {
      for (const mutation of queryClient.getMutationCache().getAll()) {
        queryClient.getMutationCache().remove(mutation);
      }
    });

    // Second toggle: a count of successes in the cache would now be 1,
    // equal to what has been satisfied, and let Continue through on the
    // pre-toggle roster. The requirement is monotonic, so it does not.
    fixtures.providers = grokEnabled();
    fireEvent.click(switchFor("Grok"));
    await sentRequest(1);
    await settleRequest("success");
    await answerFetch(3, { providers: grokEnabled() });
    await waitFor(() => {
      expect(fixtures.fetches).toBe(4);
    });
    expect(continueButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();
    await answerFetch(4, { providers: defaultProviders() });
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(false);
    });
  });

  it("on a list error with no data: Unavailable tiles, an inline retry, and no Continue", async () => {
    fixtures.resolved = false;
    const { onContinue } = renderPage();
    await answerFetch(1, { error: "host unreachable" });
    expect(await screen.findByTestId("welcome-providers-error")).not.toBeNull();
    expect(
      within(tile("codex")).getByTestId("welcome-provider-badge").textContent,
    ).toBe("Unavailable");
    expect(continueButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();

    // Retry asks again; the answer seats the roster and Continue.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await answerFetch(2, { providers: defaultProviders() });
    await waitFor(() => {
      expect(screen.queryByTestId("welcome-providers-error")).toBeNull();
      expect(continueButton().hasAttribute("disabled")).toBe(false);
    });
  });
});
