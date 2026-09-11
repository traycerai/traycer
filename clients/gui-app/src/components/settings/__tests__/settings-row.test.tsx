import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsRow } from "@/components/settings/settings-row";
import { useSettingsRowDescriptionId } from "@/components/settings/settings-row-description";
import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/** Rows shaped like the real ones; the section id is incidental. */
const ROWS = defineSettingsSection("appearance", {
  page: { label: "Appearance", description: "Page.", keywords: ["page"] },
  artifactIconColors: {
    kind: "row",
    group: null,
    search: { anchor: "test-artifact-icon-colors" },
    label: "Artifact icon colors",
    description: "Pick colors used for artifact type icons.",
    availableWhen: alwaysAvailable,
    keywords: ["icons"],
  },
  wideControl: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Wide control row",
    description: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  someLabel: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Some label",
    description: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  openNewTiles: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Open new tiles",
    description: "Narrow windows show one tile at a time.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  openLinks: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Open links",
    description: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});

describe("SettingsRow", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps a wrapped control end-aligned below the label", () => {
    // jsdom does no layout, so this asserts the CONTRACT rather than a measured
    // stack: a half-row label floor makes wide controls wrap, while ml-auto
    // keeps the wrapped control pinned to the trailing edge instead of falling
    // under the label at the leading edge.
    render(
      <SettingsRow
        row={ROWS.definitions.artifactIconColors}
        control={
          <div className="w-80" data-testid="wide-control">
            Wide control
          </div>
        }
      />,
    );

    const label = screen.getByText("Artifact icon colors");
    const labelBlock = label.parentElement;
    if (labelBlock === null) throw new Error("expected label block parent");

    const row = labelBlock.parentElement;
    if (row === null) throw new Error("expected settings row container");
    // The wrap mechanism itself - not merely "flex".
    expect(row.className).toContain("flex-wrap");
    // Guard against a future edit re-adding nowrap (mirrors worktree-owner-
    // settings-header's inverse check for the opposite contract).
    expect(row.className).not.toContain("flex-nowrap");
    expect(labelBlock.className).toContain("min-w-[50%]");
    expect(labelBlock.className).toContain("flex-1");

    const control = screen.getByTestId("wide-control");
    const controlWrapper = control.parentElement;
    if (controlWrapper === null) {
      throw new Error("expected SettingsRow control wrapper");
    }
    // Shrink contract: the wrapper caps its own box (max-w-full) AND forces
    // every direct child to respect that cap via [&>*]:max-w-full. A parent
    // max-width alone never shrinks a child's explicit width (e.g. w-80) -
    // only clips/overflows - so the child-targeting selector is required.
    // shrink-0 alone would still overflow a narrower row on the wrapped line.
    expect(controlWrapper.className).toContain("max-w-full");
    expect(controlWrapper.className).toContain("[&>*]:max-w-full");
    expect(controlWrapper.className).toContain("shrink-0");
    expect(controlWrapper.className).toContain("ml-auto");
    expect(controlWrapper.className).toContain("justify-end");

    // The control remains after the label in source order; flex wrapping and
    // auto leading margin move it visually without changing reading order.
    expect(
      labelBlock.compareDocumentPosition(controlWrapper) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("clamps a wider-than-row control with max-w-full on SettingsRow's control wrapper", () => {
    // Regression for the pre-fix bug: a w-80 control (the real offender shape
    // used by the artifact-icon-colors picker) kept overflowing after wrap when
    // only shrink-0 was present. The clamp lives on SettingsRow's own wrapper
    // (max-w-full + [&>*]:max-w-full) - the child keeps its fixed-width class
    // in markup; the wrapper forces max-width:100% onto that child via CSS.
    render(
      <SettingsRow
        row={ROWS.definitions.wideControl}
        control={
          <div className="w-80" data-testid="overflow-risk-control">
            wide
          </div>
        }
      />,
    );

    const control = screen.getByTestId("overflow-risk-control");
    const controlWrapper = control.parentElement;
    if (controlWrapper === null) {
      throw new Error("expected SettingsRow control wrapper");
    }
    // Assert against SettingsRow's wrapper, not the wide child itself.
    expect(controlWrapper).not.toBe(control);
    expect(controlWrapper.className).toContain("max-w-full");
    expect(controlWrapper.className).toContain("[&>*]:max-w-full");
    expect(controlWrapper.className).toContain("shrink-0");
    expect(controlWrapper.className).toContain("ml-auto");
    // Child markup still declares w-80; the wrapper's [&>*]:max-w-full is what
    // constrains it at layout time (jsdom has no layout - assert the class).
    expect(control.className).toContain("w-80");
    expect(control.className).not.toContain("max-w-full");
  });

  it("floors the label below md so a wide control takes its own line", () => {
    // SETTINGS_ROW_STACK is the shared narrow-width half of this geometry. Flex
    // line-breaking reads an item's basis clamped by its own min-width, so
    // raising the label's floor to 70% below md is what decides which controls
    // stack: anything wider than the remaining third is pushed onto a line of
    // its own BEFORE any shrinking happens, while a switch-sized control still
    // fits beside the label - which is where a settings toggle belongs.
    //
    // Every responsive override it contributes carries a max-md: variant - bar
    // the flex-wrap the mechanism acts through, which this row already
    // declares - so it only ever LAYERS ONTO the desktop rules asserted above;
    // it must never remove ml-auto/justify-end, which are what keep the
    // control trailing-aligned.
    render(
      <SettingsRow
        row={ROWS.definitions.someLabel}
        control={<div data-testid="control">Control</div>}
      />,
    );

    const label = screen.getByText("Some label");
    const labelBlock = label.parentElement;
    if (labelBlock === null) throw new Error("expected label block parent");

    const row = labelBlock.parentElement;
    if (row === null) throw new Error("expected settings row container");
    // The floor does nothing without the wrap it acts through.
    expect(row.className).toContain("flex-wrap");
    expect(row.className).toContain("max-md:gap-y-3");

    // Both floors coexist: the desktop half-row one, and the narrower-viewport
    // one that supersedes it only below the breakpoint.
    expect(labelBlock.className).toContain("min-w-[50%]");
    expect(labelBlock.className).toContain("max-md:min-w-[70%]");

    const control = screen.getByTestId("control");
    const controlWrapper = control.parentElement;
    if (controlWrapper === null) {
      throw new Error("expected SettingsRow control wrapper");
    }
    // Holds its intrinsic width rather than shrinking into the label's.
    expect(controlWrapper.className).toContain("max-md:shrink-0");
    // The trailing-edge contract survives: these are additions guarded by
    // max-md:, not replacements.
    expect(controlWrapper.className).toContain("ml-auto");
    expect(controlWrapper.className).toContain("justify-end");
  });

  it("hands its description's id to a control that asks for one", () => {
    // The description is the row's real second line of copy, so the control
    // should be DESCRIBED by it rather than leaving a screen reader with a
    // bare label. The context is the whole mechanism - `control` stays a
    // plain ReactNode, so no existing call site changes shape.
    render(
      <SettingsRow
        row={ROWS.definitions.openNewTiles}
        control={<DescribedControl>In this pane</DescribedControl>}
      />,
    );

    const control = screen.getByRole("button", { name: "In this pane" });
    const describedBy = control.getAttribute("aria-describedby");
    if (describedBy === null) throw new Error("expected aria-describedby");
    const description = document.getElementById(describedBy);
    expect(description?.textContent).toBe(
      "Narrow windows show one tile at a time.",
    );
    // Long descriptions get a reading measure rather than the full row width.
    expect(description?.className).toContain("max-w-[72ch]");
    expect(description?.className).toContain("text-pretty");
  });

  it("describes nothing when the row has no description", () => {
    render(
      <SettingsRow
        row={ROWS.definitions.openLinks}
        control={<DescribedControl>In Traycer</DescribedControl>}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "In Traycer" })
        .getAttribute("aria-describedby"),
    ).toBeNull();
  });

  it("shows a status instead of the static description, in the same described-by region", () => {
    render(
      <SettingsRow
        row={ROWS.definitions.openNewTiles}
        status="Couldn't read this setting."
        control={<DescribedControl>In this pane</DescribedControl>}
      />,
    );

    expect(
      screen.queryByText("Narrow windows show one tile at a time."),
    ).toBeNull();
    const describedBy = screen
      .getByRole("button", { name: "In this pane" })
      .getAttribute("aria-describedby");
    if (describedBy === null) throw new Error("expected aria-describedby");
    const region = document.getElementById(describedBy);
    expect(region?.textContent).toBe("Couldn't read this setting.");
    // Arbitrary content, so a `div` — with the description's own muted style.
    expect(region?.tagName).toBe("DIV");
    expect(region?.className).toContain("text-muted-foreground");
    expect(region?.className).toContain("max-w-[72ch]");
  });

  it("describes a row whose only sentence is its status", () => {
    // The row's definition has no static description; the described-by id has
    // to follow the status, not the missing description.
    render(
      <SettingsRow
        row={ROWS.definitions.openLinks}
        status="Checking…"
        control={<DescribedControl>In Traycer</DescribedControl>}
      />,
    );

    const describedBy = screen
      .getByRole("button", { name: "In Traycer" })
      .getAttribute("aria-describedby");
    if (describedBy === null) throw new Error("expected aria-describedby");
    expect(document.getElementById(describedBy)?.textContent).toBe("Checking…");
  });

  // `status ?? description` would bring the static sentence back for `null`,
  // and a truthiness test would for `false` and `""`. All three are a
  // deliberate "say nothing here".
  for (const [name, suppression] of [
    ["null", null],
    ["false", false],
    ["an empty string", ""],
  ] as const) {
    it(`treats ${name} as suppressing the description, not as absent`, () => {
      render(
        <SettingsRow
          row={ROWS.definitions.openNewTiles}
          status={suppression}
          control={<DescribedControl>In this pane</DescribedControl>}
        />,
      );

      expect(
        screen.queryByText("Narrow windows show one tile at a time."),
      ).toBeNull();
      expect(
        screen
          .getByRole("button", { name: "In this pane" })
          .getAttribute("aria-describedby"),
      ).toBeNull();
    });
  }

  it("restores the static description when a status goes back to undefined", () => {
    const { rerender } = render(
      <SettingsRow
        row={ROWS.definitions.openNewTiles}
        status="Couldn't read this setting."
        control={<DescribedControl>In this pane</DescribedControl>}
      />,
    );
    expect(
      screen.queryByText("Narrow windows show one tile at a time."),
    ).toBeNull();

    rerender(
      <SettingsRow
        row={ROWS.definitions.openNewTiles}
        status={undefined}
        control={<DescribedControl>In this pane</DescribedControl>}
      />,
    );

    expect(screen.queryByText("Couldn't read this setting.")).toBeNull();
    const describedBy = screen
      .getByRole("button", { name: "In this pane" })
      .getAttribute("aria-describedby");
    if (describedBy === null) throw new Error("expected aria-describedby");
    const region = document.getElementById(describedBy);
    expect(region?.tagName).toBe("P");
    expect(region?.textContent).toBe("Narrow windows show one tile at a time.");
  });

  it("writes its definition's anchor, and none for a contributor", () => {
    const { container } = render(
      <>
        <SettingsRow
          row={ROWS.definitions.artifactIconColors}
          control={<span>control</span>}
        />
        <SettingsRow
          row={ROWS.definitions.openLinks}
          control={<span>control</span>}
        />
      </>,
    );

    const anchored = container.querySelectorAll("[data-settings-anchor]");
    expect(anchored.length).toBe(1);
    expect(anchored[0]?.getAttribute("data-settings-anchor")).toBe(
      "test-artifact-icon-colors",
    );
    expect(anchored[0]?.textContent).toContain("Artifact icon colors");
  });
});

/** Stands in for a real settings control that opts into the description. */
function DescribedControl(props: { readonly children: string }) {
  return (
    <button type="button" aria-describedby={useSettingsRowDescriptionId()}>
      {props.children}
    </button>
  );
}
