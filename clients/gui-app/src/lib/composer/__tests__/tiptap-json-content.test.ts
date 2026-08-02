import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  buildSubmittedChatJSONContent,
  extractPlainTextFromComposerJSONContent,
  type SlashCommandCatalog,
} from "@/lib/composer/tiptap-json-content";
import type { SlashCommand } from "@/lib/composer/types";

describe("extractPlainTextFromComposerJSONContent blockquote handling", () => {
  it("emits '> '-prefixed lines for a multi-paragraph quote", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "first line" }],
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: "second line" }],
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "reply" }],
        },
      ],
    };

    expect(extractPlainTextFromComposerJSONContent(content)).toBe(
      ["> first line", "> second line", "reply"].join("\n"),
    );
  });

  it("emits a bare '>' for an empty line inside the quote", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "quoted" }],
            },
            { type: "paragraph" },
          ],
        },
      ],
    };

    expect(extractPlainTextFromComposerJSONContent(content)).toBe(
      ["> quoted", ">"].join("\n"),
    );
  });
});

// The slash picker classifies a command as "leading" by asking what the
// provider's parser will see, not by where the chip sits in the document. That
// only holds while an attachment-only block contributes nothing to the prompt -
// if it ever serialized to a blank line instead of being dropped, a native
// command below it would stop being leading and the picker would silently
// offer commands the provider then refuses.
describe("extractPlainTextFromComposerJSONContent attachment blocks", () => {
  it("drops an attachment-only block so a following command stays leading", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "imageAttachment", attrs: { imageId: "img-1" } }],
        },
        {
          type: "paragraph",
          content: [
            { type: "slashCommand", attrs: { commandName: "plan" } },
            { type: "text", text: " ship it" },
          ],
        },
      ],
    };

    expect(extractPlainTextFromComposerJSONContent(content)).toBe(
      "/plan ship it",
    );
  });

  // The mirror of the case above, and the reason a blockquote can never be
  // skipped the way an attachment block is: `quotePrefixLines` emits a bare `>`
  // for a blank line, so even a visually empty quote puts a character in front
  // of the command and the provider stops seeing a leading slash.
  it("keeps a '>' for a blank quote so a following command is not leading", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "hardBreak" }] }],
        },
        {
          type: "paragraph",
          content: [{ type: "slashCommand", attrs: { commandName: "plan" } }],
        },
      ],
    };

    expect(extractPlainTextFromComposerJSONContent(content)).toBe(
      ">\n>\n/plan",
    );
  });
});

// Raw text reaches this converter from paths that never touch the editor - a
// next-step click, a "compact" action, an inline-edit resubmit. Both picker
// triggers have to chip here, because the host resolves an invocation either
// structurally (off a `slashCommand` node's `kind`) or off a leading `/name` in
// the prompt text. A `$name` left as prose is neither, so the skill would
// silently never run.
//
// The catalog is what separates a real command from prose. `$` leads ordinary
// English constantly, so it chips ONLY on a hit; `/` keeps its older ungated
// lexical fallback, since a message opening with `/word` is a command by
// convention and the provider parses it that way regardless.
describe("buildSubmittedChatJSONContent leading trigger", () => {
  const SKILL: SlashCommand = {
    harnessId: "claude",
    name: "frontend-design",
    description: "Use frontend-design",
    argumentHint: null,
    kind: "skill",
    metadata: { path: "/repo/.agents/skills/frontend-design/SKILL.md" },
    source: "provider",
    preview: {
      kind: "text",
      primary: "Use frontend-design",
      secondary: null,
      mono: false,
    },
  };
  const NATIVE: SlashCommand = {
    harnessId: "claude",
    name: "plan",
    description: "Plan something",
    argumentHint: null,
    kind: "slash-command",
    metadata: {},
    source: "provider",
    preview: {
      kind: "text",
      primary: "Plan something",
      secondary: null,
      mono: false,
    },
  };
  const CATALOG: SlashCommandCatalog = new Map([
    ["frontend-design", SKILL],
    ["plan", NATIVE],
  ]);

  function submittedDoc(
    prompt: string,
    catalog: SlashCommandCatalog | null,
  ): JsonContent {
    return buildSubmittedChatJSONContent(
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: prompt }] },
        ],
      },
      catalog,
    );
  }

  function submittedParagraph(
    prompt: string,
    catalog: SlashCommandCatalog | null,
  ): ReadonlyArray<JsonContent> {
    return submittedDoc(prompt, catalog).content?.[0].content ?? [];
  }

  it("chips a resolved leading $skill with the option's kind and path", () => {
    // `kind` is the load-bearing attribute: the host reads skills off it, and
    // the editor's leading guard only tolerates a kindless chip at the start.
    expect(
      submittedParagraph("$frontend-design polish the header", CATALOG),
    ).toEqual([
      {
        type: "slashCommand",
        attrs: {
          commandName: "frontend-design",
          harnessId: "claude",
          kind: "skill",
          description: "Use frontend-design",
          argumentHint: null,
          path: "/repo/.agents/skills/frontend-design/SKILL.md",
          trigger: "$",
        },
      },
      { type: "text", text: " polish the header" },
    ]);
  });

  it("keeps the canonical /name on the wire for a $-written chip", () => {
    // The trigger is display-only. Everything downstream of the composer - the
    // host's `parseProviderSlashPrompt` included - still sees `/name`.
    expect(
      extractPlainTextFromComposerJSONContent(
        submittedDoc("$frontend-design polish the header", CATALOG),
      ),
    ).toBe("/frontend-design polish the header");
  });

  it("chips a bare $skill with no arguments", () => {
    expect(submittedParagraph("$frontend-design", CATALOG)).toEqual([
      {
        type: "slashCommand",
        attrs: {
          commandName: "frontend-design",
          harnessId: "claude",
          kind: "skill",
          description: "Use frontend-design",
          argumentHint: null,
          path: "/repo/.agents/skills/frontend-design/SKILL.md",
          trigger: "$",
        },
      },
    ]);
  });

  // The regression this gate exists for: `$` opens ordinary prose all the time,
  // and every one of these bodies fits the command-name grammar. Chipping them
  // would rewrite the user's own words into `/20 ...` on the wire.
  it.each([
    ["$20 for the migration", "a price"],
    ["$100k of ARR", "a larger price"],
    ["$PATH is wrong", "a shell variable"],
    ["$not-a-command do the thing", "an unknown name"],
  ])("leaves %s as plain text (%s)", (prompt) => {
    expect(submittedParagraph(prompt, CATALOG)).toEqual([
      { type: "text", text: prompt },
    ]);
  });

  it("leaves a $skill as plain text when the catalog has not loaded", () => {
    expect(
      submittedParagraph("$frontend-design polish the header", null),
    ).toEqual([{ type: "text", text: "$frontend-design polish the header" }]);
  });

  it("enriches a resolved leading /command from the catalog too", () => {
    expect(submittedParagraph("/plan ship it", CATALOG)).toEqual([
      {
        type: "slashCommand",
        attrs: {
          commandName: "plan",
          harnessId: "claude",
          kind: "slash-command",
          description: "Plan something",
          argumentHint: null,
          path: null,
          trigger: "/",
        },
      },
      { type: "text", text: " ship it" },
    ]);
  });

  it("keeps the bare lexical /command chip when the catalog has not loaded", () => {
    // Long-standing behavior, deliberately preserved: an unresolved `/word` is
    // still a command by convention. The host re-resolves it by name.
    expect(submittedParagraph("/plan ship it", null)).toEqual([
      { type: "slashCommand", attrs: { commandName: "plan", trigger: "/" } },
      { type: "text", text: " ship it" },
    ]);
  });

  it("leaves a $ followed by a space alone", () => {
    expect(submittedParagraph("$ 20 for the migration", CATALOG)).toEqual([
      { type: "text", text: "$ 20 for the migration" },
    ]);
  });

  it("chips a $skill written after leading spaces, keeping the indent", () => {
    // The editor treats a command after leading spaces as leading and the host
    // trims the prompt, so this is a real command - it just must not silently
    // lose the user's whitespace on the way to becoming a chip.
    expect(
      submittedParagraph("   $frontend-design polish this", CATALOG),
    ).toEqual([
      { type: "text", text: "   " },
      {
        type: "slashCommand",
        attrs: {
          commandName: "frontend-design",
          harnessId: "claude",
          kind: "skill",
          description: "Use frontend-design",
          argumentHint: null,
          path: "/repo/.agents/skills/frontend-design/SKILL.md",
          trigger: "$",
        },
      },
      { type: "text", text: " polish this" },
    ]);
  });

  // Formatting splits a run into separate text nodes, so a token can look
  // complete at a node boundary while the prompt reads `/frontend-designer`.
  // Chipping the prefix would be WORSE than not converting: the structural node
  // says `frontend-design` and the wrong skill runs, where prose would have let
  // the host resolve the full name.
  it("does not chip a leading token that an adjacent text node continues", () => {
    const doc = buildSubmittedChatJSONContent(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "$frontend-design",
                marks: [{ type: "bold" }],
              },
              { type: "text", text: "er the header" },
            ],
          },
        ],
      },
      CATALOG,
    );

    expect(doc.content?.[0].content).toEqual([
      { type: "text", text: "$frontend-design", marks: [{ type: "bold" }] },
      { type: "text", text: "er the header" },
    ]);
  });

  // The mirror of the case above: a split run whose FIRST node is only the
  // indent. The editor and the host both treat those spaces as transparent, so
  // the trigger in the next node is still leading and must still be examined.
  it("looks past a whitespace-only node to the trigger that follows", () => {
    const doc = buildSubmittedChatJSONContent(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "   ", marks: [{ type: "bold" }] },
              { type: "text", text: "$frontend-design polish this" },
            ],
          },
        ],
      },
      CATALOG,
    );

    expect(doc.content?.[0].content).toEqual([
      { type: "text", text: "   ", marks: [{ type: "bold" }] },
      {
        type: "slashCommand",
        attrs: {
          commandName: "frontend-design",
          harnessId: "claude",
          kind: "skill",
          description: "Use frontend-design",
          argumentHint: null,
          path: "/repo/.agents/skills/frontend-design/SKILL.md",
          trigger: "$",
        },
      },
      { type: "text", text: " polish this" },
    ]);
  });

  // A whitespace-only node is transparent, but a hard break is not: it ends the
  // line, so anything after it is no longer the leading token.
  it("still refuses a trigger that a hard break pushes onto the next line", () => {
    const doc = buildSubmittedChatJSONContent(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "  " },
              { type: "hardBreak" },
              { type: "text", text: "$frontend-design polish this" },
            ],
          },
        ],
      },
      CATALOG,
    );

    expect(doc.content?.[0].content).toEqual([
      { type: "text", text: "  " },
      { type: "hardBreak" },
      { type: "text", text: "$frontend-design polish this" },
    ]);
  });

  // `$frontend-design.` is prose in a single node - the regex demands
  // whitespace or end after the name, and `.` is neither. Splitting the run must
  // not change that answer: the serialized prompt still reads
  // `/frontend-design.`, which the host's parser also refuses, so a structural
  // chip here would invoke a skill the user's own text never asked for.
  it("does not chip a leading token an adjacent node ends with punctuation", () => {
    const doc = buildSubmittedChatJSONContent(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "$frontend-design",
                marks: [{ type: "bold" }],
              },
              { type: "text", text: "." },
            ],
          },
        ],
      },
      CATALOG,
    );

    expect(doc.content?.[0].content).toEqual([
      { type: "text", text: "$frontend-design", marks: [{ type: "bold" }] },
      { type: "text", text: "." },
    ]);
  });

  // The discriminator for the guard above: a split run whose next node DOES open
  // with whitespace is a real command and still has to chip. Without this the
  // boundary check could pass by refusing every cross-node token.
  it("chips a leading token when the adjacent node opens with whitespace", () => {
    const doc = buildSubmittedChatJSONContent(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "$frontend-design",
                marks: [{ type: "bold" }],
              },
              { type: "text", text: " polish this" },
            ],
          },
        ],
      },
      CATALOG,
    );

    expect(doc.content?.[0].content).toEqual([
      {
        type: "slashCommand",
        attrs: {
          commandName: "frontend-design",
          harnessId: "claude",
          kind: "skill",
          description: "Use frontend-design",
          argumentHint: null,
          path: "/repo/.agents/skills/frontend-design/SKILL.md",
          trigger: "$",
        },
      },
      { type: "text", text: " polish this" },
    ]);
  });

  // An attachment atom serializes to `""` and `plainTextFromNodes` drops empties
  // before joining, so this prompt still reads `/frontend-design polish this`.
  // The boundary lives past the atom; refusing on "not a text node" would strip
  // the chip's kind/path for no reason other than an image sitting next to it.
  it("looks past a textless attachment to the boundary after it", () => {
    const doc = buildSubmittedChatJSONContent(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "$frontend-design",
                marks: [{ type: "bold" }],
              },
              { type: "imageAttachment", attrs: { imageId: "img-1" } },
              { type: "text", text: " polish this" },
            ],
          },
        ],
      },
      CATALOG,
    );

    expect(doc.content?.[0].content).toEqual([
      {
        type: "slashCommand",
        attrs: {
          commandName: "frontend-design",
          harnessId: "claude",
          kind: "skill",
          description: "Use frontend-design",
          argumentHint: null,
          path: "/repo/.agents/skills/frontend-design/SKILL.md",
          trigger: "$",
        },
      },
      { type: "imageAttachment", attrs: { imageId: "img-1" } },
      { type: "text", text: " polish this" },
    ]);
  });

  // The bound on that: reading past the atom must reach the REAL next character,
  // so an attachment followed by punctuation is still refused.
  it("refuses a token whose boundary past an attachment is punctuation", () => {
    const doc = buildSubmittedChatJSONContent(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "$frontend-design",
                marks: [{ type: "bold" }],
              },
              { type: "imageAttachment", attrs: { imageId: "img-1" } },
              { type: "text", text: "." },
            ],
          },
        ],
      },
      CATALOG,
    );

    expect(doc.content?.[0].content).toEqual([
      { type: "text", text: "$frontend-design", marks: [{ type: "bold" }] },
      { type: "imageAttachment", attrs: { imageId: "img-1" } },
      { type: "text", text: "." },
    ]);
  });

  it("leaves a non-leading $skill alone", () => {
    // Only the leading token is a command context, same as `/`.
    expect(submittedParagraph("please run $frontend-design", CATALOG)).toEqual([
      { type: "text", text: "please run $frontend-design" },
    ]);
  });
});
