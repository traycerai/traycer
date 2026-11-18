import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DiffTabHeaderPortal, DiffTabShell } from "../diff-tab-shell";

afterEach(cleanup);

describe("DiffTabShell", () => {
  it("renders title in header", () => {
    render(
      <DiffTabShell
        primaryTitle="test-file.tsx"
        secondaryLine="src · Working"
        contextLabel="traycer · main"
        toolbar={<div>Toolbar</div>}
      >
        <div>Content</div>
      </DiffTabShell>,
    );

    expect(screen.getByText("test-file.tsx")).toBeTruthy();
    expect(screen.getByText("src · Working")).toBeTruthy();
    expect(screen.getByText("traycer · main")).toBeTruthy();
  });

  it("renders toolbar in header", () => {
    render(
      <DiffTabShell
        primaryTitle="test-file.tsx"
        secondaryLine={null}
        contextLabel={null}
        toolbar={<div data-testid="test-toolbar">Toolbar Content</div>}
      >
        <div>Content</div>
      </DiffTabShell>,
    );

    expect(screen.getByTestId("test-toolbar")).toBeTruthy();
  });

  it("places descendant header accessories beside the toolbar", () => {
    render(
      <DiffTabShell
        primaryTitle="test-file.tsx"
        secondaryLine={null}
        contextLabel={null}
        toolbar={<div data-testid="test-toolbar">Toolbar</div>}
      >
        <DiffTabHeaderPortal>
          <span data-testid="test-status">Saved</span>
        </DiffTabHeaderPortal>
      </DiffTabShell>,
    );

    const accessory = screen.getByTestId("diff-tab-header-accessory");
    expect(accessory.contains(screen.getByTestId("test-status"))).toBe(true);
    expect(accessory.nextElementSibling).toBe(
      screen.getByTestId("test-toolbar"),
    );
  });

  it("renders children in main content area", () => {
    render(
      <DiffTabShell
        primaryTitle="test-file.tsx"
        secondaryLine={null}
        contextLabel={null}
        toolbar={<div>Toolbar</div>}
      >
        <div data-testid="test-content">Main Content</div>
      </DiffTabShell>,
    );

    expect(screen.getByTestId("test-content")).toBeTruthy();
  });

  it("truncates long titles with truncate class", () => {
    const longTitle = "very-long-file-name-that-should-be-truncated.tsx";
    render(
      <DiffTabShell
        primaryTitle={longTitle}
        secondaryLine={null}
        contextLabel={null}
        toolbar={<div>Toolbar</div>}
      >
        <div>Content</div>
      </DiffTabShell>,
    );

    const titleElement = screen.getByText(longTitle);
    expect(titleElement.className).toContain("truncate");
  });

  it("has flex layout for h-full container", () => {
    const { container } = render(
      <DiffTabShell
        primaryTitle="test.tsx"
        secondaryLine={null}
        contextLabel={null}
        toolbar={<div>Toolbar</div>}
      >
        <div>Content</div>
      </DiffTabShell>,
    );

    const shell = container.firstChild as HTMLElement;
    expect(shell.className).toContain("flex");
    expect(shell.className).toContain("h-full");
    expect(shell.className).toContain("flex-col");
  });
});
