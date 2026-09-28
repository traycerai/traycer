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
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import {
  PresetsBlock,
  ResetLayoutButton,
} from "@/components/layout-editor/inspector/presets-block";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { LAYOUT_PRESET_IDS, PRESET_LABELS } from "@/lib/layout/layout-presets";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  toast.mockClear();
  toast.dismiss.mockClear();
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("applying a preset offers an Undo (L-133 overturned)", () => {
  it("puts back the values alone, so a later arrangement change survives", () => {
    render(<PresetsBlock reveal={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Apply Compact" }));

    expect(toast).toHaveBeenCalledTimes(1);
    const [message, options] = toast.mock.calls[0] as [
      string,
      {
        readonly action: {
          readonly label: string;
          readonly onClick: () => void;
        };
      },
    ];
    expect(message).toBe("Compact applied. Placement and order kept.");
    expect(options.action.label).toBe("Undo");
    expect(useLayoutStore.getState().basePreset).toBe("compact");

    // An arrangement change made AFTER the apply, before Undo is pressed.
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...useLayoutStore.getState().arrangement,
        tabStripPlacement: "left",
      });
    });

    act(() => {
      options.action.onClick();
    });

    expect(useLayoutStore.getState().basePreset).toBe("default");
    expect(useLayoutStore.getState().overrides).toEqual({});
    // The apply never touched the arrangement, so Undo (which only restores
    // basePreset/overrides) leaves the later arrangement change in place.
    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
      "left",
    );
  });
});

function PresetsAndReset(): ReactNode {
  return (
    <>
      <PresetsBlock reveal={vi.fn()} />
      <ResetLayoutButton />
    </>
  );
}

function toastAction(): { readonly onClick: () => void } {
  const [, options] = toast.mock.calls[0] as [
    string,
    { readonly action: { readonly onClick: () => void } },
  ];
  return options.action;
}

describe("the apply toast is only good while its values are the ones it wrote (item 1)", () => {
  it.each([
    {
      change: "an editor discard",
      inSession: true,
      act: () => {
        act(() => {
          useLayoutEditorStore.getState().discard();
        });
      },
    },
    {
      change: "Reset layout",
      inSession: false,
      act: () => {
        fireEvent.click(screen.getByRole("button", { name: "Reset layout…" }));
        fireEvent.click(screen.getByTestId("confirm-action"));
      },
    },
    {
      change: "a later value edit",
      inSession: false,
      act: () => {
        act(() => {
          useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
        });
      },
    },
  ])("dismisses on $change, and a later Undo changes nothing", (testCase) => {
    if (testCase.inSession) {
      act(() => {
        useLayoutEditorStore.getState().beginSession({
          entry: "pointer",
          source: "direct_ui",
          startedAt: 0,
          origin: { kind: "tab" },
        });
      });
    }
    render(<PresetsAndReset />);
    fireEvent.click(screen.getByRole("button", { name: "Apply Compact" }));
    const action = toastAction();

    // Each row wraps its own step: Reset's two clicks must render the
    // confirm in between, which one enclosing `act` would batch away.
    testCase.act();

    expect(toast.dismiss).toHaveBeenCalledWith("layout-preset-applied");
    const before = useLayoutStore.getState();
    act(() => {
      action.onClick();
    });
    expect(useLayoutStore.getState()).toBe(before);
  });
});

describe("Reset layout's confirm, in both hosts (L-20, P-6)", () => {
  it.each(["page", "inspector"] as const)(
    "opens 'Reset layout?', Cancel leaves the layout, and Reset layout resets it (%s)",
    (host) => {
      act(() => {
        useLayoutStore.getState().setArrangement({
          ...DEFAULT_ARRANGEMENT,
          tabStripPlacement: "left",
        });
      });
      render(
        <LayoutFormHostContext value={host}>
          <ResetLayoutButton />
        </LayoutFormHostContext>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Reset layout…" }));
      expect(screen.getByRole("dialog")).not.toBeNull();
      expect(screen.getByText("Reset layout?")).not.toBeNull();
      // The one thing the hosts differ by: the editor can undo it.
      expect(
        screen
          .getByRole("dialog")
          .textContent.includes("In the editor you can undo this with"),
      ).toBe(host === "inspector");

      fireEvent.click(screen.getByTestId("confirm-cancel"));
      expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
        "left",
      );
      expect(screen.queryByRole("dialog")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Reset layout…" }));
      fireEvent.click(screen.getByTestId("confirm-action"));

      expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
        DEFAULT_ARRANGEMENT.tabStripPlacement,
      );
    },
  );
});

describe("Reset layout… tracks resetWouldChange, not just the visible dot (item 6)", () => {
  it("stays disabled for a dividerSeq-only difference, and enables for a stored-choice-only one", () => {
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        dividerSeq: DEFAULT_ARRANGEMENT.dividerSeq + 3,
      });
    });
    render(<ResetLayoutButton />);
    expect(
      screen
        .getByRole("button", { name: "Reset layout…" })
        .hasAttribute("disabled"),
    ).toBe(true);

    act(() => {
      useLayoutStore.getState().setArrangement({
        ...useLayoutStore.getState().arrangement,
        shownProfiles: {
          "host-1": { [DEFAULT_ARRANGEMENT.usageProviders[0]]: ["profile-1"] },
        },
      });
    });
    expect(
      screen
        .getByRole("button", { name: "Reset layout…" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});

describe("View changes (L-89 overturned: no separate level)", () => {
  it("shows a line per change with its own revert, which puts that one back", () => {
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "left",
      });
    });
    render(<PresetsBlock reveal={vi.fn()} />);

    expect(screen.getByTestId("preset-status-line").textContent).toBe(
      "Default · Modified",
    );
    // The applied card carries the same label; the others do not.
    const applied = screen.getByRole("button", { name: "Apply Default" });
    expect(within(applied).getByTestId("preset-card-modified")).not.toBeNull();
    expect(screen.getAllByTestId("preset-card-modified")).toHaveLength(1);
    const toggle = screen.getByRole("button", { name: "View changes" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(
      screen
        .getByRole("button", { name: "Hide changes" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    const list = screen.getByTestId("layout-change-list");
    expect(list.textContent).toContain("Tab placement");

    fireEvent.click(
      screen.getByRole("button", { name: "Revert Tab placement" }),
    );

    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
      DEFAULT_ARRANGEMENT.tabStripPlacement,
    );
  });
});

describe("View changes' revert keeps focus in the list, or moves it to the applied card when the list empties", () => {
  function openViewChanges(): void {
    render(<PresetsBlock reveal={vi.fn()} />);
    // Whether the list is open is app-wide state that outlives one render,
    // so an earlier test may have left it open.
    const toggle = screen.queryByRole("button", { name: "View changes" });
    if (toggle !== null) fireEvent.click(toggle);
    screen.getByRole("button", { name: "Hide changes" });
  }

  function changeLineKeys(): ReadonlyArray<string> {
    return [
      ...screen
        .getByTestId("layout-change-list")
        .querySelectorAll("[data-change-line]"),
    ].flatMap((node) => {
      const key = node.getAttribute("data-change-line");
      return key === null ? [] : [key];
    });
  }

  it("reverting the first of three lines focuses the new first line - the old second line's ↺", () => {
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "left",
        sidebarSide: "right",
        minimapSide: "left",
      });
    });
    openViewChanges();
    expect(changeLineKeys()).toEqual([
      "tabStripPlacement",
      "sidebarSide",
      "minimapSide",
    ]);

    const revertTabPlacement = screen.getByRole("button", {
      name: "Revert Tab placement",
    });
    revertTabPlacement.focus();
    fireEvent.click(revertTabPlacement);

    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe("top");
    const revertSidebarSide = screen.getByRole("button", {
      name: "Revert Sidebar side",
    });
    expect(document.activeElement).toBe(revertSidebarSide);
    expect(document.activeElement).not.toBe(document.body);
    expect(changeLineKeys()).toEqual(["sidebarSide", "minimapSide"]);
  });

  it("reverting the last of two lines focuses the remaining line's ↺", () => {
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "left",
        sidebarSide: "right",
      });
    });
    openViewChanges();
    expect(changeLineKeys()).toEqual(["tabStripPlacement", "sidebarSide"]);

    const revertSidebarSide = screen.getByRole("button", {
      name: "Revert Sidebar side",
    });
    revertSidebarSide.focus();
    fireEvent.click(revertSidebarSide);

    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("left");
    const revertTabPlacement = screen.getByRole("button", {
      name: "Revert Tab placement",
    });
    expect(document.activeElement).toBe(revertTabPlacement);
    expect(document.activeElement).not.toBe(document.body);
    expect(changeLineKeys()).toEqual(["tabStripPlacement"]);
  });

  it("reverting the only line empties the list, unmounts View changes, and focuses the applied preset's card", () => {
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "left",
      });
    });
    openViewChanges();
    expect(changeLineKeys()).toEqual(["tabStripPlacement"]);

    const revertTabPlacement = screen.getByRole("button", {
      name: "Revert Tab placement",
    });
    revertTabPlacement.focus();
    fireEvent.click(revertTabPlacement);

    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe("top");
    expect(screen.queryByTestId("layout-change-list")).toBeNull();
    expect(screen.queryByRole("button", { name: "View changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide changes" })).toBeNull();
    const appliedCard = screen.getByRole("button", { name: "Apply Default" });
    expect(document.activeElement).toBe(appliedCard);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("reverting the last Styles line focuses the first Arrangement line's ↺", () => {
    act(() => {
      useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "left",
      });
    });
    openViewChanges();
    expect(changeLineKeys()).toEqual(["mic.display", "tabStripPlacement"]);

    const revertMicrophone = screen.getByRole("button", {
      name: "Revert Microphone",
    });
    revertMicrophone.focus();
    fireEvent.click(revertMicrophone);

    expect(useLayoutStore.getState().overrides.mic).toBeUndefined();
    const revertTabPlacement = screen.getByRole("button", {
      name: "Revert Tab placement",
    });
    expect(document.activeElement).toBe(revertTabPlacement);
    expect(document.activeElement).not.toBe(document.body);
    expect(changeLineKeys()).toEqual(["tabStripPlacement"]);
  });
});

describe("the presets grid: three cards in one row, in both hosts (R2-B)", () => {
  it.each(["page", "inspector"] as const)(
    "renders Default, Compact and Detailed in a single grid-cols-3 row (%s)",
    (host) => {
      render(
        <LayoutFormHostContext value={host}>
          <PresetsBlock reveal={vi.fn()} />
        </LayoutFormHostContext>,
      );

      const grid = screen
        .getByTestId("layout-presets-block")
        .querySelector(".grid-cols-3");
      expect(grid).not.toBeNull();
      expect(grid?.children).toHaveLength(3);

      for (const presetId of LAYOUT_PRESET_IDS) {
        expect(
          screen.getByRole("button", {
            name: `Apply ${PRESET_LABELS[presetId]}`,
          }),
        ).not.toBeNull();
      }
    },
  );
});

describe("a preset card: one inert miniature, then the name and its aria-describedby caption (R2-B)", () => {
  it("every card holds exactly that, in that order", () => {
    render(<PresetsBlock reveal={vi.fn()} />);

    for (const presetId of LAYOUT_PRESET_IDS) {
      const name = PRESET_LABELS[presetId];
      const card = screen.getByRole("button", { name: `Apply ${name}` });

      const miniatures = within(card).getAllByTestId("preset-miniature");
      expect(miniatures).toHaveLength(1);
      expect(miniatures[0].hasAttribute("inert")).toBe(true);
      expect(card.children[0]).toBe(miniatures[0]);

      expect(within(card).getByText(name)).not.toBeNull();

      const captionId = card.getAttribute("aria-describedby");
      expect(captionId).not.toBeNull();
      const caption = document.getElementById(captionId ?? "");
      expect(caption).not.toBeNull();
      expect(card.contains(caption)).toBe(true);
      expect(caption?.textContent).not.toBe("");
    }
  });
});

describe("selected state: aria-current and the check mark on exactly the applied card (R2-B)", () => {
  it("marks only the basePreset's card, and no 'Last applied'/standalone 'Apply' text remains", () => {
    render(<PresetsBlock reveal={vi.fn()} />);

    for (const presetId of LAYOUT_PRESET_IDS) {
      const card = screen.getByRole("button", {
        name: `Apply ${PRESET_LABELS[presetId]}`,
      });
      const selected = presetId === useLayoutStore.getState().basePreset;
      expect(card.getAttribute("aria-current")).toBe(selected ? "true" : null);
      if (selected) {
        expect(within(card).getByTestId("preset-applied-check")).not.toBeNull();
      } else {
        expect(within(card).queryByTestId("preset-applied-check")).toBeNull();
      }
    }

    expect(screen.queryByText("Last applied")).toBeNull();
    expect(screen.queryByText("Apply", { exact: true })).toBeNull();
  });

  it("moves aria-current and the check to the newly applied card", () => {
    render(<PresetsBlock reveal={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply Compact" }));

    const compactCard = screen.getByRole("button", { name: "Apply Compact" });
    const defaultCard = screen.getByRole("button", { name: "Apply Default" });
    expect(compactCard.getAttribute("aria-current")).toBe("true");
    expect(
      within(compactCard).getByTestId("preset-applied-check"),
    ).not.toBeNull();
    expect(defaultCard.getAttribute("aria-current")).toBeNull();
    expect(
      within(defaultCard).queryByTestId("preset-applied-check"),
    ).toBeNull();
  });
});

describe("keyboard applies a preset exactly like a click, as one undo step (R2-B)", () => {
  it.each(["Enter", " "] as const)(
    "key %s applies the preset, replaces density, and offers Undo/View changes",
    (key) => {
      act(() => {
        useLayoutEditorStore.getState().beginSession({
          entry: "keyboard",
          source: "direct_ui",
          startedAt: 0,
          origin: { kind: "tab" },
        });
      });
      render(<PresetsBlock reveal={vi.fn()} />);

      fireEvent.keyDown(screen.getByRole("button", { name: "Apply Compact" }), {
        key,
      });

      expect(useLayoutStore.getState().basePreset).toBe("compact");
      expect(useLayoutStore.getState().overrides).toEqual({});
      // One gesture on the editor's own stack, not one push per key + click.
      expect(useLayoutEditorStore.getState().history.past).toHaveLength(1);

      expect(toast).toHaveBeenCalledTimes(1);
      const [message, options] = toast.mock.calls[0] as [
        string,
        {
          readonly action: { readonly label: string };
          readonly cancel: { readonly label: string };
        },
      ];
      expect(message).toBe("Compact applied. Placement and order kept.");
      expect(options.action.label).toBe("Undo");
      expect(options.cancel.label).toBe("View changes");
    },
  );

  it("ignores every other key", () => {
    render(<PresetsBlock reveal={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Apply Compact" }), {
      key: "Tab",
    });
    expect(useLayoutStore.getState().basePreset).toBe("default");
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("a preset's miniature draws that PRESET's density, not the current one (R2-B)", () => {
  it("Compact's miniature folds the dock to chips while Default's still shows full rows", () => {
    render(<PresetsBlock reveal={vi.fn()} />);

    const defaultMiniature = within(
      screen.getByRole("button", { name: "Apply Default" }),
    ).getByTestId("preset-miniature");
    const compactMiniature = within(
      screen.getByRole("button", { name: "Apply Compact" }),
    ).getByTestId("preset-miniature");

    expect(
      within(defaultMiniature).queryByTestId("app-frame-dock-chips"),
    ).toBeNull();
    expect(
      within(compactMiniature).getByTestId("app-frame-dock-chips"),
    ).not.toBeNull();
  });
});
