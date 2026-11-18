import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { trustedMarkupToReactNodes } from "@/lib/trusted-markup";

afterEach(() => {
  cleanup();
});

describe("trustedMarkupToReactNodes", () => {
  it("renders mermaid SVG that contains lenient HTML inside foreignObject", () => {
    const nodes = trustedMarkupToReactNodes(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">',
        '<foreignObject width="120" height="60">',
        '<div xmlns="http://www.w3.org/1999/xhtml">label<br></div>',
        "</foreignObject>",
        "</svg>",
      ].join(""),
      "svg",
    );

    const { container } = render(<div>{nodes}</div>);

    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("foreignObject")).not.toBeNull();
    expect(container.textContent).toContain("label");
  });

  it("strips active SVG content while keeping safe drawing nodes", () => {
    const nodes = trustedMarkupToReactNodes(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
        '<script>alert("x")</script>',
        '<rect width="10" height="10" onclick="alert(1)" />',
        "</svg>",
      ].join(""),
      "svg",
    );

    const { container } = render(<div>{nodes}</div>);
    const rect = container.querySelector("rect");

    expect(container.querySelector("script")).toBeNull();
    expect(rect).not.toBeNull();
    expect(rect?.getAttribute("onclick")).toBeNull();
  });
});
