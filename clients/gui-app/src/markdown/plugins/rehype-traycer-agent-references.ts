import type { Element, Root, Text } from "hast";
import { visit } from "unist-util-visit";
import { TRAYCER_AGENT_TAG } from "./const";

const UUID_REFERENCE_TOKEN_PATTERN =
  /(?<![0-9a-f-])[0-9a-f][0-9a-f-]{7,35}(?![0-9a-f-])/gi;
const UUID_REFERENCE_SHAPE =
  /^[0-9a-f]{8}(?:-[0-9a-f]{0,4})?(?:-[0-9a-f]{0,4})?(?:-[0-9a-f]{0,4})?(?:-[0-9a-f]{0,12})?$/i;
const UUID_REFERENCE_MIN_LENGTH = 8;

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
  if (value.length < UUID_REFERENCE_MIN_LENGTH) return null;
  UUID_REFERENCE_TOKEN_PATTERN.lastIndex = 0;
  const nodes: Array<Text | Element> = [];
  let cursor = 0;

  for (const match of value.matchAll(UUID_REFERENCE_TOKEN_PATTERN)) {
    const agentId = match[0];
    if (!isUuidReferenceCandidate(agentId)) continue;
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

export function isUuidReferenceCandidate(value: string): boolean {
  return UUID_REFERENCE_SHAPE.test(value);
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
