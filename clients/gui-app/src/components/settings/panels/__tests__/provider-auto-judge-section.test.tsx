import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import { guiHarnessOptionSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import { ProviderAutoJudgeSection } from "@/components/settings/panels/provider-auto-judge-section";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

const CLAUDE_HARNESS_ID = providerIdToGuiHarnessId("claude-code");

const guiHarnessesQueryMock = vi.hoisted(() => ({
  data: undefined as { harnesses: GuiHarnessOption[] } | undefined,
}));
// Typed so the call records below are a typed tuple rather than `any`: the
// `no-unsafe-*` rules are on in tests too, and reading `.onError` off an
// untyped mock call is exactly what they refuse.
type SetAutoJudgeVariables = {
  readonly harnessId: string;
  readonly autoJudge: string;
};
type SetAutoJudgeCallbacks = { readonly onError: () => void };
const setAutoJudgeMutateMock = vi.hoisted(() =>
  vi.fn<
    (variables: SetAutoJudgeVariables, callbacks: SetAutoJudgeCallbacks) => void
  >(),
);
const setAutoJudgeMock = vi.hoisted(() => ({
  mutate: setAutoJudgeMutateMock,
  isPending: false,
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () =>
    guiHarnessesQueryMock.data === undefined
      ? { data: undefined }
      : { data: guiHarnessesQueryMock.data },
}));

// The echo now also expires on the authoritative read COMPLETING, not only on
// the stored value changing - so the section observes `providers.list`'s
// `dataUpdatedAt` as a fetch counter. Held constant here: every case below is
// "the refetch has not landed yet", which is the window the echo exists for.
// A test that wants the echo retired advances this instead of changing the
// value, which is exactly the case value-only expiry could not reach.
const providersUpdatedAt = vi.hoisted(() => ({ current: 1_000 }));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ dataUpdatedAt: providersUpdatedAt.current }),
}));

vi.mock("@/hooks/providers/use-providers-set-auto-judge-mutation", () => ({
  useProvidersSetAutoJudge: () => setAutoJudgeMock,
}));

afterEach(() => {
  cleanup();
  providersUpdatedAt.current = 1_000;
  vi.clearAllMocks();
  guiHarnessesQueryMock.data = undefined;
  setAutoJudgeMock.isPending = false;
});

function harnessRow(overrides: Partial<GuiHarnessOption>): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id: CLAUDE_HARNESS_ID,
    label: "Claude Code",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    nativeAutoJudge: false,
    ...overrides,
  });
}

function providerState(overrides: Partial<ProviderCliState>): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    // `selected` is a discriminated union with no null member - which binary
    // this provider runs is always one of the three. Nothing in this section
    // reads it; it is here because `ProviderCliState` requires it.
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
    ...overrides,
  };
}

describe("<ProviderAutoJudgeSection />", () => {
  it("renders nothing when the catalog has not loaded", () => {
    guiHarnessesQueryMock.data = undefined;

    const { container } = render(
      <ProviderAutoJudgeSection state={providerState({})} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders a read-only Traycer's judge line, and no select, when the harness row reports nativeAutoJudge: false", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: false })],
    };

    render(<ProviderAutoJudgeSection state={providerState({})} />);

    // The tab is drawn for every provider, so "nothing to choose" is still
    // an answer: the question the tab is named for, and where the judge that
    // answers it is chosen. No switch with one option.
    const readonly = screen.getByTestId("provider-auto-judge-readonly");
    expect(readonly.textContent).toContain(
      "Who reviews Claude Code's commands",
    );
    expect(readonly.textContent).toContain("Traycer's judge");
    expect(readonly.textContent).toContain("Settings ▸ Permissions");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("renders the row when nativeAutoJudge is true", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(<ProviderAutoJudgeSection state={providerState({})} />);

    // Spelled out rather than built from `PROVIDER_DISPLAY_NAMES`: this is the
    // label a user reads, and the row is deliberately NOT called "Auto mode
    // judge" any more - the row under Settings ▸ Permissions carries that name and
    // THIS is the one that wins. An assertion derived from the same constant
    // the component interpolates would follow a rename instead of catching it.
    expect(screen.getByText("Who reviews Claude Code's commands")).toBeTruthy();
  });

  it("renders Traycer's judge selected when the stored state has no autoJudge key", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    expect(screen.getByRole("combobox").textContent).toMatch("Traycer's judge");
  });

  it("renders the provider's classifier selected when the stored state carries autoJudge: 'provider'", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: "provider" })}
      />,
    );

    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );
  });

  it("sends providers.setAutoJudge with {harnessId, autoJudge: 'provider'} and keeps showing the choice as a local echo", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", { name: "Claude Code's classifier" }),
    );

    // Two arguments now: the variables, plus a per-call `onError` the row uses
    // to retire its echo when the write is refused. The callback's identity is
    // not the contract, so only its presence is asserted.
    expect(setAutoJudgeMutateMock.mock.calls.length).toBe(1);
    const [variables, callbacks] = setAutoJudgeMutateMock.mock.calls[0];
    expect(variables).toEqual({
      harnessId: CLAUDE_HARNESS_ID,
      autoJudge: "provider",
    });
    expect(typeof callbacks.onError).toBe("function");
    // The echo, not a `providers.list` re-read: the fixture still says nothing
    // was ever stored, yet the control keeps showing what was just picked.
    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );
  });

  it("retires the echo when the write is refused, so the control stops showing a choice that never took", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", { name: "Claude Code's classifier" }),
    );
    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );

    // The host refused it. `useHostScopedMutation` toasts; the row's own
    // `onError` is what puts the control back in agreement with what is
    // actually stored.
    expect(setAutoJudgeMutateMock.mock.calls.length).toBe(1);
    act(() => {
      setAutoJudgeMutateMock.mock.calls[0][1].onError();
    });

    expect(screen.getByRole("combobox").textContent).toMatch("Traycer's judge");
  });

  it("disables the Select trigger while setAutoJudge is pending, so a click cannot change the value", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };
    setAutoJudgeMock.isPending = true;

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger.getAttribute("data-disabled")).toBe("");
    expect(trigger.hasAttribute("disabled")).toBe(true);

    // Radix refuses to open a disabled trigger, so a click cannot reach an
    // option at all - the value must stay exactly where it started.
    fireEvent.click(trigger);
    expect(screen.queryByRole("option")).toBeNull();
    expect(trigger.textContent).toMatch("Traycer's judge");
    expect(setAutoJudgeMutateMock).not.toHaveBeenCalled();
  });

  // Control for the case above: without it, a Select that is ALWAYS disabled
  // (a typo, a stuck default) would pass the pending assertion for the wrong
  // reason.
  it("control: leaves the Select trigger enabled when setAutoJudge is not pending", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };
    setAutoJudgeMock.isPending = false;

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(trigger.getAttribute("data-disabled")).toBeNull();
  });

  it("clears the echo without flicker once the stored value agrees with it", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    const { rerender } = render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", { name: "Claude Code's classifier" }),
    );
    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );

    // The host's `providers.list` echo lands: the stored value now agrees
    // with what the user picked, and the control must keep showing it (no
    // reversion to Traycer's judge in between).
    rerender(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: "provider" })}
      />,
    );

    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );
  });

  // JOB 3: the masking case `seenAt` exists to close. Another window sets the
  // provider back to the exact value this echo was made AGAINST before our own
  // invalidated refetch lands - `stored` equals `echo.against` again, so a
  // value-only expiry would keep showing the stale echo forever. A completed
  // `providers.list` fetch (whether or not the value moved) is what must
  // retire it instead, and `dataUpdatedAt` advancing is that fetch's signal.
  it("expires the echo once providers.list refetches, even when the stored value round-trips back to what the echo was made against", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    const { rerender } = render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    // Pick "provider" - echo.against captures the stored value at pick time,
    // "undefined" (Traycer).
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", { name: "Claude Code's classifier" }),
    );
    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );

    // A refetch lands - `dataUpdatedAt` advances - and the SAME `stored` as
    // before the pick comes back (another window set it back to Traycer,
    // matching `echo.against` again). Value-only expiry cannot see this: it
    // would still read as "the echo's target still matches stored" and keep
    // masking the host's real answer.
    providersUpdatedAt.current = 2_000;
    rerender(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    expect(screen.getByRole("combobox").textContent).toMatch("Traycer's judge");
  });

  // CONTROL for the case above: without advancing `dataUpdatedAt`, the echo
  // still shows - that is the ordinary round-trip window it exists for, and
  // this is what proves the expiry above is keyed on the refetch landing,
  // not on time or a rerender alone.
  it("control: keeps showing the echo across a rerender when providers.list has not refetched", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    const { rerender } = render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", { name: "Claude Code's classifier" }),
    );

    // Same `providersUpdatedAt.current` (1_000, unchanged) and the same
    // `stored` as before the pick - the ordinary in-flight window.
    rerender(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );
  });
});
