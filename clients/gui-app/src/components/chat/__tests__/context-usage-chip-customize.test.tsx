import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import { CustomizePopover } from "@/components/customize/customize-popover";
import { getCustomizeOptions } from "@/lib/customize/customize-options";
import { registerChatSurfacesCustomizeOptions } from "@/lib/customize/options/chat-surfaces-options";
import { undo } from "@/lib/customize/history";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import type { HotspotInstance } from "@/stores/customize/customize-store";
import {
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";

/** Ticket w3-chat-surfaces: the context chip's `chat.context` composite. */

registerChatSurfacesCustomizeOptions();

const RELIABLE_USAGE: TokenUsage = {
  inputTokens: 50_000,
  outputTokens: 1_000,
  totalTokens: 51_000,
  contextTokens: 50_000,
  contextWindow: 200_000,
};

function chipInstance(): HotspotInstance {
  return {
    key: "chat.context@shell:chat-1",
    settingId: "chat.context",
    sceneId: "shell",
    tileId: "landing",
    node: document.createElement("div"),
    ghost: false,
    condition: null,
  };
}

function resetStores(): void {
  useSettingsStore.setState({
    pinContextUsageBreakdown: false,
    pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    pinnedContextBreakdownOrder: DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
  });
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    disclosure: null,
    pendingTarget: null,
    preferredTileId: null,
    history: { past: [], future: [] },
  });
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  act(() => {
    useCustomizeStore.setState({ session: null });
  });
  resetStores();
});

describe("chat.context ghost", () => {
  it("ghosts with 'no usage reported yet' while editing and no usage has arrived", () => {
    render(<ContextUsageChip usage={null} onCompact={null} />);
    expect(screen.getByTestId("context-usage-chip-ghost")).not.toBeNull();
    const instance = [...useCustomizeStore.getState().instances.values()].find(
      (candidate) => candidate.settingId === "chat.context",
    );
    expect(instance?.condition).toBe("no usage reported yet");
  });

  it("renders nothing when there is no usage outside a session", () => {
    act(() => {
      useCustomizeStore.setState({ session: null });
    });
    const { container } = render(
      <ContextUsageChip usage={null} onCompact={null} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("chat.context option", () => {
  it("the fields 'More' list is in pinnedContextBreakdownOrder", () => {
    const options = getCustomizeOptions(chipInstance());
    const fields =
      options?.control?.kind === "composite"
        ? options.control.more.find(
            (control) => control.id === "chat.context.fields",
          )
        : null;
    expect(
      fields?.kind === "multi" ? fields.options.map((o) => o.value) : null,
    ).toEqual(DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER);
  });

  it("moving Output to the top reorders the pinned strip", () => {
    render(<ContextUsageChip usage={RELIABLE_USAGE} onCompact={null} />);
    act(() => useSettingsStore.getState().setPinContextUsageBreakdown(true));

    let options = getCustomizeOptions(chipInstance());
    let fields =
      options?.control?.kind === "composite"
        ? options.control.more.find((c) => c.id === "chat.context.fields")
        : null;
    expect(fields?.kind).toBe("multi");
    act(() => {
      if (fields?.kind === "multi" && fields.moveItem !== null) {
        for (let i = 0; i < 4; i += 1) fields.moveItem("output", -1);
      }
    });
    expect(useSettingsStore.getState().pinnedContextBreakdownOrder[0]).toBe(
      "output",
    );

    // Re-fetch: the factory reads live store state, so the popover's own
    // options list (and thus the strip's draw order) reflects the move.
    options = getCustomizeOptions(chipInstance());
    fields =
      options?.control?.kind === "composite"
        ? options.control.more.find((c) => c.id === "chat.context.fields")
        : null;
    expect(fields?.kind === "multi" ? fields.options[0]?.value : null).toBe(
      "output",
    );
  });

  it("undoing a field reorder restores the previous order", () => {
    const options = getCustomizeOptions(chipInstance());
    const fields =
      options?.control?.kind === "composite"
        ? options.control.more.find((c) => c.id === "chat.context.fields")
        : null;
    expect(fields?.kind).toBe("multi");
    act(() => {
      if (fields?.kind === "multi" && fields.moveItem !== null) {
        fields.moveItem("fresh", -1);
      }
    });
    expect(useSettingsStore.getState().pinnedContextBreakdownOrder).toEqual([
      "fresh",
      "used",
      "cacheRead",
      "cacheWrite",
      "output",
    ]);

    act(() => undo());
    expect(useSettingsStore.getState().pinnedContextBreakdownOrder).toEqual(
      DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
    );
  });

  it("unchecking the last pinned field is held: its checkbox is disabled, not removable", () => {
    act(() => {
      useSettingsStore.getState().setPinnedContextBreakdownFields(["used"]);
    });
    const instance = chipInstance();
    useCustomizeStore.getState().register(instance);
    useCustomizeStore.setState({ popoverKey: instance.key });
    const rects = new Map([[instance.key, new DOMRect(10, 10, 20, 20)]]);

    render(<CustomizePopover rects={rects} />);

    fireEvent.click(screen.getByRole("button", { name: /More/i }));
    const lastCheckbox = screen.getByRole("checkbox", { name: /Used/i });
    expect(lastCheckbox.hasAttribute("disabled")).toBe(true);
  });

  it("hiding the compact button writes the layout store and undo restores it", () => {
    const options = getCustomizeOptions(chipInstance());
    const compactButton =
      options?.control?.kind === "composite"
        ? options.control.more.find(
            (c) => c.id === "chat.context.compactButton",
          )
        : null;
    expect(compactButton?.kind).toBe("choice");
    act(() => {
      if (compactButton?.kind === "choice") compactButton.change("hidden");
    });
    expect(useLayoutStore.getState().composer.compactButton).toBe("hidden");

    act(() => undo());
    expect(useLayoutStore.getState().composer.compactButton).toBe("visible");
  });
});
