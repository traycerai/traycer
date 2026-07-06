import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "@/markdown/components/code-block";

const highlightState = vi.hoisted((): { nodes: ReactNode | null } => ({
  nodes: null,
}));

vi.mock("@/markdown/shiki-highlighter", () => ({
  useShikiHighlighter: () => ({
    highlighter: null,
    theme: "github-dark",
    themesVersion: 0,
  }),
}));

vi.mock("@/markdown/use-throttled-code-highlight", () => ({
  useThrottledCodeHighlight: () => highlightState.nodes,
}));

describe("<CodeBlock /> quote hooks", () => {
  afterEach(() => {
    highlightState.nodes = null;
    cleanup();
  });

  it("adds quote code-block hooks on the highlighted DOM path", () => {
    highlightState.nodes = <span data-testid="highlighted">highlighted</span>;

    render(<CodeBlock className="language-ts">{"const x = 1;\n"}</CodeBlock>);

    const root = screen
      .getByTestId("highlighted")
      .closest<HTMLElement>("[data-quote-code-block]");
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-language")).toBe("ts");
    expect(root?.querySelector("pre")).toBeNull();
  });

  it("adds quote code-block hooks on the plain fallback DOM path", () => {
    render(
      <CodeBlock className="language-haskell">
        {'main = putStrLn "hi"\n'}
      </CodeBlock>,
    );

    const root = screen
      .getByText('main = putStrLn "hi"')
      .closest<HTMLElement>("[data-quote-code-block]");
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-language")).toBe("haskell");
    expect(root?.querySelector("pre")).not.toBeNull();
  });

  it("keeps a plain fence marked with an empty language", () => {
    render(<CodeBlock className={undefined}>{"plain fence\n"}</CodeBlock>);

    const root = screen
      .getByText("plain fence")
      .closest<HTMLElement>("[data-quote-code-block]");
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-language")).toBe("");
  });
});
