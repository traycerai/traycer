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
const BOT_ID = "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M0";
// The task id is an agent-shaped UUID as well.
const TASK_ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

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

  it("makes a bot token and a task token mentions carrying their own id, and no agent of the task's UUID", async () => {
    const { mentions, agents } = await elementsOf(
      `ask <#${BOT_ID}> about <~${TASK_ID}>`,
    );

    expect(
      mentions.map((mention) => [mention.properties, mention.children]),
    ).toEqual([
      [{ "data-bot-id": BOT_ID }, [{ type: "text", value: `<#${BOT_ID}>` }]],
      [{ "data-task-id": TASK_ID }, [{ type: "text", value: `<~${TASK_ID}>` }]],
    ]);
    expect(agents).toEqual([]);
  });

  it("leaves text that only looks like a bot or task token as written", async () => {
    const { mentions } = await elementsOf(
      `<#include> <#bot_01HZY8V6K3Q9W2E4R5T6Y7U8M0> <~${TASK_ID.slice(1)}>`,
    );

    expect(mentions).toEqual([]);
  });

  it("leaves a bot and a task token in code as written", async () => {
    const { mentions } = await elementsOf(`\`<#${BOT_ID}> <~${TASK_ID}>\``);

    expect(mentions).toEqual([]);
  });
});
