import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TraycerMarkdown } from "@/markdown/traycer-markdown";
import { lexMarkdownBlocks } from "@/markdown/use-markdown-blocks";

/**
 * Raw-HTML block containers written around markdown - GitHub's
 * `<details><summary>` disclosure above all - must render as ONE block.
 *
 * CommonMark ends a raw-HTML block at the first blank line, so `marked` emits
 * the opening tag, the body and the closing tag as separate top-level tokens.
 * `TraycerMarkdown` renders every block through its own `react-markdown`
 * pipeline, so unmerged tokens leave the body as a SIBLING of the `<details>`
 * element - which is why the disclosure toggle appeared to do nothing on PR
 * descriptions and comments.
 */

function renderMarkdown(content: string) {
  return render(
    <TraycerMarkdown
      className={null}
      proseSize="normal"
      components={null}
      remarkPlugins={null}
      rehypePlugins={null}
      quotable={false}
      isStreaming={false}
    >
      {content}
    </TraycerMarkdown>,
  );
}

function blockRaws(content: string): string[] {
  return lexMarkdownBlocks(null, content).blocks.map((block) => block.raw);
}

const DETAILS_DOC = [
  "<details>",
  "<summary>Show the trace</summary>",
  "",
  "Some **body** text.",
  "",
  "- first",
  "- second",
  "",
  "</details>",
  "",
  "After the disclosure.",
].join("\n");

describe("markdown raw-HTML container blocks", () => {
  afterEach(() => {
    cleanup();
  });

  it("merges a blank-line-split <details> span into one block", () => {
    const raws = blockRaws(DETAILS_DOC);

    expect(raws).toHaveLength(2);
    expect(raws[0]).toContain("<details>");
    expect(raws[0]).toContain("Some **body** text.");
    expect(raws[0]).toContain("</details>");
    expect(raws[1]).toBe("After the disclosure.");
  });

  it("keeps the merged block's raw byte-identical to its source span", () => {
    const [merged] = blockRaws(DETAILS_DOC);

    expect(DETAILS_DOC.startsWith(merged)).toBe(true);
  });

  it("nests the body inside the <details> element when rendered", () => {
    const { container } = renderMarkdown(DETAILS_DOC);

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toBe(
      "Show the trace",
    );
    // The whole point: body markdown is a DESCENDANT, so the native
    // disclosure hides it when closed instead of rendering it alongside.
    expect(details?.querySelector("p")?.textContent).toBe("Some body text.");
    expect(details?.contains(screen.getByText("first"))).toBe(true);
    // Content after the container stays outside it.
    expect(details?.contains(screen.getByText("After the disclosure."))).toBe(
      false,
    );
  });

  it("renders body markdown as markdown, not literal text", () => {
    const { container } = renderMarkdown(DETAILS_DOC);

    expect(container.querySelector("details strong")?.textContent).toBe("body");
    expect(container.querySelectorAll("details li")).toHaveLength(2);
  });

  it("leaves a container with no matching close unmerged", () => {
    // An unclosed `<div>` must not swallow the rest of the document into a
    // single block - that would defeat per-block memoization while streaming.
    const raws = blockRaws(
      ["<div>", "", "Body paragraph.", "", "Another paragraph."].join("\n"),
    );

    expect(raws).toEqual(["<div>", "Body paragraph.", "Another paragraph."]);
  });

  it("merges to the OUTER close when containers nest", () => {
    const raws = blockRaws(
      [
        "<details>",
        "<summary>Outer</summary>",
        "",
        "<div>",
        "",
        "Inner body.",
        "",
        "</div>",
        "",
        "</details>",
        "",
        "Tail.",
      ].join("\n"),
    );

    expect(raws).toHaveLength(2);
    expect(raws[0]).toContain("</details>");
    expect(raws[1]).toBe("Tail.");
  });

  it("ignores tags inside HTML comments when balancing", () => {
    const raws = blockRaws(
      [
        "<details>",
        "<summary>With a comment</summary>",
        "<!-- <div> a commented-out opener -->",
        "",
        "Body.",
        "",
        "</details>",
      ].join("\n"),
    );

    expect(raws).toHaveLength(1);
    expect(raws[0]).toContain("Body.");
  });

  it("does not merge a self-contained single-token container", () => {
    const raws = blockRaws(
      ["<div>inline body</div>", "", "Next paragraph."].join("\n"),
    );

    expect(raws).toEqual(["<div>inline body</div>", "Next paragraph."]);
  });
});
