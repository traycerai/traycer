import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

describe("artifact serialization memory", () => {
  it("preserves multi-megabyte text and escapes within a bounded V8 heap", () => {
    // Run the actual serializer in Node, not the test runner's shared heap.
    // Before bounded output batches, 8 MiB of plain text exhausts this heap
    // because both text passes retain a cons-string node per character.
    const built = buildSync({
      entryPoints: [
        fileURLToPath(
          new URL("../json-content-serializer.ts", import.meta.url),
        ),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
    });
    const source = built.outputFiles[0];
    if (source === undefined) throw new Error("Serializer bundle missing");

    const output = execFileSync(
      process.execPath,
      ["--max-old-space-size=192", "--input-type=module"],
      {
        input:
          source.text +
          `
          const options = { mentionFormat: "llm", platform: "POSIX" };
          const cases = [
            ["a".repeat(8 * 1024 * 1024), undefined],
            ["*".repeat(4 * 1024 * 1024), undefined],
            ["- item\\n".repeat(128 * 1024), undefined],
            ["a".repeat(8 * 1024 * 1024), [{ type: "code" }]],
          ];
          for (const [text, marks] of cases) {
            const doc = { type: "doc", content: [{ type: "paragraph", content: [
              { type: "text", text, ...(marks ? { marks } : {}) },
            ] }] };
            const actual = jsonContentToArtifactMarkdown(doc, options);
            const expected = marks ? "\u0060" + text + "\u0060"
              : text[0] === "*" ? "\\\\*".repeat(text.length)
              : text[0] === "-" ? text.replaceAll("- item", "\\\\- item").trimEnd()
              : text;
            if (actual !== expected) throw new Error("Artifact text changed");
          }
          console.log("all cases preserved");
        `,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      },
    );
    expect(output.trim()).toBe("all cases preserved");
  });
});
