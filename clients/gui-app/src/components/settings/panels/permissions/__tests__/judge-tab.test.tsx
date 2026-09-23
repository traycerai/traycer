import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import {
  guiAgentModelOptionSchema,
  guiHarnessOptionSchema,
  type GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import type {
  AutoJudgeGetResponse,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { JudgeTab } from "@/components/settings/panels/permissions/judge-tab";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";

// ---- host boundary --------------------------------------------------------

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () =>
    hostScopeFixture({ status: "following", hostId: "host-a" }),
}));
vi.mock("@/components/settings/host-scope/use-scoped-host-binding", () => ({
  useScopedHostBinding: () => ({ hostId: "host-a" }),
}));
vi.mock("@/hooks/host/use-host-capability-probe", () => ({
  useHostCapabilityProbe: (args: {
    readonly client: unknown;
    readonly stale: boolean;
    readonly incarnation: ReadonlyArray<unknown>;
  }): void => {
    void args;
  },
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer-a",
}));

// Whether the host advertises `autoJudge.get` (tri-state, as the real hook is)
// and `autoJudge.set`.
const support = vi.hoisted((): { get: boolean | null; set: boolean } => ({
  get: true,
  set: true,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "autoJudge.get" ? support.get : null,
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    method === "autoJudge.set" ? support.set : false,
}));

// ---- queries --------------------------------------------------------------

const judgeRecord = vi.hoisted(
  (): { current: AutoJudgeGetResponse | undefined } => ({ current: undefined }),
);
vi.mock("@/hooks/auto-mode/use-auto-judge-query", () => ({
  useAutoJudgeQuery: () => ({ data: judgeRecord.current, isError: false }),
}));

interface SetJudgeCallbacks {
  readonly onSuccess: () => void;
  readonly onError: () => void;
}
const setJudgeMutate = vi.hoisted(() =>
  vi.fn<
    (
      variables: { readonly selection: AutoJudgeSelection | null },
      callbacks: SetJudgeCallbacks,
    ) => void
  >(),
);
vi.mock("@/hooks/auto-mode/use-auto-judge-set-mutation", () => ({
  useAutoJudgeSetMutation: () => ({ mutate: setJudgeMutate, isPending: false }),
}));

const catalog = vi.hoisted(
  (): {
    harnesses: ReadonlyArray<GuiHarnessOption>;
    models: Record<string, ReadonlyArray<GuiAgentModelOption>>;
  } => ({ harnesses: [], models: {} }),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({ data: { harnesses: catalog.harnesses } }),
  useGuiHarnessModelsQuery: (harnessId: string) => ({
    data: { models: catalog.models[harnessId] ?? [] },
  }),
}));

const providersState = vi.hoisted(
  (): { current: ReadonlyArray<ProviderCliState> } => ({ current: [] }),
);
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: { providers: providersState.current } }),
}));

const openSettingsMock = vi.hoisted(() =>
  vi.fn<
    (opts: {
      readonly section: string | null;
      readonly resetToGeneral: boolean;
      readonly tab: string | null;
      readonly draft: null;
      readonly hostId: string | null;
    }) => void
  >(),
);
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: openSettingsMock }),
}));

// One row per built-in reviewer is `ProviderJudgeSwitch`, which has its own
// suite; here it is a marker so the LIST is what is under test.
vi.mock(
  "@/components/settings/panels/permissions/provider-judge-switch",
  () => ({
    ProviderJudgeSwitch: (props: {
      readonly state: ProviderCliState;
    }): ReactNode => (
      <div data-testid={`judge-switch-${props.state.providerId}`} />
    ),
  }),
);

// ---- fixtures -------------------------------------------------------------

function harness(overrides: Partial<GuiHarnessOption>): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id: "claude",
    label: "Claude Code",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    ...overrides,
  });
}

function model(
  harnessId: string,
  slug: string,
  label: string,
): GuiAgentModelOption {
  return guiAgentModelOptionSchema.parse({
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    metadata: {},
  });
}

function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind,
    authType: "oauth",
    label: profileId,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

function provider(
  providerId: ProviderId,
  profiles: ProviderProfile[],
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
  };
}

const CLAUDE_STORED: AutoJudgeSelection = {
  harnessId: "claude",
  model: "sonnet",
  profileId: null,
};

beforeEach(() => {
  support.get = true;
  support.set = true;
  judgeRecord.current = { selection: null };
  setJudgeMutate.mockReset();
  catalog.harnesses = [
    harness({ id: "claude", label: "Claude Code", nativeAutoJudge: true }),
    harness({
      id: "codex",
      label: "Codex",
      nativeAutoJudge: false,
      judgeDefaultModel: "gpt-mini",
    }),
  ];
  catalog.models = {
    claude: [model("claude", "sonnet", "Claude Sonnet")],
    codex: [model("codex", "gpt-mini", "GPT Mini")],
  };
  providersState.current = [
    provider("claude-code", [profile("ambient", "ambient")]),
    provider("codex", [profile("ambient", "ambient")]),
  ];
  openSettingsMock.mockReset();
  useProvidersFocusStore.setState({ focusHarnessId: null });
});

afterEach(cleanup);

function radio(name: string): HTMLElement {
  return screen.getByRole("radio", { name });
}

function chooseProvider(label: string): void {
  fireEvent.click(screen.getByTestId("judge-provider-select"));
  fireEvent.click(screen.getByRole("option", { name: label }));
}

describe("JudgeTab", () => {
  describe("Automatic and A specific model", () => {
    it("selects Automatic, with no model fields, when nothing is stored", () => {
      render(<JudgeTab />);

      expect(radio("Automatic").getAttribute("aria-checked")).toBe("true");
      expect(radio("A specific model").getAttribute("aria-checked")).toBe(
        "false",
      );
      expect(screen.queryByTestId("judge-model-field")).toBeNull();
    });

    it("selects A specific model, showing its fields, when a judge is stored", () => {
      judgeRecord.current = { selection: CLAUDE_STORED };
      render(<JudgeTab />);

      expect(radio("A specific model").getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(screen.getByTestId("judge-model-field")).not.toBeNull();
      expect(screen.getByTestId("judge-provider-select").textContent).toContain(
        "Claude Code",
      );
      expect(screen.getByTestId("judge-model-combobox").textContent).toContain(
        "Claude Sonnet",
      );
    });

    it("shows the fields for A specific model without writing anything until one is picked", () => {
      render(<JudgeTab />);

      fireEvent.click(radio("A specific model"));

      expect(screen.getByTestId("judge-model-field")).not.toBeNull();
      expect(setJudgeMutate).not.toHaveBeenCalled();
    });

    it("clears the stored judge when Automatic is chosen again", () => {
      judgeRecord.current = { selection: CLAUDE_STORED };
      render(<JudgeTab />);

      fireEvent.click(radio("Automatic"));

      expect(setJudgeMutate).toHaveBeenCalledTimes(1);
      expect(setJudgeMutate.mock.calls[0][0]).toEqual({ selection: null });
    });
  });

  describe("the Automatic status line", () => {
    it("says no judge can run when effective is null", () => {
      judgeRecord.current = { selection: null, effective: null };
      render(<JudgeTab />);

      expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
        "No judge can run here · Auto mode asks you",
      );
    });

    it("names the conversation's own provider for a fallback", () => {
      judgeRecord.current = {
        selection: null,
        effective: { source: "fallback" },
      };
      render(<JudgeTab />);

      expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
        "Now: the conversation's own provider · your account",
      );
    });

    it("names the model on Traycer, with credits, for the hosted default", () => {
      catalog.harnesses = [harness({ id: "traycer", label: "Traycer" })];
      catalog.models = { traycer: [model("traycer", "haiku", "Claude Haiku")] };
      judgeRecord.current = {
        selection: null,
        effective: { source: "default", harnessId: "traycer", model: "haiku" },
      };
      render(<JudgeTab />);

      expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
        "Now: Claude Haiku on Traycer · uses credits",
      );
    });

    it("stays silent when the host reports no effective judge", () => {
      judgeRecord.current = { selection: null };
      render(<JudgeTab />);

      expect(screen.queryByTestId("auto-judge-effective")).toBeNull();
    });
  });

  describe("writes", () => {
    beforeEach(() => {
      judgeRecord.current = { selection: CLAUDE_STORED };
    });

    it("does not disable any control while a write is in flight", () => {
      render(<JudgeTab />);

      chooseProvider("Codex");
      // The write never settles: `mutate` was called and nothing answered.
      expect(setJudgeMutate).toHaveBeenCalledTimes(1);

      expect(
        screen.getByTestId("judge-provider-select").hasAttribute("disabled"),
      ).toBe(false);
      expect(
        screen.getByTestId("judge-model-combobox").hasAttribute("disabled"),
      ).toBe(false);
      expect(radio("Automatic").hasAttribute("disabled")).toBe(false);
      expect(radio("A specific model").hasAttribute("disabled")).toBe(false);
    });

    it("commits the provider with its default model and keeps the Model field, now showing that model", () => {
      render(<JudgeTab />);

      chooseProvider("Codex");

      expect(setJudgeMutate.mock.calls[0][0]).toEqual({
        selection: { harnessId: "codex", model: "gpt-mini", profileId: null },
      });
      const combobox = screen.getByTestId("judge-model-combobox");
      expect(combobox.hasAttribute("disabled")).toBe(false);
      expect(combobox.textContent).toContain("GPT Mini");
      expect(screen.getByTestId("judge-provider-select").textContent).toContain(
        "Codex",
      );
    });

    it("rolls the display back to the stored selection when the write is refused", () => {
      render(<JudgeTab />);

      chooseProvider("Codex");
      expect(screen.getByTestId("judge-provider-select").textContent).toContain(
        "Codex",
      );

      act(() => {
        setJudgeMutate.mock.calls[0][1].onError();
      });

      expect(screen.getByTestId("judge-provider-select").textContent).toContain(
        "Claude Code",
      );
      expect(screen.getByTestId("judge-model-combobox").textContent).toContain(
        "Claude Sonnet",
      );
    });

    it("commits a chosen model on the current provider", () => {
      catalog.models = {
        ...catalog.models,
        claude: [
          model("claude", "sonnet", "Claude Sonnet"),
          model("claude", "opus", "Claude Opus"),
        ],
      };
      render(<JudgeTab />);

      fireEvent.click(screen.getByTestId("judge-model-combobox"));
      fireEvent.click(screen.getByText("Claude Opus"));

      expect(setJudgeMutate.mock.calls[0][0]).toEqual({
        selection: { harnessId: "claude", model: "opus", profileId: null },
      });
    });
  });

  describe("the model list", () => {
    beforeEach(() => {
      judgeRecord.current = { selection: CLAUDE_STORED };
    });

    it("shows each model by its display label", () => {
      catalog.models = {
        ...catalog.models,
        claude: [
          guiAgentModelOptionSchema.parse({
            harnessId: "claude",
            slug: "sonnet",
            label: "Anthropic: Claude",
            description: null,
            contextWindow: null,
            maxOutputTokens: null,
            defaultReasoningEffort: null,
            supportedReasoningEfforts: [],
            metadata: { openCodeProviderLabel: "Anthropic" },
          }),
        ],
      };
      render(<JudgeTab />);

      fireEvent.click(screen.getByTestId("judge-model-combobox"));

      expect(screen.getByRole("option", { name: "Claude" })).not.toBeNull();
      expect(screen.queryByText("Anthropic: Claude")).toBeNull();
    });

    it("says no model matches a search that matches none of a non-empty catalog", () => {
      render(<JudgeTab />);

      fireEvent.click(screen.getByTestId("judge-model-combobox"));
      fireEvent.change(screen.getByPlaceholderText("Search models…"), {
        target: { value: "zzz-no-such-model" },
      });

      expect(screen.getByText("No matching models.")).not.toBeNull();
    });

    it("says the provider offers no models for an empty catalog, not that nothing matches", () => {
      catalog.models = { ...catalog.models, claude: [] };
      render(<JudgeTab />);

      fireEvent.click(screen.getByTestId("judge-model-combobox"));

      expect(
        screen.getByText(
          "Claude Code offers no models on this machine. Pick another provider.",
        ),
      ).not.toBeNull();
      expect(screen.queryByText("No matching models.")).toBeNull();
    });
  });

  describe("a provider that cannot run a judge", () => {
    beforeEach(() => {
      catalog.harnesses = [
        harness({ id: "claude", label: "Claude Code" }),
        harness({ id: "codex", label: "Codex", enabled: false }),
      ];
      judgeRecord.current = { selection: CLAUDE_STORED };
    });

    it("lists it as a disabled option with its reason and no control inside the list", () => {
      render(<JudgeTab />);

      fireEvent.click(screen.getByTestId("judge-provider-select"));
      const blocked = screen.getByTestId("judge-provider-blocked-codex");

      expect(within(blocked).getByText("Turned off")).not.toBeNull();
      expect(blocked.getAttribute("aria-disabled")).toBe("true");
      expect(within(blocked).queryByRole("button")).toBeNull();
      expect(
        within(screen.getByRole("listbox")).queryByRole("button"),
      ).toBeNull();
    });

    it("links Providers from the warning line for a stored blocked provider, with no second link", () => {
      judgeRecord.current = {
        selection: { harnessId: "codex", model: "gpt-mini", profileId: null },
      };
      render(<JudgeTab />);

      const warning = screen.getByTestId("auto-judge-warning");
      expect(warning.textContent).toContain("Codex is turned off");
      expect(screen.queryByTestId("judge-open-providers")).toBeNull();

      fireEvent.click(
        within(warning).getByRole("button", { name: "Providers" }),
      );

      expect(useProvidersFocusStore.getState().focusHarnessId).toBe("codex");
      expect(openSettingsMock).toHaveBeenCalledTimes(1);
    });

    it("offers Open Providers under the field when the warning line has no link, and opens Providers focused on it", () => {
      catalog.harnesses = [
        harness({ id: "claude", label: "Claude Code" }),
        harness({ id: "codex", label: "Codex", authStatus: "unauthenticated" }),
      ];
      judgeRecord.current = {
        selection: { harnessId: "codex", model: "gpt-mini", profileId: null },
        blocked: { reason: "unsupported-harness" },
      };
      render(<JudgeTab />);

      expect(screen.getByTestId("auto-judge-warning").textContent).toContain(
        "can't run a judge on Codex",
      );
      fireEvent.click(screen.getByTestId("judge-open-providers"));

      expect(useProvidersFocusStore.getState().focusHarnessId).toBe("codex");
      expect(openSettingsMock).toHaveBeenCalledTimes(1);
      expect(openSettingsMock).toHaveBeenCalledWith({
        section: "providers",
        resetToGeneral: false,
        tab: null,
        draft: null,
        hostId: null,
      });
    });

    it("offers no Open Providers for a displayed provider that can run", () => {
      render(<JudgeTab />);

      expect(screen.queryByTestId("judge-open-providers")).toBeNull();
    });

    it("renders no such row for a provider that can run", () => {
      render(<JudgeTab />);

      fireEvent.click(screen.getByTestId("judge-provider-select"));

      expect(screen.queryByTestId("judge-provider-blocked-claude")).toBeNull();
    });
  });

  describe("the Account field", () => {
    beforeEach(() => {
      judgeRecord.current = { selection: CLAUDE_STORED };
    });

    it("is absent with a single account", () => {
      render(<JudgeTab />);

      expect(screen.queryByTestId("judge-account-select")).toBeNull();
    });

    it("appears when the provider has more than one account", () => {
      providersState.current = [
        provider("claude-code", [
          profile("ambient", "ambient"),
          profile("work", "managed"),
        ]),
        provider("codex", [profile("ambient", "ambient")]),
      ];
      render(<JudgeTab />);

      expect(screen.getByTestId("judge-account-select")).not.toBeNull();
    });
  });

  describe("Providers with a built-in reviewer", () => {
    it("lists only providers whose catalog row has a native judge", () => {
      render(<JudgeTab />);

      const list = screen.getByTestId("auto-judge-built-in-reviewers");
      expect(within(list).getByText("Claude Code")).not.toBeNull();
      expect(
        within(list).getByTestId("judge-switch-claude-code"),
      ).not.toBeNull();
      expect(within(list).queryByText("Codex")).toBeNull();
      expect(within(list).queryByTestId("judge-switch-codex")).toBeNull();
    });

    it("is omitted when no provider has a built-in reviewer", () => {
      catalog.harnesses = catalog.harnesses.map((row) => ({
        ...row,
        nativeAutoJudge: false,
      }));
      render(<JudgeTab />);

      expect(screen.queryByTestId("auto-judge-built-in-reviewers")).toBeNull();
    });
  });

  describe("a host without Auto mode", () => {
    it("shows the one unsupported line, and no controls", () => {
      support.get = false;
      render(<JudgeTab />);

      expect(screen.getByTestId("auto-mode-unsupported").textContent).toContain(
        "predates Auto mode",
      );
      expect(screen.queryByRole("radio")).toBeNull();
    });

    it("says nothing while support is still unknown", () => {
      support.get = null;
      render(<JudgeTab />);

      expect(screen.queryByTestId("auto-mode-unsupported")).toBeNull();
      expect(screen.queryByRole("radio")).toBeNull();
    });
  });

  it("says so, and disables the controls, when the host cannot store a judge", () => {
    support.set = false;
    render(<JudgeTab />);

    expect(
      screen.getByText(/This machine's host can't change the judge/),
    ).not.toBeNull();
    expect(radio("Automatic").hasAttribute("disabled")).toBe(true);
  });
});
