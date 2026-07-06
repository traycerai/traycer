import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

// Regression: the custom `--text-*` typography tokens must be registered
// with tailwind-merge as font sizes. Before that, `text-ui-sm` was
// classified as a text COLOR and silently dropped whenever a real color
// joined the same merge - e.g. the git panel's active row gained
// `text-accent-foreground` and lost its font size, rendering bigger than
// its siblings.
describe("cn custom font-size tokens", () => {
  it("keeps a custom font size alongside a text color", () => {
    expect(cn("text-ui-sm", "text-accent-foreground")).toBe(
      "text-ui-sm text-accent-foreground",
    );
    expect(cn("text-ui-md", "text-foreground")).toBe(
      "text-ui-md text-foreground",
    );
    expect(cn("text-ui-lg", "text-muted-foreground")).toBe(
      "text-ui-lg text-muted-foreground",
    );
    expect(cn("text-ui-base", "text-primary")).toBe(
      "text-ui-base text-primary",
    );
  });

  it("collapses two custom font sizes to the last one", () => {
    expect(cn("text-ui-xs", "text-ui-sm", "text-ui-md")).toBe("text-ui-md");
  });

  it("lets a built-in font size override a custom one", () => {
    expect(cn("text-ui-sm", "text-sm")).toBe("text-sm");
  });

  it("keeps a text color alongside a later custom font size", () => {
    expect(cn("text-muted-foreground", "text-code-xs")).toBe(
      "text-muted-foreground text-code-xs",
    );
  });
});
