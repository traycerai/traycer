import { describe, expect, it } from "vitest";
import { stripOrchestrationPrelude } from "../orchestration-prelude";

const PRELUDE = [
  "<!-- traycer-orchestration-prelude -->",
  "# Orchestration context (injected once at chat creation)",
  "",
  "## Binding",
  "- Orchestration: `dev-team-full`",
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
