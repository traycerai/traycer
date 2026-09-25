import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
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
  type AgentReasoningEffortOption,
  type GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
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
vi.mock(
  "@/components/settings/host-scope/use-scoped-host-binding",
  async () => {
    const { scopedHostBindingFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    return {
      useScopedHostBinding: (scope: HostScope) =>
        scopedHostBindingFixture(scope),
    };
  },
);
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
// and `autoJudge.set`, plus the NEGOTIATED VERSION of `autoJudge.set` - the
// Effort field's own gate, independent of whether the method exists at all.
const support = vi.hoisted(
  (): {
    get: boolean | null;
    set: boolean;
    setVersion: SchemaVersion | null;
  } => ({
    get: true,
    set: true,
    // `1.2`: the line that added `reasoningEffort`, so the Effort field
    // shows by default and individual tests dial it back to `1.1` (or
    // `null`, unknown) to prove it hides.
    setVersion: { major: 1, minor: 2 },
  }),
);
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "autoJudge.get" ? support.get : null,
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    method === "autoJudge.set" ? support.set : false,
  useHostMethodSchemaVersion: (_hostId: string | null, method: string) =>
    method === "autoJudge.set" ? support.setVersion : null,
}));

// ---- queries --------------------------------------------------------------

const judgeRecord = vi.hoisted(
  (): { current: AutoJudgeGetResponse | undefined } => ({ current: undefined }),
);
// One record for both readers: the selection's and the current verdict's.
// Their freshness rules are exercised against the real cache in
// `judge-tab-live.test.tsx`.
vi.mock("@/hooks/auto-mode/use-auto-judge-query", () => ({
  useAutoJudgeQuery: () => ({ data: judgeRecord.current, isError: false }),
  useAutoJudgeVerdict: () => judgeRecord.current,
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
// What the harness catalog query answers: data, a failure, or still pending.
const catalogState = vi.hoisted(
  (): { current: "answered" | "failed" | "pending" } => ({
    current: "answered",
  }),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () =>
    catalogState.current === "answered"
      ? { data: { harnesses: catalog.harnesses }, isError: false }
      : { data: undefined, isError: catalogState.current === "failed" },
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
  supportedReasoningEfforts: ReadonlyArray<AgentReasoningEffortOption>,
): GuiAgentModelOption {
  return guiAgentModelOptionSchema.parse({
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts,
    metadata: {},
  });
}

function effortOption(id: string, label: string): AgentReasoningEffortOption {
  return { id, label, description: null };
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
  reasoningEffort: null,
};

beforeEach(() => {
  support.get = true;
  support.set = true;
  support.setVersion = { major: 1, minor: 2 };
  judgeRecord.current = { selection: null };
  setJudgeMutate.mockReset();
  catalogState.current = "answered";
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
    claude: [model("claude", "sonnet", "Claude Sonnet", [])],
    codex: [model("codex", "gpt-mini", "GPT Mini", [])],
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
      catalog.models = {
        traycer: [model("traycer", "haiku", "Claude Haiku", [])],
      };
      judgeRecord.current = {
        selection: null,
        effective: { source: "default", harnessId: "traycer", model: "haiku" },
      };
      render(<JudgeTab />);

      expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
        "Now: Claude Haiku on Traycer · uses credits",
      );
    });

    it("appends the model's lowest effort on a 1.2 host whose default model advertises one", () => {
      support.setVersion = { major: 1, minor: 2 };
      catalog.harnesses = [harness({ id: "traycer", label: "Traycer" })];
      catalog.models = {
        traycer: [
          model("traycer", "haiku", "Claude Haiku", [
            effortOption("low", "Low"),
            effortOption("medium", "Medium"),
          ]),
        ],
      };
      judgeRecord.current = {
        selection: null,
        effective: { source: "default", harnessId: "traycer", model: "haiku" },
      };
      render(<JudgeTab />);

      expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
        "Now: Claude Haiku (Low) on Traycer · uses credits",
      );
    });

    it("names no effort on a 1.1 host, even when the default model advertises one", () => {
      support.setVersion = { major: 1, minor: 1 };
      catalog.harnesses = [harness({ id: "traycer", label: "Traycer" })];
      catalog.models = {
        traycer: [
          model("traycer", "haiku", "Claude Haiku", [
            effortOption("low", "Low"),
            effortOption("medium", "Medium"),
          ]),
        ],
      };
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
        selection: {
          harnessId: "codex",
          model: "gpt-mini",
          profileId: null,
          reasoningEffort: null,
        },
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
          model("claude", "sonnet", "Claude Sonnet", []),
          model("claude", "opus", "Claude Opus", []),
        ],
      };
      render(<JudgeTab />);

      fireEvent.click(screen.getByTestId("judge-model-combobox"));
      fireEvent.click(screen.getByText("Claude Opus"));

      expect(setJudgeMutate.mock.calls[0][0]).toEqual({
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: null,
        },
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
        selection: {
          harnessId: "codex",
          model: "gpt-mini",
          profileId: null,
          reasoningEffort: null,
        },
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
        selection: {
          harnessId: "codex",
          model: "gpt-mini",
          profileId: null,
          reasoningEffort: null,
        },
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

  describe("the Effort field", () => {
    const LOW = effortOption("low", "Low");
    const MEDIUM = effortOption("medium", "Medium");

    beforeEach(() => {
      catalog.models = {
        ...catalog.models,
        claude: [
          model("claude", "sonnet", "Claude Sonnet", [LOW, MEDIUM]),
          model("claude", "opus", "Claude Opus", []),
        ],
      };
      judgeRecord.current = { selection: CLAUDE_STORED };
    });

    it("shows 'Default (Low)' plus the model's advertised efforts on a 1.2 host", () => {
      render(<JudgeTab />);

      fireEvent.click(screen.getByTestId("judge-effort-select"));

      expect(
        screen.getByRole("option", { name: "Default (Low)" }),
      ).not.toBeNull();
      expect(screen.getByRole("option", { name: "Low" })).not.toBeNull();
      expect(screen.getByRole("option", { name: "Medium" })).not.toBeNull();
    });

    it("calls autoJudge.set with the picked effort", () => {
      render(<JudgeTab />);

      fireEvent.click(screen.getByTestId("judge-effort-select"));
      fireEvent.click(screen.getByRole("option", { name: "Medium" }));

      expect(setJudgeMutate.mock.calls[0][0]).toEqual({
        selection: {
          harnessId: "claude",
          model: "sonnet",
          profileId: null,
          reasoningEffort: "medium",
        },
      });
    });

    it("is absent on a host negotiated below autoJudge.set@1.2", () => {
      support.setVersion = { major: 1, minor: 1 };
      render(<JudgeTab />);

      expect(screen.queryByTestId("judge-effort-select")).toBeNull();
    });

    it("is absent when the negotiated version is unknown", () => {
      support.setVersion = null;
      render(<JudgeTab />);

      expect(screen.queryByTestId("judge-effort-select")).toBeNull();
    });

    it("is absent when the chosen model advertises no efforts", () => {
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: null,
        },
      };
      render(<JudgeTab />);

      expect(screen.queryByTestId("judge-effort-select")).toBeNull();
    });

    it("resets the effort to null when the model changes and the new model drops it", () => {
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "sonnet",
          profileId: null,
          reasoningEffort: "medium",
        },
      };
      render(<JudgeTab />);

      fireEvent.click(screen.getByTestId("judge-model-combobox"));
      fireEvent.click(screen.getByText("Claude Opus"));

      expect(setJudgeMutate.mock.calls[0][0]).toEqual({
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: null,
        },
      });
    });

    it("keeps the effort when the new model still advertises the same id", () => {
      catalog.models = {
        ...catalog.models,
        claude: [
          model("claude", "sonnet", "Claude Sonnet", [LOW, MEDIUM]),
          model("claude", "opus", "Claude Opus", [LOW, MEDIUM]),
        ],
      };
      judgeRecord.current = {
        selection: {
          harnessId: "claude",
          model: "sonnet",
          profileId: null,
          reasoningEffort: "medium",
        },
      };
      render(<JudgeTab />);

      fireEvent.click(screen.getByTestId("judge-model-combobox"));
      fireEvent.click(screen.getByText("Claude Opus"));

      expect(setJudgeMutate.mock.calls[0][0]).toEqual({
        selection: {
          harnessId: "claude",
          model: "opus",
          profileId: null,
          reasoningEffort: "medium",
        },
      });
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

  describe("harness catalog", () => {
    const CATALOG_ERROR =
      "Couldn't load this machine's providers. Reopen Settings to try again.";

    beforeEach(() => {
      judgeRecord.current = { selection: CLAUDE_STORED };
    });

    it("says so when the catalog query failed", () => {
      catalogState.current = "failed";
      render(<JudgeTab />);

      expect(screen.getByText(CATALOG_ERROR)).not.toBeNull();
    });

    it("stays silent while the catalog query is pending", () => {
      catalogState.current = "pending";
      render(<JudgeTab />);

      expect(screen.queryByText(CATALOG_ERROR)).toBeNull();
    });

    it("stays silent once the catalog answered", () => {
      render(<JudgeTab />);

      expect(screen.queryByText(CATALOG_ERROR)).toBeNull();
    });
  });
});
