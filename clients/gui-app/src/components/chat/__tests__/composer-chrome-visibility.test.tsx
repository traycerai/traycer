import {
  act,
  cleanup,
  fireEvent,
  render as testingRender,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domAnimation, LazyMotion } from "motion/react";
import type { ReactElement } from "react";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";
import { ComposerAttachImageButton } from "@/components/home/toolbar/composer-attach-image-button";
import {
  ComposerMicButton,
  ComposerMicPreparing,
  type ComposerDictationControl,
} from "@/components/home/toolbar/composer-mic-button";
import { PermissionsPicker } from "@/components/home/pickers/permissions-picker";
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDictationHotkey } from "@/hooks/composer/use-dictation-hotkey";
import type { DictationPreparingStatus } from "@/hooks/composer/use-dictation-availability";
import type { VoiceDictationState } from "@/hooks/composer/use-voice-dictation";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

const RELIABLE_USAGE: TokenUsage = {
  inputTokens: 50_000,
  outputTokens: 1_000,
  totalTokens: 51_000,
  contextTokens: 50_000,
  contextWindow: 200_000,
};

function render(ui: ReactElement) {
  return testingRender(
    <TooltipProvider delayDuration={0}>
      <LazyMotion features={domAnimation}>{ui}</LazyMotion>
    </TooltipProvider>,
  );
}

function resetComposerLayout(): void {
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
}

function resetContextUsageSettings(): void {
  window.localStorage.clear();
  useSettingsStore.setState({ pinContextUsageBreakdown: false });
}

beforeEach(() => {
  resetComposerLayout();
  resetContextUsageSettings();
});

afterEach(() => {
  cleanup();
  resetComposerLayout();
  resetContextUsageSettings();
});

// ── Attach image ─────────────────────────────────────────────────────────────

describe("ComposerAttachImageButton follows Layout ▸ Composer 'Attach image'", () => {
  it("renders the button and still attaches a picked file when visible", () => {
    const onAttachImages = vi.fn<(files: ReadonlyArray<File>) => void>();
    const { container } = render(
      <ComposerAttachImageButton onAttachImages={onAttachImages} />,
    );

    expect(screen.getByRole("button", { name: "Attach image" })).not.toBeNull();

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("expected the hidden file input");
    const file = new File(["image-bytes"], "screenshot.png", {
      type: "image/png",
    });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onAttachImages).toHaveBeenCalledWith([file]);
  });

  // Hidden removes only the toolbar affordance. Paste and drag-drop call
  // `onAttachImages` directly from the composer's own handlers, never through
  // this component - so once the button is gone there is nothing left here to
  // gate on the setting, and the honest assertion is that the callback this
  // component owns is never invoked through a path it no longer renders.
  it("removes the button and its hidden input when hidden, leaving the attach callback untouched", () => {
    const onAttachImages = vi.fn<(files: ReadonlyArray<File>) => void>();
    useLayoutStore.getState().setComposerAttachImage("hidden");
    const { container } = render(
      <ComposerAttachImageButton onAttachImages={onAttachImages} />,
    );

    expect(container.firstChild).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(onAttachImages).not.toHaveBeenCalled();
  });
});

// ── Microphone ───────────────────────────────────────────────────────────────

function dictationControl(
  state: VoiceDictationState,
): ComposerDictationControl {
  return {
    state,
    onToggle: vi.fn(),
    onStop: vi.fn(),
    onCancel: vi.fn(),
    getStream: () => null,
  };
}

describe("ComposerMicButton follows Layout ▸ Composer 'Microphone'", () => {
  it("renders when mic is visible", () => {
    render(<ComposerMicButton control={dictationControl("idle")} />);

    expect(
      screen.getByRole("button", { name: "Start voice input" }),
    ).not.toBeNull();
  });

  it("renders nothing when mic is hidden", () => {
    useLayoutStore.getState().setComposerMic("hidden");
    const { container } = render(
      <ComposerMicButton control={dictationControl("idle")} />,
    );

    expect(container.firstChild).toBeNull();
  });
});

describe("ComposerMicPreparing follows Layout ▸ Composer 'Microphone'", () => {
  const status: DictationPreparingStatus = {
    downloadState: "downloading",
    progress: 0.4,
  };

  it("renders the placeholder when mic is visible", () => {
    render(<ComposerMicPreparing status={status} />);

    expect(screen.getByRole("button")).not.toBeNull();
  });

  it("renders nothing when mic is hidden - it holds the mic's slot, not its own", () => {
    useLayoutStore.getState().setComposerMic("hidden");
    const { container } = render(<ComposerMicPreparing status={status} />);

    expect(container.firstChild).toBeNull();
  });
});

describe("Dictation hotkey stays wired when Layout ▸ Composer hides the mic button", () => {
  // `useDictationHotkey` never reads the layout store - the button is a pure
  // view and the shortcut is a composer-level concern with its own route, per
  // the setting's own description ("this does not turn voice input off").
  // Driving the real module-level hotkey singleton with `composer.mic` set to
  // "hidden" is the honest way to pin that boundary, rather than asserting a
  // negative about a store the hook never touches.
  it("still starts dictation on the bound chord (Control+Shift+M) with mic hidden", () => {
    useLayoutStore.getState().setComposerMic("hidden");
    const start = vi.fn();
    const stop = vi.fn();
    const cancel = vi.fn();

    const { unmount } = renderHook(() =>
      useDictationHotkey({
        enabled: true,
        state: "idle",
        start,
        stop,
        cancel,
      }),
    );

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "KeyM",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    });

    expect(start).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keyup", { code: "KeyM", bubbles: true }),
      );
    });

    unmount();
  });
});

// ── Access (permission mode) ────────────────────────────────────────────────

function renderPermissionsPicker() {
  return render(
    <PermissionsPicker
      value="full_access"
      disabled={false}
      onChange={vi.fn()}
      supportedPermissionModes={null}
      harnessLabel={null}
    />,
  );
}

describe("PermissionsPicker follows Layout ▸ Composer 'Access'", () => {
  it("shows the label and chevron when access is visible", () => {
    renderPermissionsPicker();

    const button = screen.getByRole("button", { name: "Full access" });
    const label = within(button).getByText("Full access");
    const chevron = button.querySelectorAll("svg")[1];

    expect(label.className.split(/\s+/)).not.toContain("hidden");
    expect(chevron.getAttribute("class")?.split(/\s+/)).not.toContain("hidden");
  });

  it("hides the label and chevron but keeps the accessible name when access is compact", () => {
    useLayoutStore.getState().setComposerAccess("compact");
    renderPermissionsPicker();

    const button = screen.getByRole("button", { name: "Full access" });
    const label = within(button).getByText("Full access");
    const chevron = button.querySelectorAll("svg")[1];

    expect(label.className.split(/\s+/)).toContain("hidden");
    expect(chevron.getAttribute("class")?.split(/\s+/)).toContain("hidden");
  });
});

// ── Compact conversation (context usage chip) ───────────────────────────────

describe("Context usage compact action follows Layout ▸ Composer 'Compact conversation'", () => {
  it("shows the inline compact action when compactButton is visible", () => {
    render(<ContextUsageChip usage={RELIABLE_USAGE} onCompact={vi.fn()} />);

    expect(screen.getByTestId("context-usage-compact-action")).not.toBeNull();
  });

  it("hides the inline compact action when compactButton is hidden", () => {
    useLayoutStore.getState().setComposerCompactButton("hidden");
    render(<ContextUsageChip usage={RELIABLE_USAGE} onCompact={vi.fn()} />);

    expect(screen.queryByTestId("context-usage-compact-action")).toBeNull();
  });

  it("shows the pinned-strip compact action when compactButton is visible", () => {
    useSettingsStore.getState().setPinContextUsageBreakdown(true);
    render(<ContextUsageChip usage={RELIABLE_USAGE} onCompact={vi.fn()} />);

    const strip = screen.getByTestId("context-usage-pinned-strip");
    expect(
      within(strip).getByTestId("context-usage-compact-action"),
    ).not.toBeNull();
  });

  it("hides the pinned-strip compact action when compactButton is hidden", () => {
    useSettingsStore.getState().setPinContextUsageBreakdown(true);
    useLayoutStore.getState().setComposerCompactButton("hidden");
    render(<ContextUsageChip usage={RELIABLE_USAGE} onCompact={vi.fn()} />);

    const strip = screen.getByTestId("context-usage-pinned-strip");
    expect(
      within(strip).queryByTestId("context-usage-compact-action"),
    ).toBeNull();
  });
});
