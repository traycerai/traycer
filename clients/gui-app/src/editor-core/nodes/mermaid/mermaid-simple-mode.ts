import { StreamLanguage, type StreamParser } from "@codemirror/language";

/**
 * Tiny StreamLanguage for Mermaid source. Highlights the diagram
 * declaration keywords, edge operators, and bracket-delimited labels so
 * the in-editor source has some visual structure without pulling in a
 * full grammar (~200 kB for `mermaid-parser`). Everything else falls
 * through as plain text.
 *
 * Good enough for the common case - users editing an existing diagram.
 * A malformed snippet still highlights nicely, and parse errors surface
 * on commit via the error panel rather than inline squiggles.
 */
const KEYWORDS = new Set([
  "graph",
  "flowchart",
  "subgraph",
  "end",
  "sequenceDiagram",
  "participant",
  "actor",
  "activate",
  "deactivate",
  "note",
  "over",
  "right",
  "left",
  "of",
  "loop",
  "alt",
  "else",
  "opt",
  "par",
  "and",
  "rect",
  "classDiagram",
  "class",
  "stateDiagram",
  "stateDiagram-v2",
  "state",
  "gantt",
  "dateFormat",
  "section",
  "erDiagram",
  "journey",
  "pie",
  "title",
  "mindmap",
  "root",
  "timeline",
  "requirementDiagram",
  "requirement",
  "element",
  "gitGraph",
  "commit",
  "branch",
  "merge",
  "checkout",
]);

const DIRECTION = new Set(["TB", "TD", "BT", "RL", "LR"]);

interface MermaidState {
  readonly inString: false | '"' | "'";
}

const parser: StreamParser<MermaidState> = {
  startState(): MermaidState {
    return { inString: false };
  },

  token(stream, state) {
    if (state.inString !== false) {
      const closed = stream.skipTo(state.inString);
      if (closed) {
        stream.next();
        // @ts-expect-error - StreamParser state is meant to be mutable
        // per token, even though our exposed type marks it readonly.
        state.inString = false;
      } else {
        stream.skipToEnd();
      }
      return "string";
    }

    if (stream.match(/%%.*/)) return "comment";

    if (stream.match(/^"/)) {
      // @ts-expect-error - see note above
      state.inString = '"';
      return "string";
    }
    if (stream.match(/^'/)) {
      // @ts-expect-error - see note above
      state.inString = "'";
      return "string";
    }

    // Edge operators: --> --x -.-> ==>  etc.
    if (
      stream.match(/^(-{1,3}>|<-{1,3}|-{1,3}|={1,3}>|-\.-|\.\.>|={2,3}|~~~)/)
    ) {
      return "operator";
    }

    if (stream.match(/^[[\](){}|]/)) return "bracket";

    if (stream.match(/^\d+(\.\d+)?/)) return "number";

    const wordMatch = stream.match(/^[A-Za-z_][A-Za-z0-9_-]*/);
    if (wordMatch !== null && wordMatch !== false) {
      const word = Array.isArray(wordMatch) ? wordMatch[0] : String(wordMatch);
      if (KEYWORDS.has(word)) return "keyword";
      if (DIRECTION.has(word)) return "atom";
      return "variable";
    }

    stream.next();
    return null;
  },
};

export const mermaidStreamLanguage = StreamLanguage.define(parser);
