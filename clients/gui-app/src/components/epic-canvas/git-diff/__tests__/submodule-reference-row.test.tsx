import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SubmoduleReferenceRowView } from "@/lib/git/git-repo-composition";
import { SubmoduleReferenceRow } from "../submodule-reference-row";

function view(
  overrides: Partial<SubmoduleReferenceRowView>,
): SubmoduleReferenceRowView {
  return {
    parentPath: "traycer",
    label: "traycer",
    pointer: {
      kind: "normal",
      recordedPinSha: "1111111111",
      stagedPinSha: null,
      commitChanged: false,
      modifiedContent: true,
      untrackedContent: false,
    },
    checkoutHeadSha: "2222222222",
    detailsAvailable: true,
    detailsUnavailable: false,
    summary: "parent references 1111111, checkout at 2222222",
    ...overrides,
  };
}

describe("<SubmoduleReferenceRow />", () => {
  beforeEach(() => cleanup());

  it("renders a demoted, non-button reference row with its pointer summary", () => {
    render(
      <SubmoduleReferenceRow
        view={view({})}
        onRefresh={vi.fn()}
        isRefreshing={false}
      />,
    );
    // Non-interactive for now (activation is T06): no misleading button role.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Submodule reference:")).toBeDefined();
    expect(screen.getByText("traycer")).toBeDefined();
    expect(
      screen.getByText("parent references 1111111, checkout at 2222222"),
    ).toBeDefined();
    expect(screen.queryByTestId("submodule-reference-refresh-traycer")).toBeNull();
  });

  it("surfaces the details-unavailable affordance with a working refresh", () => {
    const onRefresh = vi.fn();
    render(
      <SubmoduleReferenceRow
        view={view({ detailsAvailable: false, detailsUnavailable: true })}
        onRefresh={onRefresh}
        isRefreshing={false}
      />,
    );
    expect(
      screen.getByText("Submodule details unavailable on this host version"),
    ).toBeDefined();
    fireEvent.click(
      screen.getByTestId("submodule-reference-refresh-traycer"),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("renders a conflicted pointer under the 'Reference needs attention' label, summary in detail", () => {
    render(
      <SubmoduleReferenceRow
        view={view({
          pointer: {
            kind: "conflicted",
            baseSha: "bbbbbbbbbb",
            oursSha: "cccccccccc",
            theirsSha: "dddddddddd",
          },
          summary: "merge conflict on the submodule pointer (base bbbbbbb)",
        })}
        onRefresh={vi.fn()}
        isRefreshing={false}
      />,
    );
    expect(screen.getByText("Reference needs attention")).toBeDefined();
    expect(screen.queryByText("Submodule reference:")).toBeNull();
    expect(
      screen.getByText(/merge conflict on the submodule pointer/),
    ).toBeDefined();
    expect(screen.queryByTestId("submodule-reference-refresh-traycer")).toBeNull();
  });
});
