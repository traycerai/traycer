import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  stripOrchestrationPrelude,
  stripOrchestrationPreludeFromDoc,
} from "../orchestration-prelude";

const PRELUDE = [
  "<!-- traycer-orchestration-prelude -->",
  "# Orchestration context (injected once at chat creation)",
  "",
  "## Binding",
  "- Orchestration: `dev-team`",
  "- Role: `orchestrator` (Orchestrator)",
  "",
  "## Responsibility",
  "Maestro do time.",
  "",
  "<!-- /traycer-orchestration-prelude -->",
  "",
].join("\n");

describe("stripOrchestrationPrelude", () => {
  it("strips a leading prelude and keeps the user's text", () => {
    const input = `${PRELUDE}\nMonte o time da issue 1077.`;
    expect(stripOrchestrationPrelude(input)).toBe(
      "Monte o time da issue 1077.",
    );
  });

  it("returns the input unchanged when there are no markers", () => {
    const input = "mensagem normal sem prelude";
    expect(stripOrchestrationPrelude(input)).toBe(input);
  });

  it("returns the input unchanged when the end marker is missing", () => {
    const input = "<!-- traycer-orchestration-prelude -->\nsem fechamento";
    expect(stripOrchestrationPrelude(input)).toBe(input);
  });

  it("keeps text that precedes the prelude", () => {
    const input = `antes\n\n${PRELUDE}\ndepois`;
    expect(stripOrchestrationPrelude(input)).toBe("antes\n\ndepois");
  });

  it("fails open on a prelude-only message (never renders an empty bubble)", () => {
    expect(stripOrchestrationPrelude(PRELUDE)).toBe(PRELUDE);
  });

  it("strips only the first prelude span", () => {
    const input = `${PRELUDE}\nmeio\n${PRELUDE}\nfim`;
    const out = stripOrchestrationPrelude(input);
    expect(out).toContain("meio");
    expect(out).toContain("fim");
    // The second (later) span is preserved untouched.
    expect(out).toContain("<!-- traycer-orchestration-prelude -->");
    expect(out.indexOf("# Orchestration context")).toBeGreaterThan(-1);
  });
});

describe("stripOrchestrationPreludeFromDoc", () => {
  const para = (text: string): JsonContent =>
    text.length === 0
      ? { type: "paragraph" }
      : { type: "paragraph", content: [{ type: "text", text }] };

  /** Mirrors prependPlainTextToComposerDoc: one block per prelude line. */
  const docWithPrelude = (userText: string): JsonContent => ({
    type: "doc",
    content: [...PRELUDE.split("\n").map(para), para(userText)],
  });

  it("removes the prelude block span and keeps the user's paragraph", () => {
    const out = stripOrchestrationPreludeFromDoc(
      docWithPrelude("Monte o time da issue 1077."),
    );
    expect(out.content).toEqual([para("Monte o time da issue 1077.")]);
  });

  it("returns the input unchanged when there are no markers", () => {
    const doc: JsonContent = { type: "doc", content: [para("mensagem")] };
    expect(stripOrchestrationPreludeFromDoc(doc)).toBe(doc);
  });

  it("returns the input unchanged when the end marker is missing", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        para("<!-- traycer-orchestration-prelude -->"),
        para("sem fechamento"),
      ],
    };
    expect(stripOrchestrationPreludeFromDoc(doc)).toBe(doc);
  });

  it("fails open when a marker shares its block with other text", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        para("antes <!-- traycer-orchestration-prelude -->"),
        para("meio"),
        para("<!-- /traycer-orchestration-prelude -->"),
        para("depois"),
      ],
    };
    expect(stripOrchestrationPreludeFromDoc(doc)).toBe(doc);
  });

  it("fails open on a prelude-only doc (never renders an empty bubble)", () => {
    const doc: JsonContent = {
      type: "doc",
      content: PRELUDE.split("\n").map(para),
    };
    expect(stripOrchestrationPreludeFromDoc(doc)).toBe(doc);
  });

  it("keeps user blocks that precede the prelude span", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        para("antes"),
        ...PRELUDE.split("\n").map(para),
        para("depois"),
      ],
    };
    const out = stripOrchestrationPreludeFromDoc(doc);
    expect(out.content).toEqual([para("antes"), para("depois")]);
  });
});
