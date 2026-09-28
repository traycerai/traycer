import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerMobileToolbar } from "@/components/home/mobile/composer-mobile-toolbar";
import type { PermissionMode } from "@/components/home/data/landing-options";
import type { ComposerDictationControl } from "@/components/home/toolbar/composer-mic-button";
import type { DictationPreparingStatus } from "@/hooks/composer/use-dictation-availability";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
}));
// The real picker pulls host/query providers; this test covers the row itself.
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => <div data-testid="mock-model-picker" />,
}));
// Same reason, one layer down: the toolbar reads this host's judge selection to
// disclose which pocket Auto mode spends, and `useHostClientForHostId` throws
// outside a `<HostRuntimeProvider>` by design. `null` is the hook's own
// host-cannot-answer value, so the sheet renders no meta line - which is what
// this row looked like before the disclosure existed.
vi.mock("@/hooks/auto-mode/use-auto-judge-billing", () => ({
  useAutoJudgeBilling: () => null,
}));
// Same reason as the billing hook above: `useOpenPermissionSettings` reads
// `useSystemTabModalActions()`, which resolves through the router - this test
// renders without one, so the hook is mocked rather than pulling in a router.
const openPermissionSettingsMock = vi.hoisted(() => vi.fn());
const useOpenPermissionSettingsMock = vi.hoisted(() =>
  vi.fn<(hostId: string | null) => () => void>(),
);
vi.mock("@/hooks/settings/use-open-permission-settings", () => ({
  useOpenPermissionSettings: (hostId: string | null) =>
    useOpenPermissionSettingsMock(hostId),
}));

afterEach(() => {
  cleanup();
  openPermissionSettingsMock.mockClear();
  useOpenPermissionSettingsMock.mockReset();
});

beforeEach(() => {
  useOpenPermissionSettingsMock.mockImplementation(
    () => openPermissionSettingsMock,
  );
});

function makeStore(modelSlug: string, permission: PermissionMode) {
  return createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "mobile-toolbar-test",
    values: {
      permission,
      selection: { harnessId: "claude", modelSlug, profileId: null },
      reasoning: "",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: null,
  });
}

function renderToolbar(
  modelSlug: string,
  onSubmit: () => void,
  voice: {
    readonly dictation: ComposerDictationControl | null;
    readonly preparing: DictationPreparingStatus | null;
    readonly permission?: PermissionMode;
  },
  runTargetHostId: string | null,
) {
  return render(
    <ComposerMobileToolbar
      store={makeStore(modelSlug, voice.permission ?? "supervised")}
      onAttachImages={vi.fn()}
      canSubmit
      attachmentPending={false}
      onSubmit={onSubmit}
      activeTurnStatus={null}
      stopDisabled
      onStopTurn={null}
      composerDisabledHint={null}
      dictation={voice.dictation}
      dictationPreparing={voice.preparing}
      settingsLocked={false}
      createProfileHostId={null}
      runTargetHostId={runTargetHostId}
      terminalLoginSurface={null}
      chatLineCarriesAutoMode={null}
    />,
  );
}

const IDLE_DICTATION_CONTROL: ComposerDictationControl = {
  state: "idle",
  onToggle: vi.fn(),
  onStop: vi.fn(),
  onCancel: vi.fn(),
  getStream: () => null,
};

const DOWNLOADING_PREPARING_STATUS: DictationPreparingStatus = {
  downloadState: "downloading",
  progress: 0.5,
};

describe("ComposerMobileToolbar", () => {
  it("keeps the desktop arrangement: attach, permission, model, send", () => {
    renderToolbar(
      "claude-opus-5",
      vi.fn(),
      { dictation: null, preparing: null },
      null,
    );
    expect(screen.getByRole("button", { name: "Attach image" })).not.toBeNull();
    expect(screen.getByTestId("mock-model-picker")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    // Only the agent-mode pill moves out of the row.
    expect(screen.queryByRole("button", { name: /Switch to Epic/ })).toBeNull();
  });

  it("renders the permission as an icon, naming it only for assistive tech", () => {
    renderToolbar(
      "claude-opus-5",
      vi.fn(),
      { dictation: null, preparing: null },
      null,
    );
    expect(
      screen.getByRole("button", { name: "Permissions: Supervised" }),
    ).not.toBeNull();
    // Visible text would truncate to "Superv..." at this width and steal room
    // the model name needs; the glyph carries it instead.
    expect(screen.queryByText("Supervised")).toBeNull();
  });

  it("names the trigger 'Auto — Experimental' when the effective permission is Auto", () => {
    renderToolbar(
      "claude-opus-5",
      vi.fn(),
      { dictation: null, preparing: null, permission: "auto" },
      null,
    );
    expect(
      screen.getByRole("button", { name: "Permissions: Auto — Experimental" }),
    ).not.toBeNull();
  });

  it("opens the options sheet from the permission pill", async () => {
    renderToolbar(
      "claude-opus-5",
      vi.fn(),
      { dictation: null, preparing: null },
      null,
    );
    expect(screen.queryByTestId("composer-options-sheet")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Permissions: Supervised" }),
    );
    expect(screen.getByTestId("composer-options-sheet")).not.toBeNull();
  });

  it("blocks send while the model slug is still empty", () => {
    const onSubmit = vi.fn();
    renderToolbar("", onSubmit, { dictation: null, preparing: null }, null);
    expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("allows send once the model slug resolves", async () => {
    const onSubmit = vi.fn();
    renderToolbar(
      "claude-opus-5",
      onSubmit,
      { dictation: null, preparing: null },
      null,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalled();
  });

  // G6: this row used to render the bare `ComposerMicButton` /
  // `ComposerMicPreparing` components directly, bypassing `ComposerMicSlot`'s
  // own `useRegionShown("mic")` read entirely. Routing through the slot is
  // what makes Layout's Microphone Shown switch reach the phone toolbar.
  describe("mic slot", () => {
    // `ComposerMicButton` / `ComposerMicPreparing` already self-gate on
    // `useRegionShown` (their own suite covers hidden-means-nothing), so a
    // shown/hidden check here would hold either way the toolbar wires them
    // in. `ComposerMicSlot` is what registers this instance with the layout
    // editor (`useLayoutRegion`, region "mic"); that registration is the
    // actual delta the bare-leaf bypass loses, so pin it for both leaves.
    it.each<{
      readonly leaf: string;
      readonly voice: {
        readonly dictation: ComposerDictationControl | null;
        readonly preparing: DictationPreparingStatus | null;
      };
      readonly name: string | RegExp;
    }>([
      {
        leaf: "mic button",
        voice: { dictation: IDLE_DICTATION_CONTROL, preparing: null },
        name: "Start voice input",
      },
      {
        leaf: "preparing indicator",
        voice: { dictation: null, preparing: DOWNLOADING_PREPARING_STATUS },
        name: /Setting up voice dictation/,
      },
    ])(
      "registers the $leaf as the layout editor's mic region",
      ({ voice, name }) => {
        renderToolbar("claude-opus-5", vi.fn(), voice, null);
        const micControl = screen.getByRole("button", { name });
        expect(micControl.closest('[data-layout-region="mic"]')).not.toBeNull();
      },
    );
  });

  it("wires the sheet's trailing row to useOpenPermissionSettings", async () => {
    renderToolbar(
      "claude-opus-5",
      vi.fn(),
      { dictation: null, preparing: null },
      null,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Permissions: Supervised" }),
    );
    await userEvent.click(
      screen.getByTestId("composer-options-permission-settings"),
    );

    expect(openPermissionSettingsMock).toHaveBeenCalledTimes(1);
  });

  it("hands useOpenPermissionSettings the toolbar's run-target host", () => {
    renderToolbar(
      "claude-opus-5",
      vi.fn(),
      { dictation: null, preparing: null },
      "host-b",
    );

    expect(useOpenPermissionSettingsMock).toHaveBeenCalledWith("host-b");
  });

  it("hands it null when no run target has resolved", () => {
    renderToolbar(
      "claude-opus-5",
      vi.fn(),
      { dictation: null, preparing: null },
      null,
    );

    expect(useOpenPermissionSettingsMock).toHaveBeenLastCalledWith(null);
  });
});
