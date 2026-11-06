/**
 * `rehypeTraycerArtifactReferences` must claim a whole
 * `epics/<id>/artifacts/...` path before `rehypeTraycerAgentReferences` can
 * read the embedded epic id inside it as an agent/task reference. Run through
 * the REAL unified pipeline (no mocks) so these assert actual hast output,
 * not a model of it.
 */
import type { Element, Root, Text } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";
import { extractTextContent } from "@/markdown/plugins/hast-utils";
import { rehypeBotMentions } from "@/markdown/plugins/rehype-bot-mentions";
import { rehypeTraycerArtifactReferences } from "@/markdown/plugins/rehype-traycer-artifact-references";
import { rehypeTraycerAgentReferences } from "@/markdown/plugins/rehype-traycer-agent-references";
import {
  TRAYCER_AGENT_TAG,
  TRAYCER_ARTIFACT_PATH_TAG,
} from "@/markdown/plugins/const";

const EPIC_ID = "4f14b1e2-9c3a-4b7d-8e21-7a2c5d6f9b10";
const ARTIFACT_PATH = `/Users/tgill/.traycer/epics/${EPIC_ID}/artifacts/md-objects-t2-degraded-strip/screenshots/index.html`;

/** The current, fixed production order (`AgentReferenceMarkdown`'s rehype set). */
async function runFixed(markdown: string): Promise<Root> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeBotMentions)
    .use(rehypeTraycerArtifactReferences)
    .use(rehypeTraycerAgentReferences);
  return processor.run(processor.parse(markdown));
}

function elementsOfTag(tree: Root, tagName: string): Element[] {
  const found: Element[] = [];
  visit(tree, "element", (node: Element) => {
    if (node.tagName === tagName) found.push(node);
  });
  return found;
}

describe("rehypeTraycerArtifactReferences claims the whole path first", () => {
  it("claims a bare path in prose as one reference, leaving sentence punctuation outside it", async () => {
    const markdown = `See ${ARTIFACT_PATH}.`;
    const tree = await runFixed(markdown);

    const refs = elementsOfTag(tree, TRAYCER_ARTIFACT_PATH_TAG);
    expect(refs).toHaveLength(1);
    expect(refs[0].properties["data-artifact-path"]).toBe(ARTIFACT_PATH);
    expect(extractTextContent(refs[0].children)).toBe(ARTIFACT_PATH);
    // The embedded epic id is inside the claimed reference, not a sibling
    // chip of its own.
    expect(elementsOfTag(tree, TRAYCER_AGENT_TAG)).toEqual([]);

    const neighbours: Array<{ before: Text | null; after: Text | null }> = [];
    visit(tree, "element", (node: Element, index, parent) => {
      if (
        node.tagName !== TRAYCER_ARTIFACT_PATH_TAG ||
        parent === undefined ||
        index === undefined
      ) {
        return;
      }
      const prev = index > 0 ? parent.children[index - 1] : null;
      const next =
        index + 1 < parent.children.length ? parent.children[index + 1] : null;
      neighbours.push({
        before: prev !== null && prev.type === "text" ? prev : null,
        after: next !== null && next.type === "text" ? next : null,
      });
    });
    expect(neighbours).toHaveLength(1);
    const { before, after } = neighbours[0];
    if (before === null || after === null) {
      throw new Error("expected text siblings around the reference");
    }
    expect(before.value).toBe("See ");
    expect(after.value).toBe(".");
  });

  it("claims a path quoted in inline code", async () => {
    const markdown = `Open \`${ARTIFACT_PATH}\``;
    const tree = await runFixed(markdown);

    const refs = elementsOfTag(tree, TRAYCER_ARTIFACT_PATH_TAG);
    expect(refs).toHaveLength(1);
    expect(refs[0].properties["data-artifact-path"]).toBe(ARTIFACT_PATH);
    // The `code` element itself became the reference - it is not left
    // wrapping an untouched reference inside it.
    expect(elementsOfTag(tree, "code")).toEqual([]);
  });

  it("claims a markdown link's href and keeps the authored label", async () => {
    const markdown = `[the screenshot](${ARTIFACT_PATH})`;
    const tree = await runFixed(markdown);

    const refs = elementsOfTag(tree, TRAYCER_ARTIFACT_PATH_TAG);
    expect(refs).toHaveLength(1);
    expect(refs[0].properties["data-artifact-path"]).toBe(ARTIFACT_PATH);
    expect(extractTextContent(refs[0].children)).toBe("the screenshot");
  });

  it("excludes a path inside a fenced code block", async () => {
    const markdown = "```\n" + ARTIFACT_PATH + "\n```";
    const tree = await runFixed(markdown);

    expect(elementsOfTag(tree, TRAYCER_ARTIFACT_PATH_TAG)).toEqual([]);
    const pre = elementsOfTag(tree, "pre");
    expect(pre).toHaveLength(1);
    expect(extractTextContent(pre[0].children)).toBe(`${ARTIFACT_PATH}\n`);
  });

  it("excludes a web URL that happens to contain the same marker shape", async () => {
    const markdown = `See https://example.com/epics/${EPIC_ID}/artifacts/foo/index.html for details.`;
    const tree = await runFixed(markdown);

    expect(elementsOfTag(tree, TRAYCER_ARTIFACT_PATH_TAG)).toEqual([]);
  });
});
