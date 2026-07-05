import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TraycerMarkdown } from "@/markdown/traycer-markdown";

const STREAMING_CONTENT = [
  "# Title",
  "",
  "Stable paragraph.",
  "",
  "Tail paragraph.",
].join("\n");

function renderMarkdown(content: string, isStreaming: boolean) {
  return render(
    <TraycerMarkdown
      className={null}
      proseSize="normal"
      components={null}
      remarkPlugins={null}
      rehypePlugins={null}
      quotable={false}
      isStreaming={isStreaming}
    >
      {content}
    </TraycerMarkdown>,
  );
}

describe("<TraycerMarkdown /> quote markers", () => {
  afterEach(() => {
    cleanup();
  });

  it("wraps only blocks at or after the frozen-prefix boundary while streaming", () => {
    const { container } = renderMarkdown(STREAMING_CONTENT, true);

    expect(container.querySelectorAll("[data-md-unstable]")).toHaveLength(1);
    expect(
      screen
        .getByRole("heading", { name: "Title" })
        .closest("[data-md-unstable]"),
    ).toBeNull();
    expect(
      screen.getByText("Stable paragraph.").closest("[data-md-unstable]"),
    ).toBeNull();

    const tailWrapper = screen
      .getByText("Tail paragraph.")
      .closest<HTMLElement>("[data-md-unstable]");
    expect(tailWrapper).not.toBeNull();
    expect(tailWrapper?.className).toContain("contents");
  });

  it("removes every unstable-tail wrapper after streaming completes", () => {
    const { container, rerender } = renderMarkdown(STREAMING_CONTENT, true);

    expect(container.querySelectorAll("[data-md-unstable]")).toHaveLength(1);

    rerender(
      <TraycerMarkdown
        className={null}
        proseSize="normal"
        components={null}
        remarkPlugins={null}
        rehypePlugins={null}
        quotable={false}
        isStreaming={false}
      >
        {STREAMING_CONTENT}
      </TraycerMarkdown>,
    );

    expect(container.querySelectorAll("[data-md-unstable]")).toHaveLength(0);
  });
});
