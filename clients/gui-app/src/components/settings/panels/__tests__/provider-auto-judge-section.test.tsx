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

vi.mock("@/hooks/providers/use-providers-set-auto-judge-mutation", () => ({
  useProvidersSetAutoJudge: () => setAutoJudgeMock,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  guiHarnessesQueryMock.data = undefined;
  setAutoJudgeMock.isPending = false;
});

function harnessRow(
  overrides: Partial<GuiHarnessOption> = {},
): GuiHarnessOption {
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

function providerState(
  overrides: Partial<ProviderCliState> = {},
): ProviderCliState {
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
      <ProviderAutoJudgeSection state={providerState()} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the harness row reports nativeAutoJudge: false", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: false })],
    };

    const { container } = render(
      <ProviderAutoJudgeSection state={providerState()} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders the row when nativeAutoJudge is true", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(<ProviderAutoJudgeSection state={providerState()} />);

    expect(screen.getByText("Auto mode judge")).toBeTruthy();
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
});
