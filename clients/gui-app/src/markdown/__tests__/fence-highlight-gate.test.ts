import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import {
  FenceHighlightGate,
  fenceTailObservation,
  type FenceHighlightIdentity,
  type FenceTailObservation,
} from "@/markdown/fence-highlight-gate";

const THEME = "github-dark";

function identity(
  code: string,
  lang: string,
  theme: string,
): FenceHighlightIdentity {
  return { code, lang, theme };
}

function nodeFor(code: string): ReactNode {
  return code;
}

describe("fenceTailObservation", () => {
  const observed = {
    code: "const a = 1;",
    lang: "ts",
    tail: "closed" as const,
  };

  it("treats a finished message as closed even when the last observation was the open tail", () => {
    expect(
      fenceTailObservation(
        false,
        { code: "const a = 1;", lang: "ts", tail: "open" },
        "const a = 1;",
        "ts",
      ),
    ).toBe("closed");
  });

  it("forgets an observation that belongs to a shorter buffer", () => {
    expect(
      fenceTailObservation(true, observed, "const a = 1;\nconst b = 2;", "ts"),
    ).toBe("unknown");
  });

  it("forgets an observation that belongs to another language", () => {
    expect(fenceTailObservation(true, observed, "const a = 1;", "js")).toBe(
      "unknown",
    );
  });

  it("returns unknown before any observation while the message is streaming", () => {
    expect(fenceTailObservation(true, null, "const a = 1;", "ts")).toBe(
      "unknown",
    );
  });

  it("keeps the observation that matches the bytes on screen", () => {
    expect(
      fenceTailObservation(true, observed, observed.code, observed.lang),
    ).toBe("closed");
    expect(
      fenceTailObservation(
        true,
        { ...observed, tail: "open" },
        observed.code,
        observed.lang,
      ),
    ).toBe("open");
  });
});

describe("FenceHighlightGate", () => {
  it("stays plain while the tail is open or not yet observed, then highlights once it is closed", () => {
    const gate = new FenceHighlightGate();
    const current = identity("const a = 1;", "ts", THEME);
    const openStates: FenceTailObservation[] = ["unknown", "open"];
    for (const observation of openStates) {
      expect(gate.decide(observation, current)).toEqual({ action: "plain" });
    }

    expect(gate.decide("closed", current)).toEqual({ action: "highlight" });
    // A miss must not stick: the core may not be ready on the first ask.
    expect(gate.decide("closed", current)).toEqual({ action: "highlight" });

    const node = nodeFor(current.code);
    gate.commit(current, node);
    expect(gate.decide("closed", current)).toEqual({
      action: "reuse",
      node,
    });
  });

  it("reuses a highlight of the same bytes when the tail marker flickers, and drops a longer buffer back to plain", () => {
    const gate = new FenceHighlightGate();
    const current = identity("const a = 1;", "ts", THEME);
    const node = nodeFor(current.code);
    gate.commit(current, node);

    expect(gate.decide("open", current)).toEqual({ action: "reuse", node });
    expect(gate.decide("unknown", current)).toEqual({ action: "reuse", node });

    const grown = identity("const a = 1;\nconst b = 2;", "ts", THEME);
    expect(gate.decide("unknown", grown)).toEqual({ action: "plain" });
    expect(gate.decide("open", grown)).toEqual({ action: "plain" });
    expect(gate.decide("closed", grown)).toEqual({ action: "highlight" });
  });

  it("highlights again when the theme or the language changes", () => {
    const gate = new FenceHighlightGate();
    const current = identity("const a = 1;", "ts", THEME);
    gate.commit(current, nodeFor(current.code));

    expect(
      gate.decide("closed", identity(current.code, "ts", "github-light")),
    ).toEqual({
      action: "highlight",
    });
    expect(gate.decide("closed", identity(current.code, "js", THEME))).toEqual({
      action: "highlight",
    });
    // The previous theme was not committed, so the original bytes still reuse.
    expect(gate.decide("closed", current).action).toBe("reuse");
  });
});
