import type { Element, Root, Text } from "hast";
import { visit } from "unist-util-visit";
import { TRAYCER_AGENT_TAG } from "./const";

const AGENT_ID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const AGENT_ID_LENGTH = 36;

export function rehypeTraycerAgentReferences() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (parent === undefined || index === undefined) return;
      if (
        "tagName" in parent &&
        (parent.tagName === "code" ||
          parent.tagName === "a" ||
          parent.tagName === TRAYCER_AGENT_TAG)
      ) {
        return;
      }

      const parts = splitAgentReferenceText(node.value);
      if (parts === null) return;
      parent.children.splice(index, 1, ...parts);
    });

    return tree;
  };
}

function splitAgentReferenceText(value: string): Array<Text | Element> | null {
  if (value.length < AGENT_ID_LENGTH || !value.includes("-")) return null;
  AGENT_ID_PATTERN.lastIndex = 0;
  const nodes: Array<Text | Element> = [];
  let cursor = 0;

  for (const match of value.matchAll(AGENT_ID_PATTERN)) {
    const agentId = match[0];
    const start = match.index;
    if (start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, start) });
    }
    nodes.push(agentReferenceElement(agentId, "text"));
    cursor = start + agentId.length;
  }

  if (nodes.length === 0) return null;
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

export function agentReferenceElement(
  agentId: string,
  display: "text" | "code",
): Element {
  return {
    type: "element",
    tagName: TRAYCER_AGENT_TAG,
    properties: {
      "data-agent-id": agentId,
      "data-display": display,
    },
    children: [{ type: "text", value: agentId }],
  };
}
