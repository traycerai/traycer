import { useState } from "react";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

/**
 * Direct unit coverage for the app-owned `<Command>` (D04): navigation,
 * scoring, highlight ownership and DOM ordering. Palette-level behavior
 * (open/close, dispatch, tree scoping) stays in
 * `command-palette/__tests__/`; this file is the primitive's own contract.
 */

afterEach(cleanup);

function labelledItems(
  labels: ReadonlyArray<{
    readonly label: string;
    readonly disabled?: boolean;
  }>,
) {
  return labels.map(({ label, disabled }) => (
    <CommandItem key={label} itemKey={label} disabled={disabled === true}>
      {label}
    </CommandItem>
  ));
}

function getInput(): HTMLElement {
  return screen.getByRole("combobox");
}

function selectedRowText(): string | null {
  const row = document.querySelector('[data-selected="true"]');
  return row?.textContent ?? null;
}

// `timeStamp` isn't a real `EventInit` field, so `fireEvent(el, {timeStamp})`
// silently drops it - the native event constructor ignores unknown init
// keys. Override the (configurable) property on the built event directly so
// the 50ms IME grace-window arithmetic is deterministic instead of racing a
// real wall-clock wait against however long the test happens to take.
function fireAtTime(
  target: Document | Element | Node | Window,
  event: Event,
  timeStamp: number,
): void {
  Object.defineProperty(event, "timeStamp", {
    value: timeStamp,
    configurable: true,
  });
  fireEvent(target, event);
}

describe("keyboard navigation skips disabled rows", () => {
  function renderRows() {
    render(
      <Command>
        <CommandInput />
        <CommandList>
          {labelledItems([
            { label: "One" },
            { label: "Two", disabled: true },
            { label: "Three" },
            { label: "Four", disabled: true },
            { label: "Five" },
          ])}
        </CommandList>
      </Command>,
    );
  }

  it("ArrowDown/ArrowUp skip disabled rows", () => {
    renderRows();
    expect(selectedRowText()).toBe("One");
    fireEvent.keyDown(getInput(), { key: "ArrowDown" });
    expect(selectedRowText()).toBe("Three");
    fireEvent.keyDown(getInput(), { key: "ArrowDown" });
    expect(selectedRowText()).toBe("Five");
    fireEvent.keyDown(getInput(), { key: "ArrowUp" });
    expect(selectedRowText()).toBe("Three");
  });

  it("Home/End skip disabled rows even at the array's own endpoints", () => {
    // The shared `renderRows()` fixture's first and last rows are already
    // enabled, so Home/End landing there wouldn't distinguish "skips
    // disabled rows" from "just jumps to index 0 / length-1 of the raw
    // array" - a negative control that can't fail. Disable the endpoints
    // themselves so only real disabled-skipping lands on the right row.
    render(
      <Command>
        <CommandInput />
        <CommandList>
          {labelledItems([
            { label: "Zero", disabled: true },
            { label: "One" },
            { label: "Two" },
            { label: "Three" },
            { label: "Four", disabled: true },
          ])}
        </CommandList>
      </Command>,
    );
    fireEvent.keyDown(getInput(), { key: "End" });
    expect(selectedRowText()).toBe("Three");
    fireEvent.keyDown(getInput(), { key: "Home" });
    expect(selectedRowText()).toBe("One");
  });

  it("PageDown/PageUp skip disabled rows when they land on one", () => {
    const { container } = render(
      <Command>
        <CommandInput />
        <CommandList>
          {labelledItems([
            { label: "R0" },
            { label: "R1" },
            { label: "R2", disabled: true },
            { label: "R3" },
            { label: "R4" },
          ])}
        </CommandList>
      </Command>,
    );
    const list = container.querySelector('[data-slot="command-list"]');
    if (!list) throw new Error("list not found");
    Object.defineProperty(list, "clientHeight", {
      configurable: true,
      value: 108, // 3 rows tall at 36px
    });
    for (const row of container.querySelectorAll(
      '[data-slot="command-item"]',
    )) {
      Object.defineProperty(row, "offsetHeight", {
        configurable: true,
        value: 36,
      });
    }
    // pageSize = floor(108/36) - 1 = 2, so PageDown from R0 targets index 2 in
    // the ENABLED array (R2 is excluded from that array), landing on R3.
    fireEvent.keyDown(getInput(), { key: "PageDown" });
    expect(selectedRowText()).toBe("R3");
    fireEvent.keyDown(getInput(), { key: "PageUp" });
    expect(selectedRowText()).toBe("R0");
  });
});

describe("scroll reset on query change", () => {
  // Replaces the deleted `usePaletteScrollReset` hook test: Command now owns
  // this directly (`useLayoutEffect` keyed on `query`), so the contract is
  // proven against the real component instead of an extracted hook.
  it("snaps the list back to the top when the query changes", () => {
    const { container } = render(
      <Command>
        <CommandInput />
        <CommandList>
          {labelledItems([{ label: "Alpha" }, { label: "Beta" }])}
        </CommandList>
      </Command>,
    );
    const list = container.querySelector('[data-slot="command-list"]');
    if (!list) throw new Error("list not found");
    let scrollTop = 240;
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    fireEvent.change(getInput(), { target: { value: "beta" } });
    expect(scrollTop).toBe(0);
  });
});

describe("group and separator DOM order", () => {
  // Regression for a production bug found in review: the no-query/no-filter
  // reordering effect used to append every row/group unconditionally, which
  // dragged registered nodes past an unregistered sibling like
  // `CommandSeparator` (it has no anchor and is never touched by the
  // reorder). Fixed by restoring original anchor position when the query is
  // empty / shouldFilter is false, and only reordering during active
  // filtering.
  function renderGroups() {
    return render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandGroup heading="First">
            <CommandItem itemKey="a">Alpha</CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Second">
            <CommandItem itemKey="b">Beta</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );
  }

  function orderedSlots(container: HTMLElement): ReadonlyArray<string> {
    const content = container.querySelector(
      '[data-slot="command-list-content"]',
    );
    if (!content) throw new Error("list content not found");
    return [...content.children]
      .map((child) => child.getAttribute("data-slot"))
      .filter((slot): slot is string => slot !== null);
  }

  it("keeps the separator between its groups when the query is empty", () => {
    const { container } = renderGroups();
    expect(orderedSlots(container)).toEqual([
      "command-group",
      "command-separator",
      "command-group",
    ]);
  });

  it("restores authored order after a query is typed and cleared", () => {
    const { container } = renderGroups();
    fireEvent.change(getInput(), { target: { value: "beta" } });
    fireEvent.change(getInput(), { target: { value: "" } });
    expect(orderedSlots(container)).toEqual([
      "command-group",
      "command-separator",
      "command-group",
    ]);
  });
});

describe("controlled highlight ownership", () => {
  // Regression for a production bug found in review: the effective-value sync
  // effect used to fire on the FIRST commit, before child rows had
  // registered (`rows` was still `[]`), so it reported an empty value to a
  // controlling parent even when that parent supplied a real initial
  // `highlightedValue` for a non-first row. `defaultHighlightedValue`
  // (uncontrolled) doesn't exercise this path - only a controlled
  // `highlightedValue` does. Fixed by guarding the sync until rows have
  // registered.
  it("does not report an empty value for a controlled initial highlight on a non-first row", () => {
    const onHighlightChange = vi.fn<(value: string) => void>();
    render(
      <Command highlightedValue="third" onHighlightChange={onHighlightChange}>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="first">First</CommandItem>
          <CommandItem itemKey="second">Second</CommandItem>
          <CommandItem itemKey="third">Third</CommandItem>
        </CommandList>
      </Command>,
    );
    expect(onHighlightChange).not.toHaveBeenCalledWith("");
    expect(selectedRowText()).toBe("Third");
  });

  it("moves the highlight when the controlling parent changes highlightedValue externally", () => {
    const onHighlightChange = vi.fn<(value: string) => void>();
    const { rerender } = render(
      <Command highlightedValue="one" onHighlightChange={onHighlightChange}>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="one">One</CommandItem>
          <CommandItem itemKey="two">Two</CommandItem>
        </CommandList>
      </Command>,
    );
    expect(selectedRowText()).toBe("One");
    rerender(
      <Command highlightedValue="two" onHighlightChange={onHighlightChange}>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="one">One</CommandItem>
          <CommandItem itemKey="two">Two</CommandItem>
        </CommandList>
      </Command>,
    );
    expect(selectedRowText()).toBe("Two");
  });

  it("falls back to another enabled row when the active row becomes disabled", () => {
    const onHighlightChange = vi.fn<(value: string) => void>();
    const { rerender } = render(
      <Command highlightedValue="two" onHighlightChange={onHighlightChange}>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="one">One</CommandItem>
          <CommandItem itemKey="two">Two</CommandItem>
        </CommandList>
      </Command>,
    );
    expect(selectedRowText()).toBe("Two");
    onHighlightChange.mockClear();
    rerender(
      <Command highlightedValue="two" onHighlightChange={onHighlightChange}>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="one">One</CommandItem>
          <CommandItem itemKey="two" disabled>
            Two
          </CommandItem>
        </CommandList>
      </Command>,
    );
    expect(selectedRowText()).toBe("One");
    expect(onHighlightChange).toHaveBeenCalledWith("one");
  });

  it("falls back to another enabled row when the active row unmounts", () => {
    const onHighlightChange = vi.fn<(value: string) => void>();
    const { rerender } = render(
      <Command highlightedValue="two" onHighlightChange={onHighlightChange}>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="one">One</CommandItem>
          <CommandItem itemKey="two">Two</CommandItem>
        </CommandList>
      </Command>,
    );
    expect(selectedRowText()).toBe("Two");
    rerender(
      <Command highlightedValue="two" onHighlightChange={onHighlightChange}>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="one">One</CommandItem>
        </CommandList>
      </Command>,
    );
    expect(selectedRowText()).toBe("One");
  });
});

describe("query retention and duplicate rows", () => {
  it("keeps the typed query after an item action runs", () => {
    const onAction = vi.fn();
    render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="alpha" onAction={onAction}>
            Alpha
          </CommandItem>
        </CommandList>
      </Command>,
    );
    fireEvent.change(getInput(), { target: { value: "alp" } });
    fireEvent.click(screen.getByText("Alpha"));
    expect(onAction).toHaveBeenCalledOnce();
    expect((getInput() as HTMLInputElement).value).toBe("alp");
  });

  it("renders and independently navigates two rows sharing the same label", () => {
    render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="dup-1" searchText="Duplicate">
            Duplicate
          </CommandItem>
          <CommandItem itemKey="dup-2" searchText="Duplicate">
            Duplicate
          </CommandItem>
        </CommandList>
      </Command>,
    );
    const rows = screen.getAllByText("Duplicate");
    expect(rows).toHaveLength(2);
    expect(selectedRowText()).toBe("Duplicate");
    fireEvent.keyDown(getInput(), { key: "ArrowDown" });
    const secondRow = rows[1].closest('[data-slot="command-item"]');
    expect(secondRow?.getAttribute("data-selected")).toBe("true");
  });
});

describe("shouldFilter=false bypasses scoring", () => {
  it("keeps every row visible regardless of query", () => {
    render(
      <Command shouldFilter={false}>
        <CommandInput />
        <CommandList>
          {labelledItems([{ label: "Alpha" }, { label: "Zzz" }])}
        </CommandList>
      </Command>,
    );
    fireEvent.change(getInput(), { target: { value: "nothing-matches-this" } });
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Zzz")).toBeTruthy();
  });
});

describe("ranking reorders rows in the DOM", () => {
  it("moves the higher-scored row first, via the injected scoreItem", () => {
    const { container } = render(
      <Command scoreItem={(text) => (text === "Second" ? 2 : 1)}>
        <CommandInput />
        <CommandList>
          {labelledItems([{ label: "First" }, { label: "Second" }])}
        </CommandList>
      </Command>,
    );
    fireEvent.change(getInput(), { target: { value: "x" } });
    const rows = [...container.querySelectorAll('[data-slot="command-item"]')];
    expect(rows.map((row) => row.textContent)).toEqual(["Second", "First"]);
  });
});

describe("rows without an itemKey or searchText", () => {
  function labelled(label: string) {
    return (
      <Command>
        <CommandInput />
        <CommandList>
          <CommandItem>{label}</CommandItem>
          <CommandItem itemKey="other">Other</CommandItem>
        </CommandList>
      </Command>
    );
  }

  it("filters on the row's current text after its label changes", () => {
    const { rerender } = render(labelled("Old label"));
    rerender(labelled("Renamed entry"));
    fireEvent.change(getInput(), { target: { value: "renamed" } });
    expect(
      screen.queryByRole("option", { name: "Renamed entry" }),
    ).not.toBeNull();
    expect(screen.queryByRole("option", { name: "Other" })).toBeNull();

    fireEvent.change(getInput(), { target: { value: "old label" } });
    expect(screen.queryByRole("option", { name: "Renamed entry" })).toBeNull();
  });
});

describe("list reconciliation cost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps one observer across renders that change no rows, groups or query", () => {
    let created = 0;
    const NativeObserver = globalThis.MutationObserver;
    vi.stubGlobal(
      "MutationObserver",
      class extends NativeObserver {
        constructor(callback: MutationCallback) {
          super(callback);
          created += 1;
        }
      },
    );
    const tree = (className: string) => (
      <Command className={className}>
        <CommandInput />
        <CommandList>
          {labelledItems([{ label: "One" }, { label: "Two" }])}
        </CommandList>
      </Command>
    );
    const { rerender } = render(tree("a"));
    const afterMount = created;
    expect(afterMount).toBeGreaterThan(0);

    rerender(tree("b"));
    rerender(tree("c"));
    fireEvent.keyDown(getInput(), { key: "ArrowDown" });
    fireEvent.keyDown(getInput(), { key: "ArrowUp" });

    expect(created).toBe(afterMount);
  });
});

describe("empty results", () => {
  it("shows CommandEmpty when every row scores zero", () => {
    render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandEmpty>No results</CommandEmpty>
          <CommandItem itemKey="alpha">Alpha</CommandItem>
        </CommandList>
      </Command>,
    );
    fireEvent.change(getInput(), { target: { value: "zzz-no-match" } });
    expect(screen.getByText("No results")).toBeTruthy();
    // `queryByRole` respects the native `hidden` attribute a zero-scored row
    // gets; `queryByText` would still find the (hidden) DOM node.
    expect(screen.queryByRole("option", { name: "Alpha" })).toBeNull();
  });
});

describe("stable ids and aria-activedescendant", () => {
  it("points aria-activedescendant only at a present, enabled row", () => {
    render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="alpha">Alpha</CommandItem>
        </CommandList>
      </Command>,
    );
    const activeId = getInput().getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    expect(document.getElementById(activeId ?? "")?.textContent).toBe("Alpha");
  });

  it("clears aria-activedescendant when there is no enabled row to point at", () => {
    render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="alpha" disabled>
            Alpha
          </CommandItem>
        </CommandList>
      </Command>,
    );
    expect(getInput().getAttribute("aria-activedescendant")).toBeNull();
  });

  it("keeps each row's id stable across re-renders", () => {
    const { rerender } = render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="alpha">Alpha</CommandItem>
        </CommandList>
      </Command>,
    );
    const firstId = screen
      .getByText("Alpha")
      .closest('[data-slot="command-item"]')?.id;
    fireEvent.change(getInput(), { target: { value: "a" } });
    rerender(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="alpha">Alpha</CommandItem>
        </CommandList>
      </Command>,
    );
    const secondId = screen
      .getByText("Alpha")
      .closest('[data-slot="command-item"]')?.id;
    expect(secondId).toBe(firstId);
  });
});

describe("IME-safe Enter", () => {
  it("ignores Enter fired while composing", () => {
    const onAction = vi.fn();
    render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="alpha" onAction={onAction}>
            Alpha
          </CommandItem>
        </CommandList>
      </Command>,
    );
    const input = getInput();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onAction).not.toHaveBeenCalled();
  });

  it("ignores the trailing Enter within the composition grace window", () => {
    const onAction = vi.fn();
    render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="alpha" onAction={onAction}>
            Alpha
          </CommandItem>
        </CommandList>
      </Command>,
    );
    const input = getInput();
    // Explicit timestamps, same reasoning as the grace-window-expired case
    // below: a same-tick `fireEvent` pair happens to land under 50ms
    // apart today, but that's an accident of how fast the test runs, not
    // a guarantee - state it directly instead.
    fireAtTime(input, createEvent.compositionStart(input), 1_000);
    fireAtTime(input, createEvent.compositionEnd(input), 1_000);
    fireAtTime(input, createEvent.keyDown(input, { key: "Enter" }), 1_010);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("still fires Enter once composition is well past its grace window", () => {
    const onAction = vi.fn();
    render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandItem itemKey="alpha" onAction={onAction}>
            Alpha
          </CommandItem>
        </CommandList>
      </Command>,
    );
    const input = getInput();
    // Explicit `timeStamp`s rather than a real wall-clock wait: the grace
    // window is elapsed-time arithmetic (`event.timeStamp - endedAt`), so
    // the test controls that arithmetic directly instead of racing a real
    // timer against however long the surrounding test machinery takes.
    fireAtTime(input, createEvent.compositionStart(input), 1_000);
    fireAtTime(input, createEvent.compositionEnd(input), 1_000);
    fireAtTime(input, createEvent.keyDown(input, { key: "Enter" }), 1_060);
    expect(onAction).toHaveBeenCalledOnce();
  });
});

describe("two mounted Command instances stay isolated", () => {
  it("does not let keyboard navigation in one instance move the other's highlight", () => {
    render(
      <>
        <Command>
          <CommandInput aria-label="first" />
          <CommandList>
            {labelledItems([{ label: "A1" }, { label: "A2" }])}
          </CommandList>
        </Command>
        <Command>
          <CommandInput aria-label="second" />
          <CommandList>
            {labelledItems([{ label: "B1" }, { label: "B2" }])}
          </CommandList>
        </Command>
      </>,
    );
    const [firstInput] = screen.getAllByRole("combobox");
    fireEvent.keyDown(firstInput, { key: "ArrowDown" });
    const selectedRows = [
      ...document.querySelectorAll('[data-selected="true"]'),
    ].map((row) => row.textContent);
    expect(selectedRows).toEqual(["A2", "B1"]);
  });

  it("does not let typing a query in one instance filter the other", () => {
    render(
      <>
        <Command>
          <CommandInput aria-label="first" />
          <CommandList>
            {labelledItems([{ label: "A1" }, { label: "A2" }])}
          </CommandList>
        </Command>
        <Command>
          <CommandInput aria-label="second" />
          <CommandList>
            {labelledItems([{ label: "B1" }, { label: "B2" }])}
          </CommandList>
        </Command>
      </>,
    );
    const [firstInput] = screen.getAllByRole("combobox");
    fireEvent.change(firstInput, { target: { value: "nothing-matches" } });
    expect(screen.queryByRole("option", { name: "A1" })).toBeNull();
    expect(screen.getByText("B1")).toBeTruthy();
    expect(screen.getByText("B2")).toBeTruthy();
  });
});

describe("loopNavigation", () => {
  it("wraps from the last row to the first only when enabled", () => {
    render(
      <Command loopNavigation>
        <CommandInput />
        <CommandList>
          {labelledItems([{ label: "One" }, { label: "Two" }])}
        </CommandList>
      </Command>,
    );
    fireEvent.keyDown(getInput(), { key: "ArrowUp" });
    expect(selectedRowText()).toBe("Two");
    fireEvent.keyDown(getInput(), { key: "ArrowDown" });
    expect(selectedRowText()).toBe("One");
  });

  it("clamps at the last row by default", () => {
    render(
      <Command>
        <CommandInput />
        <CommandList>
          {labelledItems([{ label: "One" }, { label: "Two" }])}
        </CommandList>
      </Command>,
    );
    fireEvent.keyDown(getInput(), { key: "ArrowDown" });
    fireEvent.keyDown(getInput(), { key: "ArrowDown" });
    expect(selectedRowText()).toBe("Two");
  });
});

// T08 review R1: `commandCollection()` must derive ranking/navigation from
// the COMMITTED anchor order, refreshed after React applies a caller
// reorder - not a render-time DOM snapshot that still describes the
// previous order. Shapes below are ported directly from the independent
// review's own probe (`review/probes.txt`), against the real app `<Command>`
// instead of its throwaway `cmdk` comparison branch.
describe("R1 review regressions: committed source order after a caller reorder", () => {
  function reorderedRows(reverse: boolean, matching: boolean) {
    const keys = reverse ? ["c", "b", "a"] : ["a", "b", "c"];
    return (
      <Command>
        <CommandInput />
        <CommandList>
          {keys.map((key) => (
            <CommandItem
              key={key}
              itemKey={key}
              searchText={matching ? "Match" : key}
            >
              {key}
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    );
  }

  it("Home follows the caller reorder immediately, without another query change", () => {
    const view = render(reorderedRows(false, false));
    view.rerender(reorderedRows(true, false));
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(
      ["c", "b", "a"],
    );
    fireEvent.keyDown(getInput(), { key: "Home" });
    expect(selectedRowText()).toBe("c");
  });

  it("active-query equal scores follow the latest caller source order, with no query change", () => {
    const view = render(reorderedRows(false, true));
    fireEvent.change(getInput(), { target: { value: "Match" } });
    view.rerender(reorderedRows(true, true));
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(
      ["c", "b", "a"],
    );
  });

  it("a reorder driven by a NESTED local-state consumer is observed without Command itself re-rendering", () => {
    // `NestedRows` owns its own row order in local state, a sibling of
    // `Command`'s own internal state, never a prop Command re-renders for.
    // Reordering here only re-renders `NestedRows` and its own subtree -
    // `Command`'s "runs after every commit OF Command" layout effect never
    // fires from this trigger. Only `Command`'s MutationObserver (watching
    // `listRef.current` for DOM mutations regardless of cause) can pick it
    // up.
    let setOrder: ((keys: ReadonlyArray<string>) => void) | undefined;
    function NestedRows() {
      const [order, setLocalOrder] = useState<ReadonlyArray<string>>([
        "a",
        "b",
        "c",
      ]);
      setOrder = setLocalOrder;
      return order.map((key) => (
        <CommandItem key={key} itemKey={key} searchText="Match">
          {key}
        </CommandItem>
      ));
    }
    render(
      <Command>
        <CommandInput />
        <CommandList>
          <NestedRows />
        </CommandList>
      </Command>,
    );
    fireEvent.change(getInput(), { target: { value: "Match" } });
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(
      ["a", "b", "c"],
    );
    act(() => setOrder?.(["c", "b", "a"]));
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(
      ["c", "b", "a"],
    );
    fireEvent.keyDown(getInput(), { key: "Home" });
    expect(selectedRowText()).toBe("c");
  });

  // Review follow-up: pre-paint effects can cascade through several commits
  // before `sourcePositions` state (which starts empty) catches up - reading
  // only the FINAL, settled DOM doesn't prove a controlled consumer was never
  // handed a wrong intermediate value along the way. Mixed grouped+ungrouped
  // rows are the real-world shape this matters for (recent items ungrouped,
  // then a labeled group, e.g. the command palette's own grouping).
  it("mixed grouped+ungrouped initial rows: a real controlled highlight loop never reports an empty or wrong intermediate value", () => {
    const onHighlightChange = vi.fn<(value: string) => void>();
    function Controlled() {
      const [value, setValue] = useState("");
      return (
        <Command
          highlightedValue={value}
          onHighlightChange={(next) => {
            onHighlightChange(next);
            setValue(next);
          }}
        >
          <CommandInput />
          <CommandList>
            <CommandItem itemKey="ungrouped-first">Ungrouped First</CommandItem>
            <CommandGroup heading="Group">
              <CommandItem itemKey="grouped">Grouped</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      );
    }
    render(<Controlled />);
    expect(onHighlightChange).not.toHaveBeenCalledWith("");
    expect(
      onHighlightChange.mock.calls.every(
        ([value]) => value === "ungrouped-first",
      ),
    ).toBe(true);
    expect(selectedRowText()).toBe("Ungrouped First");
  });
});

// T08 review R2: the previous `cmdk` wrapper enabled Ctrl+N/J/P/K, Meta
// Up/Down (first/last) and Alt Up/Down (previous/next group) by default;
// the replacement dropped all of it. These are app-owned now (no
// `vimBindings` prop exists), implemented directly in `navigate()`.
describe("R2 review regressions: modifier-key chord navigation", () => {
  // g2 is disabled-only, g4 has no rows at all - both must be skipped by an
  // Alt group-hop the same way; a genuinely "hidden via filtering" group
  // (all rows score 0 under an active query) collapses to the SAME `rows: []`
  // shape `nonemptyGroups` checks for, so the empty-group case here also
  // covers that path.
  function renderChordRows() {
    render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandGroup heading="g1">
            <CommandItem itemKey="a">a</CommandItem>
            <CommandItem itemKey="b">b</CommandItem>
          </CommandGroup>
          <CommandGroup heading="g2">
            <CommandItem itemKey="skip1" disabled>
              skip1
            </CommandItem>
            <CommandItem itemKey="skip2" disabled>
              skip2
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="g3">
            <CommandItem itemKey="c">c</CommandItem>
            <CommandItem itemKey="d">d</CommandItem>
          </CommandGroup>
          <CommandGroup heading="g4" />
        </CommandList>
      </Command>,
    );
  }

  it("Ctrl+N/J map to ArrowDown, Ctrl+P/K map to ArrowUp", () => {
    renderChordRows();
    expect(selectedRowText()).toBe("a");
    fireEvent.keyDown(getInput(), { key: "n", ctrlKey: true });
    expect(selectedRowText()).toBe("b");
    fireEvent.keyDown(getInput(), { key: "j", ctrlKey: true });
    expect(selectedRowText()).toBe("c");
    fireEvent.keyDown(getInput(), { key: "p", ctrlKey: true });
    expect(selectedRowText()).toBe("b");
    fireEvent.keyDown(getInput(), { key: "k", ctrlKey: true });
    expect(selectedRowText()).toBe("a");
  });

  it("Meta+ArrowDown/Up jump to the last/first ENABLED row", () => {
    renderChordRows();
    fireEvent.keyDown(getInput(), { key: "ArrowDown", metaKey: true });
    expect(selectedRowText()).toBe("d");
    fireEvent.keyDown(getInput(), { key: "ArrowUp", metaKey: true });
    expect(selectedRowText()).toBe("a");
  });

  it("Alt+ArrowDown/Up hop groups, skip a disabled-only AND an empty group, always land on the target group's first enabled row, and fall back to an ordinary step at a boundary", () => {
    renderChordRows();
    fireEvent.keyDown(getInput(), { key: "ArrowDown", altKey: true });
    // Skips g2 (disabled-only) entirely, and skips 'b' within g1 - proving
    // this is a GROUP hop, not an ordinary/Ctrl-remapped single step.
    expect(selectedRowText()).toBe("c");
    fireEvent.keyDown(getInput(), { key: "ArrowDown" });
    expect(selectedRowText()).toBe("d");
    fireEvent.keyDown(getInput(), { key: "ArrowDown", altKey: true });
    // g4 is empty; no group after g3 has an enabled row, so this falls back
    // to an ordinary step - already last, clamps at 'd'.
    expect(selectedRowText()).toBe("d");
    fireEvent.keyDown(getInput(), { key: "ArrowUp", altKey: true });
    // Hops back to g1's FIRST enabled row 'a' - not the nearer 'c' it
    // started next to, and not 'b'.
    expect(selectedRowText()).toBe("a");
    fireEvent.keyDown(getInput(), { key: "ArrowUp", altKey: true });
    // No group before g1: falls back to an ordinary step, clamps at 'a'.
    expect(selectedRowText()).toBe("a");
  });

  it("a consumer onKeyDown that calls preventDefault() blocks every chord family", () => {
    render(
      <Command onKeyDown={(event) => event.preventDefault()}>
        <CommandInput />
        <CommandList>
          <CommandGroup heading="g1">
            <CommandItem itemKey="a">a</CommandItem>
            <CommandItem itemKey="b">b</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );
    fireEvent.keyDown(getInput(), { key: "n", ctrlKey: true });
    expect(selectedRowText()).toBe("a");
    fireEvent.keyDown(getInput(), { key: "ArrowDown", metaKey: true });
    expect(selectedRowText()).toBe("a");
    fireEvent.keyDown(getInput(), { key: "ArrowDown", altKey: true });
    expect(selectedRowText()).toBe("a");
  });

  it("a window-capture listener claiming Ctrl+N wins before Command's own bubble handler ever sees it", () => {
    // Mirrors KeybindingProvider's own window-capture app-shortcut handling
    // (Ctrl+K/J/N on non-mac) and composer-drafts-control's capture-phase
    // ArrowUp/Down - both rely on the same real DOM capture-before-bubble
    // guarantee this reproduces directly, in jsdom, without needing either
    // provider's own router/action-registry/composer context.
    renderChordRows();
    const onCapture = vi.fn((event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "n") {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    window.addEventListener("keydown", onCapture, true);
    try {
      fireEvent.keyDown(getInput(), { key: "n", ctrlKey: true });
      expect(onCapture).toHaveBeenCalledTimes(1);
      expect(selectedRowText()).toBe("a");
    } finally {
      window.removeEventListener("keydown", onCapture, true);
    }
  });
});
