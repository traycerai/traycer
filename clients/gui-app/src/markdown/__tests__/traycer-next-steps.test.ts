import { describe, expect, it } from "vitest";
import {
  parseTraycerNextStepsMarkdown,
  repairTraycerNextStepsMarkdown,
} from "@/markdown/traycer-next-steps";

describe("parseTraycerNextStepsMarkdown", () => {
  it("parses a complete next steps block into prose and prompt options", () => {
    const parts = parseTraycerNextStepsMarkdown(
      [
        "Before",
        "",
        "<TRAYCER_NEXT_STEPS>",
        "Implementation is complete.",
        "",
        "- [] Use /implementation-validation to validate the work",
        "- [ ] Review the changed files with /review-files",
        "</TRAYCER_NEXT_STEPS>",
        "",
        "After",
      ].join("\n"),
      false,
    );

    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({
      kind: "markdown",
      markdown: "Before\n\n",
    });
    expect(parts[1]).toMatchObject({
      kind: "next_steps",
      prose: "Implementation is complete.",
      complete: true,
      options: [
        {
          prompt: "Use /implementation-validation to validate the work",
        },
        {
          prompt: "Review the changed files with /review-files",
        },
      ],
    });
    expect(parts[2]).toMatchObject({ kind: "markdown", markdown: "\nAfter" });
  });

  it("accepts an opening tag token followed by prose on the same line", () => {
    const parts = parseTraycerNextStepsMarkdown(
      [
        "<TRAYCER_NEXT_STEPS> Implementation is complete.",
        "",
        "- [] Use /implementation-validation to validate the work",
        "- [] Review the changed files with /review-files",
        "</TRAYCER_NEXT_STEPS>",
      ].join("\n"),
      false,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      kind: "next_steps",
      prose: "Implementation is complete.",
      complete: true,
    });
  });

  it("repairs a completed unmatched final block", () => {
    const parts = parseTraycerNextStepsMarkdown(
      [
        "<TRAYCER_NEXT_STEPS>",
        "Pick the validation pass.",
        "",
        "- [] Use /implementation-validation to validate the work",
        "- [] Review the changed files with /review-files",
      ].join("\n"),
      false,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      kind: "next_steps",
      complete: true,
    });
  });

  it("keeps streaming unmatched blocks incomplete", () => {
    const parts = parseTraycerNextStepsMarkdown(
      [
        "<TRAYCER_NEXT_STEPS>",
        "Pick the validation pass.",
        "",
        "- [] Use /implementation-validation to validate the work",
        "- [] Review the changed files with /review-files",
        "",
      ].join("\n"),
      true,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      kind: "next_steps",
      complete: false,
    });
  });

  it("keeps part and settled-option ids stable while a block streams", () => {
    // Three frames of one streaming turn: the open block grows by a few
    // tokens, then the close tag lands and streaming ends. The part id and
    // the settled first option's id are React keys - if either changed
    // between frames, the prose markdown and the option buttons would
    // remount on every streamed token.
    const settledFrame = [
      "Before",
      "",
      "<TRAYCER_NEXT_STEPS>",
      "Pick one.",
      "",
      "- [] Use /implementation-validation to validate the work",
      "- [] Review the changed files with /review-files",
      "",
    ].join("\n");
    const growingFrame = `${settledFrame}- [] Export the cha`;
    const completedFrame = `${settledFrame}- [] Export the changelog\n</TRAYCER_NEXT_STEPS>`;

    const nextStepsParts = [
      parseTraycerNextStepsMarkdown(settledFrame, true),
      parseTraycerNextStepsMarkdown(growingFrame, true),
      parseTraycerNextStepsMarkdown(completedFrame, false),
    ].map((parts) => {
      const part = parts.at(1);
      if (part === undefined || part.kind !== "next_steps") {
        throw new Error("expected next steps part");
      }
      return part;
    });

    const [settled, growing, completed] = nextStepsParts;
    expect(growing.id).toBe(settled.id);
    expect(completed.id).toBe(settled.id);
    expect(growing.prose).toBe("Pick one.\n\n- Export the cha");
    expect(growing.options).toEqual(settled.options);
    expect(growing.options.map((option) => option.prompt)).not.toContain(
      "Export the cha",
    );
    expect(completed.options.map((option) => option.prompt)).toEqual([
      "Use /implementation-validation to validate the work",
      "Review the changed files with /review-files",
      "Export the changelog",
    ]);
    expect(growing.options[0]?.id).toBe(settled.options[0]?.id);
    expect(completed.options[0]?.id).toBe(settled.options[0]?.id);
  });

  it("preserves multiple next steps blocks in order", () => {
    const parts = parseTraycerNextStepsMarkdown(
      [
        "A",
        "<TRAYCER_NEXT_STEPS>",
        "First",
        "- [] First follow-up prompt",
        "- [] Second follow-up prompt",
        "</TRAYCER_NEXT_STEPS>",
        "B",
        "<TRAYCER_NEXT_STEPS>",
        "Second",
        "- [] Second follow-up prompt",
        "- [] Third follow-up prompt",
        "</TRAYCER_NEXT_STEPS>",
        "C",
      ].join("\n"),
      false,
    );

    expect(parts.map((part) => part.kind)).toEqual([
      "markdown",
      "next_steps",
      "markdown",
      "next_steps",
      "markdown",
    ]);
  });

  it("ignores tags inside fenced code", () => {
    const markdown = [
      "```xml",
      "<TRAYCER_NEXT_STEPS>",
      "- [] Follow up",
      "</TRAYCER_NEXT_STEPS>",
      "```",
    ].join("\n");

    expect(parseTraycerNextStepsMarkdown(markdown, false)).toEqual([
      { kind: "markdown", id: "markdown:0", markdown },
    ]);
  });

  it("falls back to tag-stripped markdown for blocks without prompt options", () => {
    const parts = parseTraycerNextStepsMarkdown(
      [
        "<TRAYCER_NEXT_STEPS>",
        "Readable prose survives.",
        "",
        "- []",
        "</TRAYCER_NEXT_STEPS>",
      ].join("\n"),
      false,
    );

    expect(parts).toEqual([
      {
        kind: "markdown",
        id: "markdown:0",
        markdown: "Readable prose survives.\n\n- []",
      },
    ]);
  });

  it("treats only trailing checkbox prompt options as actions", () => {
    const parts = parseTraycerNextStepsMarkdown(
      [
        "<TRAYCER_NEXT_STEPS>",
        "- [] This stays in prose because it is not trailing",
        "",
        "Then do the final step.",
        "",
        "- [] Use /action for the next step",
        "- [] Review the result",
        "</TRAYCER_NEXT_STEPS>",
      ].join("\n"),
      false,
    );

    const nextSteps = parts[0];
    expect(nextSteps.kind).toBe("next_steps");
    if (nextSteps.kind !== "next_steps") {
      throw new Error("expected next steps part");
    }
    expect(nextSteps.prose).toBe(
      "- [] This stays in prose because it is not trailing\n\nThen do the final step.",
    );
    expect(nextSteps.options).toHaveLength(2);
    expect(nextSteps.options[0]?.prompt).toBe("Use /action for the next step");
  });

  it.each([
    {
      replay: "FE_01",
      prose: "Build outputs exist and the missing handoff is being reconciled.",
      prompt: "Weiter mit frischem FE_01-Builder",
    },
    {
      replay: "Orchestra",
      prose: "The product decision and execution mandate are complete.",
      prompt: "Tech-Plan, Bau und Agenten-QA starten",
    },
    {
      replay: "provider race",
      prose: "The safe checkpoint has no side effects.",
      prompt: "Fortfahren mit frischem Builder",
    },
    {
      replay: "unknown effect",
      prose: "Ergebnis wird geprüft.",
      prompt: "Neu starten",
    },
    {
      replay: "child STOP",
      prose: "The child turn stopped; the project obligation remains open.",
      prompt: "Weiter",
    },
    {
      replay: "duplicate continuation delivery",
      prose: "The obligation already has a continuation owner.",
      prompt: "Fortfahren",
    },
    {
      replay: "single login action encoded in markdown",
      prose: "Login is required.",
      prompt: "Sign in",
    },
  ])(
    "drops the one-option action for the $replay replay",
    ({ prose, prompt }) => {
      const parts = parseTraycerNextStepsMarkdown(
        [
          "<TRAYCER_NEXT_STEPS>",
          prose,
          "",
          `- [] ${prompt}`,
          "</TRAYCER_NEXT_STEPS>",
        ].join("\n"),
        false,
      );

      expect(parts).toEqual([
        {
          kind: "markdown",
          id: "markdown:0",
          markdown: `${prose}\n\n- ${prompt}`,
        },
      ]);
    },
  );

  it("preserves a lone prompt as inert markdown when prose is absent", () => {
    const parts = parseTraycerNextStepsMarkdown(
      [
        "<TRAYCER_NEXT_STEPS>",
        "- [] Sign in to GitHub to continue",
        "</TRAYCER_NEXT_STEPS>",
      ].join("\n"),
      false,
    );

    expect(parts).toEqual([
      {
        kind: "markdown",
        id: "markdown:0",
        markdown: "- Sign in to GitHub to continue",
      },
    ]);
  });

  it("keeps a lone streaming prompt inert until a second choice arrives", () => {
    const oneOptionFrame = parseTraycerNextStepsMarkdown(
      [
        "<TRAYCER_NEXT_STEPS>",
        "Choose a path.",
        "",
        "- [] Keep the feature internal",
      ].join("\n"),
      true,
    );
    const twoOptionFrame = parseTraycerNextStepsMarkdown(
      [
        "<TRAYCER_NEXT_STEPS>",
        "Choose a path.",
        "",
        "- [] Keep the feature internal",
        "- [] Publish the feature to customers",
        "",
      ].join("\n"),
      true,
    );

    expect(oneOptionFrame).toEqual([
      {
        kind: "markdown",
        id: "markdown:0",
        markdown: "Choose a path.\n\n- Keep the feature internal",
      },
    ]);
    expect(twoOptionFrame[0]).toMatchObject({
      kind: "next_steps",
      id: "next:0",
      complete: false,
    });
  });

  it("keeps the choice threshold monotonic while the trailing option streams", () => {
    const frames = [
      ["<TRAYCER_NEXT_STEPS>", "- [] Weiter"].join("\n"),
      ["<TRAYCER_NEXT_STEPS>", "- [] Weiter", "- [] W"].join("\n"),
      ["<TRAYCER_NEXT_STEPS>", "- [] Weiter", "- [] Weiter"].join("\n"),
      ["<TRAYCER_NEXT_STEPS>", "- [] Weiter", "- [] Weiter mit X"].join("\n"),
      ["<TRAYCER_NEXT_STEPS>", "- [] Weiter", "- [] Weiter mit X", ""].join(
        "\n",
      ),
    ].map((markdown) => parseTraycerNextStepsMarkdown(markdown, true));

    expect(frames.map((parts) => parts[0]?.kind)).toEqual([
      "markdown",
      "markdown",
      "markdown",
      "markdown",
      "next_steps",
    ]);
    expect(frames[3]).toEqual([
      {
        kind: "markdown",
        id: "markdown:0",
        markdown: "- Weiter\n- Weiter mit X",
      },
    ]);
    expect(frames[4]?.[0]).toMatchObject({
      kind: "next_steps",
      options: [{ prompt: "Weiter" }, { prompt: "Weiter mit X" }],
      complete: false,
    });
  });

  it.each([
    {
      replay: "FE_01",
      prompt: "Weiter mit frischem FE_01-Builder",
      duplicate: "  WEITER   mit frischem FE_01-Builder  ",
    },
    {
      replay: "Orchestra",
      prompt: "Tech-Plan, Bau und Agenten-QA starten",
      duplicate: "tech-plan,   bau UND agenten-qa starten",
    },
  ])(
    "suppresses normalized duplicate options for the $replay replay",
    ({ prompt, duplicate }) => {
      const parts = parseTraycerNextStepsMarkdown(
        [
          "<TRAYCER_NEXT_STEPS>",
          "Continuation is already authorized.",
          "",
          `- [] ${prompt}`,
          `- [] ${duplicate}`,
          "</TRAYCER_NEXT_STEPS>",
        ].join("\n"),
        false,
      );

      expect(parts).toEqual([
        {
          kind: "markdown",
          id: "markdown:0",
          markdown: `Continuation is already authorized.\n\n- ${prompt}`,
        },
      ]);
    },
  );

  it("deduplicates options while preserving two distinct choices", () => {
    const parts = parseTraycerNextStepsMarkdown(
      [
        "<TRAYCER_NEXT_STEPS>",
        "Choose the product scope.",
        "",
        "- [] Keep the feature internal",
        "- []   KEEP   the feature internal  ",
        "- [] Publish the feature to customers",
        "</TRAYCER_NEXT_STEPS>",
      ].join("\n"),
      false,
    );

    expect(parts[0]).toMatchObject({
      kind: "next_steps",
      options: [
        { prompt: "Keep the feature internal" },
        { prompt: "Publish the feature to customers" },
      ],
    });
  });

  it("keeps two materially different owner decisions actionable", () => {
    const parts = parseTraycerNextStepsMarkdown(
      [
        "<TRAYCER_NEXT_STEPS>",
        "Choose the product scope.",
        "",
        "- [] Keep the feature internal",
        "- [] Publish the feature to customers",
        "</TRAYCER_NEXT_STEPS>",
      ].join("\n"),
      false,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      kind: "next_steps",
      options: [
        { prompt: "Keep the feature internal" },
        { prompt: "Publish the feature to customers" },
      ],
    });
  });
});

describe("repairTraycerNextStepsMarkdown", () => {
  it("leaves ordinary markdown untouched", () => {
    const markdown = "Normal markdown without custom next steps.";

    expect(repairTraycerNextStepsMarkdown(markdown)).toBe(markdown);
  });

  it("adds a closing tag for unmatched final blocks", () => {
    const repaired = repairTraycerNextStepsMarkdown(
      ["<TRAYCER_NEXT_STEPS>", "Text"].join("\n"),
    );

    expect(repaired).toBe(
      ["<TRAYCER_NEXT_STEPS>", "Text", "</TRAYCER_NEXT_STEPS>"].join("\n"),
    );
  });

  // Intentionally not wired into Tailmark `repairs`: custom repairs force the
  // full-document repair path. TextSegment peels next-steps before render.
});
