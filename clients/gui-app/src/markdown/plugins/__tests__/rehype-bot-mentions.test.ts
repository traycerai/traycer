import type { Element } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";
import { rehypeBotMentions } from "@/markdown/plugins/rehype-bot-mentions";
import { rehypeTraycerAgentReferences } from "@/markdown/plugins/rehype-traycer-agent-references";
import {
  TRAYCER_AGENT_TAG,
  TRAYCER_MENTION_TAG,
} from "@/markdown/plugins/const";

// The user id is shaped like an agent id on purpose.
const USER_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const AGENT_ID = "11111111-2222-3333-4444-555555555555";

async function elementsOf(markdown: string): Promise<{
  mentions: Element[];
  agents: Element[];
}> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeBotMentions)
    .use(rehypeTraycerAgentReferences);
  const tree = await processor.run(processor.parse(markdown));
  const mentions: Element[] = [];
  const agents: Element[] = [];
  visit(tree, "element", (node: Element) => {
    if (node.tagName === TRAYCER_MENTION_TAG) mentions.push(node);
    if (node.tagName === TRAYCER_AGENT_TAG) agents.push(node);
  });
  return { mentions, agents };
}

describe("rehypeBotMentions with the agent-reference pass", () => {
  it("makes a mention of a token and does not read the id inside it as an agent", async () => {
    const { mentions, agents } = await elementsOf(`hi <@${USER_ID}> there`);

    expect(mentions).toHaveLength(1);
    expect(mentions[0].properties["data-user-id"]).toBe(USER_ID);
    expect(agents).toEqual([]);
  });

  it("still reads an agent id outside a token as an agent", async () => {
    const { mentions, agents } = await elementsOf(
      `<@${USER_ID}> asked ${AGENT_ID}`,
    );

    expect(mentions).toHaveLength(1);
    expect(agents).toHaveLength(1);
  });

  it("leaves a token in code as written", async () => {
    const { mentions } = await elementsOf(`\`<@${USER_ID}>\``);

    expect(mentions).toEqual([]);
  });
});
