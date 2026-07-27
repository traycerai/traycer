import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsRow } from "@/components/settings/settings-row";

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
        label="Artifact icon colors"
        description="Pick colors used for artifact type icons."
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
        label="Wide control row"
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
});
