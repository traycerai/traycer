import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffTabShell } from "../diff-tab-shell";

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
