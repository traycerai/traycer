import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ComposerToolbarLeft } from "@/components/home/toolbar/composer-toolbar-left";
import { ComposerToolbarRight } from "@/components/home/toolbar/composer-toolbar-right";
import { ComposerAttachImageButton } from "@/components/home/toolbar/composer-attach-image-button";
import { ComposerMicSlot } from "@/components/home/toolbar/composer-mic-button";
import { CustomizePopover } from "@/components/customize/customize-popover";
import { getCustomizeOptions } from "@/lib/customize/customize-options";
import { registerComposerToolbarCustomizeOptions } from "@/lib/customize/options/composer-toolbar-options";
import { undo } from "@/lib/customize/history";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import type { HotspotInstance } from "@/stores/customize/customize-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
  type ComposerToolbarOrder,
} from "@/stores/settings/layout-store";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

// The order-rendering test below only cares about POSITION, and the real
// model chip needs a `HostRuntimeProvider` this lean test doesn't set up -
// see the main `harness-model-picker.test.tsx` for its actual behaviour.
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => <div data-testid="model-chip-stub" />,
}));

registerComposerToolbarCustomizeOptions();

function startSession(): void {
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    history: { past: [], future: [] },
    announcement: "",
  });
}

function testToolbarStore() {
  return createComposerToolbarStore({
    seedKey: "composer-toolbar-customize-test",
    values: {
      permission: "supervised",
      selection: {
        harnessId: "claude",
        modelSlug: "claude-sonnet",
        profileId: null,
      },
      reasoning: "medium",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: null,
  });
}

const SHARED_ITEM_PROPS = {
  onAttachImages: () => undefined,
  permission: "supervised" as const,
  onPermissionChange: () => undefined,
  supportedPermissionModes: null,
  harnessLabel: "Claude",
  catalogSupportedModes: null,
  hostKnowsAutoMode: false,
  turnActive: false,
  judgeBilling: null,
  settingsLocked: false,
  createProfileHostId: null,
  runTargetHostId: null,
  terminalLoginSurface: null,
  dictation: null,
  dictationPreparing: null,
};

beforeEach(() => {
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  useCustomizeStore.setState({ session: null, instances: new Map() });
});
afterEach(cleanup);

describe("composer toolbar rendering order", () => {
  it("renders each cluster in the stored order, with Send always last on the right", () => {
    useLayoutStore.setState({
      composer: {
        ...DEFAULT_COMPOSER_LAYOUT,
        toolbar: {
          left: ["access", "attachImage", "harness"],
          right: ["mic", "model"],
        },
      },
    });
    const store = testToolbarStore();
    render(
      <TooltipProvider>
        <ComposerToolbarLeft {...SHARED_ITEM_PROPS} store={store} />
        <ComposerToolbarRight
          {...SHARED_ITEM_PROPS}
          store={store}
          canSubmit={false}
          attachmentPending={false}
          onSubmit={() => undefined}
          activeTurnStatus={null}
          stopDisabled={false}
          onStopTurn={null}
          composerDisabledHint={null}
        />
      </TooltipProvider>,
    );
    const ids = [
      ...document.querySelectorAll("[data-testid^='toolbar-item-']"),
    ].map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual([
      "toolbar-item-access",
      "toolbar-item-attachImage",
      "toolbar-item-harness",
      "toolbar-item-mic",
      "toolbar-item-model",
      "toolbar-item-send",
    ]);
  });
});

describe("composer.attachImage hotspot", () => {
  it("ghosts while editing when the layout preference hides it", () => {
    startSession();
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, attachImage: "hidden" },
    });
    render(
      <TooltipProvider>
        <ComposerAttachImageButton onAttachImages={() => undefined} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("composer-attach-image-ghost")).not.toBeNull();
  });

  it("renders nothing when hidden outside a session", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, attachImage: "hidden" },
    });
    const { container } = render(
      <TooltipProvider>
        <ComposerAttachImageButton onAttachImages={() => undefined} />
      </TooltipProvider>,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("composer.mic hotspot", () => {
  it("ghosts with an unsupported condition when dictation is unavailable on this host", () => {
    startSession();
    render(<ComposerMicSlot dictation={null} dictationPreparing={null} />);
    expect(screen.getByTestId("composer-mic-ghost")).not.toBeNull();
    const instance = [...useCustomizeStore.getState().instances.values()].find(
      (candidate) => candidate.settingId === "composer.mic",
    );
    expect(instance?.condition).toBe(
      "voice input is not available on this host",
    );
  });
});

describe("composer.mic option", () => {
  const instance: HotspotInstance = {
    key: "composer.mic@shell:landing",
    settingId: "composer.mic",
    sceneId: "shell",
    tileId: "landing",
    node: document.createElement("div"),
    ghost: false,
    condition: null,
  };

  // Rewritten (wave-3 fixup, B3): `composer.mic`'s `change` is now a plain
  // write with no `recordGesture` of its own - only the popover's `mutate`
  // records it. Calling `options.control.change(...)` directly (as this test
  // used to) pushes nothing onto `history.past`, so the `undo()` afterward
  // had nothing to pop; the old version only looked green because it never
  // checked history and the direct write happened to leave the right value
  // in place for its own final assertion. Drives the real popover instead.
  it("hiding then undoing restores it, through the real popover", () => {
    startSession();
    useCustomizeStore.getState().register(instance);
    useCustomizeStore.setState({ popoverKey: instance.key });
    const rects = new Map([[instance.key, new DOMRect(10, 10, 20, 20)]]);
    render(<CustomizePopover rects={rects} />);

    fireEvent.click(screen.getByRole("radio", { name: "Hidden" }));

    expect(useLayoutStore.getState().composer.mic).toBe("hidden");
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);

    act(() => undo());
    expect(useLayoutStore.getState().composer.mic).toBe("visible");
    expect(useCustomizeStore.getState().history.past).toHaveLength(0);
  });
});

describe("composer toolbar reorder", () => {
  function orderInstance(
    settingId: "composer.attachImage" | "composer.model",
  ): HotspotInstance {
    return {
      key: `${settingId}@shell:landing`,
      settingId,
      sceneId: "shell",
      tileId: "landing",
      node: document.createElement("div"),
      ghost: false,
      condition: null,
    };
  }

  beforeEach(() => {
    startSession();
    useLayoutStore.setState({
      composer: {
        ...DEFAULT_COMPOSER_LAYOUT,
        toolbar: DEFAULT_COMPOSER_LAYOUT.toolbar,
      },
    });
  });

  it("dragging attachImage onto a right-cluster item moves it there and persists", () => {
    const dragging = getCustomizeOptions(orderInstance("composer.attachImage"));
    const move = dragging?.drag?.resolveDrop("composer.mic@shell:landing");
    expect(move).not.toBeNull();
    act(() => {
      if (move !== null && move !== undefined && "run" in move) move.run();
    });
    const next: ComposerToolbarOrder =
      useLayoutStore.getState().composer.toolbar;
    expect(next.right).toContain("attachImage");
    expect(next.left).not.toContain("attachImage");
  });

  it("dragging model onto a left-cluster item is refused, leaving the order unchanged", () => {
    const dragging = getCustomizeOptions(orderInstance("composer.model"));
    const result = dragging?.drag?.resolveDrop("composer.access@shell:landing");
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect(result && "refused" in result).toBe(true);
    expect(useLayoutStore.getState().composer.toolbar).toEqual(
      DEFAULT_COMPOSER_LAYOUT.toolbar,
    );
  });

  it("model has no Move to other side - it is pinned to the right cluster", () => {
    const dragging = getCustomizeOptions(orderInstance("composer.model"));
    expect(
      dragging?.moves.some((move) => move.id === "move-to-other-side"),
    ).toBe(false);
  });

  it("attachImage's Move to other side moves it into the right cluster", () => {
    const before = getCustomizeOptions(orderInstance("composer.attachImage"));
    const moveToOtherSide = before?.moves.find(
      (move) => move.id === "move-to-other-side",
    );
    expect(moveToOtherSide?.disabled).toBe(false);
    act(() => moveToOtherSide?.run());
    expect(useLayoutStore.getState().composer.toolbar.right).toContain(
      "attachImage",
    );
  });
});
