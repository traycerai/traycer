import { describe, expect, it } from "vitest";
import { sandboxCostsRefetchInterval } from "@/hooks/sandboxes/use-sandbox-costs-query";

describe("sandboxCostsRefetchInterval", () => {
  it("polls every minute while an awake sandbox burns, whatever the rate", () => {
    expect(sandboxCostsRefetchInterval(1)).toBe(60_000);
    expect(sandboxCostsRefetchInterval(120)).toBe(60_000);
    expect(sandboxCostsRefetchInterval(5_000_000)).toBe(60_000);
  });

  it("does not poll when nothing burns, or the burn is not known", () => {
    expect(sandboxCostsRefetchInterval(0)).toBe(false);
    expect(sandboxCostsRefetchInterval(null)).toBe(false);
  });
});
