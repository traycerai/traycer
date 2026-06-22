import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Section } from "../section";

describe("<Section />", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses equal-height flex sizing for expanded sections", () => {
    const { container } = render(
      <Section
        title="Working"
        count={3}
        summary={null}
        collapsed={false}
        onToggle={vi.fn()}
        actions={<button type="button">Action</button>}
      >
        <section aria-label="Rows">Rows</section>
      </Section>,
    );

    const section = container.firstElementChild;
    expect(section?.className).toContain("flex-1");
    expect(section?.className).toContain("basis-0");
    expect(
      screen.getByRole("region", { name: "Rows" }).parentElement?.className,
    ).toContain("overflow-hidden");
  });

  it("does not expand empty sections", () => {
    const { container } = render(
      <Section
        title="Staged"
        count={0}
        summary={null}
        collapsed={false}
        onToggle={vi.fn()}
        actions={<button type="button">Action</button>}
      >
        <section aria-label="Rows">Rows</section>
      </Section>,
    );

    const section = container.firstElementChild;
    expect(section?.className).toContain("flex-none");
    expect(screen.queryByRole("region", { name: "Rows" })).toBeNull();
  });

  it("keeps the file count on its own truncating track in the header", () => {
    render(
      <Section
        title="Working"
        count={12}
        summary={<span data-testid="stats">+595 -159</span>}
        collapsed={false}
        onToggle={vi.fn()}
        actions={<button type="button">Action</button>}
      >
        <section aria-label="Rows">Rows</section>
      </Section>,
    );

    const fileCount = screen.getByText("12 files");
    expect(fileCount.className).toContain("truncate");
    expect(fileCount.className).toContain("whitespace-nowrap");
    expect(screen.getByTestId("stats")).toBeDefined();
  });

  it("does not render a scroll body when collapsed", () => {
    const { container } = render(
      <Section
        title="Staged"
        count={0}
        summary={null}
        collapsed
        onToggle={vi.fn()}
        actions={<button type="button">Action</button>}
      >
        <section aria-label="Rows">Rows</section>
      </Section>,
    );

    const section = container.firstElementChild;
    expect(section?.className).toContain("flex-none");
    expect(screen.queryByRole("region", { name: "Rows" })).toBeNull();
  });
});
