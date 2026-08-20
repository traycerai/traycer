import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLASSIFIED_NODE_TYPES_FOR_TESTS,
  classifyContentRecovery,
} from "@/lib/composer/content-recovery";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `json-content-serializer` is the authoritative enumeration of the node kinds
 * that reach an agent, and `tiptap-json-content`'s projection is what the
 * recovery statement can actually carry. Every kind either enumeration names
 * has to be classified, or the notice can silently present a partial recovery
 * as a whole one - the defect that shipped three times running (attachments,
 * mentions, sourced quotes) before the classification existed.
 */
describe("content recovery classification", () => {
  it("classifies every node kind the serializer enumerates", () => {
    const source = readFileSync(
      resolve(
        HERE,
        "../../../../../../protocol/src/common/json-content-serializer.ts",
      ),
      "utf8",
    );
    const switchBody = source.slice(source.indexOf("switch (node.type)"));
    const enumerated = [
      ...switchBody
        .slice(0, switchBody.indexOf("\n  }"))
        .matchAll(/case "([^"]+)":/g),
    ].map((match) => match[1]);

    expect(enumerated.length).toBeGreaterThan(10);
    const unclassified = enumerated.filter(
      (type) => !CLASSIFIED_NODE_TYPES_FOR_TESTS.has(type),
    );
    expect(unclassified).toEqual([]);
  });

  it("classifies every node kind the text projection names", () => {
    const source = readFileSync(
      resolve(HERE, "../tiptap-json-content.ts"),
      "utf8",
    );
    const projection = source.slice(
      source.indexOf("function plainTextFromNode("),
    );
    const named = [
      ...projection
        .slice(0, projection.indexOf("\n}"))
        .matchAll(/node\.type === "([^"]+)"/g),
    ].map((match) => match[1]);

    expect(named.length).toBeGreaterThan(4);
    const unclassified = named.filter(
      (type) => !CLASSIFIED_NODE_TYPES_FOR_TESTS.has(type),
    );
    expect(unclassified).toEqual([]);
  });

  it("fails closed on a kind nobody has classified", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [{ type: "someFutureEmbed" }],
    });

    expect(report.get("unknown")).toBe(1);
  });

  it("counts a loss nested inside another lossy node", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "sourcedQuote",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "mention",
                  attrs: { contextType: "file", path: "a.ts" },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(report.get("quote")).toBe(1);
    expect(report.get("mention")).toBe(1);
  });

  it("reports nothing for ordinary prose", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "just words" }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(report.size).toBe(0);
  });
});
