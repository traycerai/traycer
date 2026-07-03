import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SubmoduleReferenceRowView } from "@/lib/git/git-repo-tree";
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
      submoduleHeadSha: "2222222222",
      diverged: true,
      commitChanged: false,
      modifiedContent: true,
      untrackedContent: false,
    },
    isConflicted: false,
    summary: "parent references 1111111 · checkout at 2222222",
    divergence: "diverged",
    repoRoot: "/repo/traycer",
    detailsUnavailable: false,
    ...overrides,
  };
}

describe("<SubmoduleReferenceRow />", () => {
  beforeEach(() => cleanup());

  it("navigates to the submodule node when it has a matching repoRoot", () => {
    const onSelect = vi.fn();
    render(
      <SubmoduleReferenceRow
        view={view({})}
        onSelect={onSelect}
        onRefresh={vi.fn()}
        isRefreshing={false}
      />,
    );
    expect(screen.getByText("Submodule reference:")).toBeDefined();
    expect(screen.getByText("traycer")).toBeDefined();
    expect(
      screen.getByText("parent references 1111111 · checkout at 2222222"),
    ).toBeDefined();
    const rowButton = screen.getByRole("button", {
      name: /Submodule reference:\s*traycer\s*parent references 1111111/,
    });
    expect(rowButton).toBeDefined();
    fireEvent.click(rowButton);
    expect(onSelect).toHaveBeenCalledWith("/repo/traycer");
  });

  it("keeps the visible pointer detail in the navigable row accessible name", () => {
    render(
      <SubmoduleReferenceRow
        view={view({})}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        isRefreshing={false}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: /parent references 1111111 .* checkout at 2222222/,
      }),
    ).toBeDefined();
  });

  it("renders the divergence status from the enriched pointer (both directions)", () => {
    const { rerender } = render(
      <SubmoduleReferenceRow
        view={view({ divergence: "diverged" })}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        isRefreshing={false}
      />,
    );
    expect(
      screen.getByText("Checkout differs from parent reference"),
    ).toBeDefined();
    rerender(
      <SubmoduleReferenceRow
        view={view({ divergence: "matches" })}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        isRefreshing={false}
      />,
    );
    expect(screen.getByText("Checkout matches parent reference")).toBeDefined();
  });

  it("shows the degrade warning on a still-navigable row (unavailable section)", () => {
    render(
      <SubmoduleReferenceRow
        view={view({ repoRoot: "/repo/traycer", detailsUnavailable: true })}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        isRefreshing={false}
      />,
    );
    // Navigable AND degraded: the row is a button and shows the warning.
    expect(
      screen.getByRole("button", {
        name: /Submodule reference:\s*traycer\s*parent references 1111111/,
      }),
    ).toBeDefined();
    expect(screen.getByText("Submodule details unavailable")).toBeDefined();
  });

  it("renders a non-navigable row when there is no matching submodule node", () => {
    render(
      <SubmoduleReferenceRow
        view={view({ repoRoot: null })}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        isRefreshing={false}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Submodule reference:")).toBeDefined();
  });

  it("surfaces the details-unavailable affordance with a working refresh", () => {
    const onRefresh = vi.fn();
    render(
      <SubmoduleReferenceRow
        view={view({ repoRoot: null, detailsUnavailable: true })}
        onSelect={vi.fn()}
        onRefresh={onRefresh}
        isRefreshing={false}
      />,
    );
    expect(screen.getByText("Submodule details unavailable")).toBeDefined();
    fireEvent.click(screen.getByTestId("submodule-reference-refresh-traycer"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("disables the details refresh while a refresh is in progress", () => {
    render(
      <SubmoduleReferenceRow
        view={view({ repoRoot: null, detailsUnavailable: true })}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        isRefreshing
      />,
    );
    expect(
      screen
        .getByTestId("submodule-reference-refresh-traycer")
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("renders a conflicted pointer under 'Reference needs attention'", () => {
    render(
      <SubmoduleReferenceRow
        view={view({
          repoRoot: null,
          isConflicted: true,
          divergence: null,
          pointer: {
            kind: "conflicted",
            baseSha: "bbbbbbbbbb",
            oursSha: "cccccccccc",
            theirsSha: "dddddddddd",
          },
          summary: "merge conflict on the submodule pointer (base bbbbbbb)",
        })}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        isRefreshing={false}
      />,
    );
    expect(screen.getByText("Reference needs attention")).toBeDefined();
    expect(screen.queryByText("Submodule reference:")).toBeNull();
    expect(
      screen.getByText(/merge conflict on the submodule pointer/),
    ).toBeDefined();
  });
});
