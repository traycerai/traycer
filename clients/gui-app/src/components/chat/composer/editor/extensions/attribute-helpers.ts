import type { Attribute } from "@tiptap/core";

function htmlDataAttributeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return null;
}

export function dataAttributeMap(
  names: ReadonlyArray<string>,
): Record<string, Attribute> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute(`data-${name}`),
        renderHTML: (attributes: Record<string, unknown>) => {
          const value = htmlDataAttributeValue(attributes[name]);
          if (value === null) return {};
          return { [`data-${name}`]: value };
        },
      },
    ]),
  );
}

export const MENTION_ATTRIBUTE_NAMES: ReadonlyArray<string> = [
  "contextType",
  "id",
  "path",
  "pathKind",
  "relPath",
  "absolutePath",
  "workspacePath",
  "label",
  "description",
  "gitType",
  "branchName",
  "commitHash",
  "epicId",
  "artifactId",
  "artifactType",
  "chatId",
  "terminalAgentId",
  "terminalId",
  "status",
  // Browser tab reference (`ContextType.BrowserTab`). `url` is already listed
  // below for GitHub; the browser-tab arm reuses it for the tab's address.
  "tabId",
  "sessionId",
  // GitHub PR/issue references. These names are the protocol serializer's
  // (`MentionAttrs`), not local ones: `formatMentionForLLMQuery` reads them off
  // the submitted node by name to build `@github-pr:org/repo#N [url=…]`.
  "githubHost",
  "organizationLogin",
  "repositoryName",
  "issueNumber",
  "url",
];

export const SLASH_COMMAND_ATTRIBUTE_NAMES: ReadonlyArray<string> = [
  "commandName",
  "name",
  "id",
  "harnessId",
  "kind",
  "description",
  "argumentHint",
  "path",
  // Which character opened the picker. Display-only - it changes the chip's
  // label, never what the node serializes to.
  "trigger",
];

export const IMAGE_ATTACHMENT_ATTRIBUTE_NAMES: ReadonlyArray<string> = [
  "id",
  "fileName",
  "b64content",
  // Content hash of a persisted image. Editing an already-sent message loads its
  // hash-only node back into the editor; carrying `hash` through the schema lets
  // it round-trip to the host instead of being stripped (and the image lost).
  "hash",
  "mimeType",
  "size",
];
