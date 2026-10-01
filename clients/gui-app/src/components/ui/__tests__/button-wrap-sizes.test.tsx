import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "../button";

// jsdom has no layout, so these assert the MERGED class list. The base button
// is `shrink-0 whitespace-nowrap`; a wrapping size only works if `cn` displaced
// both. Token comparison (not substring) so `shrink` is never satisfied by
// `shrink-0`.
function classTokens(name: string): ReadonlyArray<string> {
  return Array.from(screen.getByRole("button", { name }).classList);
}

describe("Button wrapping sizes", () => {
  afterEach(() => {
    cleanup();
  });

  it("route-chip size wraps, shrinks and drops the one-line base classes", () => {
    render(
      <Button variant="route-chip" size="route-chip">
        Chip
      </Button>,
    );
    const tokens = classTokens("Chip");
    for (const token of [
      "flex-wrap",
      "shrink",
      "min-w-0",
      "max-w-full",
      "whitespace-normal",
    ]) {
      expect(tokens, token).toContain(token);
    }
    expect(tokens).not.toContain("shrink-0");
    expect(tokens).not.toContain("whitespace-nowrap");
  });

  it("inline-xs-wrap size shrinks, wraps and drops the one-line base classes", () => {
    render(
      <Button variant="muted" size="inline-xs-wrap">
        Inline
      </Button>,
    );
    const tokens = classTokens("Inline");
    for (const token of [
      "min-w-0",
      "max-w-full",
      "shrink",
      "whitespace-normal",
    ]) {
      expect(tokens, token).toContain(token);
    }
    expect(tokens).not.toContain("shrink-0");
    expect(tokens).not.toContain("whitespace-nowrap");
  });
});
