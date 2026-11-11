import { describe, expect, it } from "vitest";
import {
  hiddenModelProvidersForHarness,
  modelProviderGroupId,
  providersListReportsHiddenModelProviders,
  hiddenModelProviderCount,
  withoutHiddenModelProviderRows,
  withoutHiddenModelProviders,
} from "../provider-hidden-model-providers";

describe("hidden model provider helpers", () => {
  it("enables visibility only for providers.list 10.10 and later in major 10", () => {
    expect(providersListReportsHiddenModelProviders(null)).toBe(false);
    expect(
      providersListReportsHiddenModelProviders({ major: 10, minor: 9 }),
    ).toBe(false);
    expect(
      providersListReportsHiddenModelProviders({ major: 10, minor: 10 }),
    ).toBe(true);
    expect(
      providersListReportsHiddenModelProviders({ major: 10, minor: 11 }),
    ).toBe(true);
    expect(
      providersListReportsHiddenModelProviders({ major: 11, minor: 0 }),
    ).toBe(false);
  });

  it("reads the hidden list from only the matching harness row", () => {
    const rows = [
      { providerId: "opencode", hiddenModelProviders: ["openrouter"] },
      { providerId: "claude-code", hiddenModelProviders: ["other"] },
    ] as never[];
    expect([...hiddenModelProvidersForHarness(rows, "opencode")]).toEqual([
      "openrouter",
    ]);
    expect(hiddenModelProvidersForHarness(rows, "claude-code").size).toBe(0);
    expect(hiddenModelProvidersForHarness(undefined, "opencode").size).toBe(0);
  });

  it("filters hidden groups but preserves ungrouped models and a nonempty fallback", () => {
    const models = [
      { id: "a", metadata: { openCodeProviderId: "openrouter" } },
      { id: "b", metadata: { openCodeProviderId: "anthropic" } },
      { id: "c", metadata: {} },
    ];
    expect(
      withoutHiddenModelProviders(models, new Set(["openrouter"])).map(
        (model) => model.id,
      ),
    ).toEqual(["b", "c"]);
    const onlyHidden = models.slice(0, 2);
    expect(
      withoutHiddenModelProviders(
        onlyHidden,
        new Set(["openrouter", "anthropic"]),
      ),
    ).toBe(onlyHidden);
    expect(
      modelProviderGroupId({ metadata: { openCodeProviderId: "" } }),
    ).toBeNull();
  });

  it("filters hidden groups for picker rows and search while keeping the selected row", () => {
    const rows = [
      { id: "openrouter:a", providerGroupId: "openrouter" },
      { id: "anthropic:a", providerGroupId: "anthropic" },
      { id: "ungrouped", providerGroupId: null },
      { id: "openrouter:selected", providerGroupId: "openrouter" },
    ];
    const hidden = new Set(["openrouter"]);
    const visibleRows = withoutHiddenModelProviderRows(
      rows,
      hidden,
      "openrouter:selected",
    );
    // The picker feeds this same filtered array to browse rows and search rows.
    expect(visibleRows.map((row) => row.id)).toEqual([
      "anthropic:a",
      "ungrouped",
      "openrouter:selected",
    ]);
    expect(withoutHiddenModelProviderRows(rows, new Set(), "")).toBe(rows);
  });

  it("counts distinct hidden provider groups that have rows", () => {
    const rows = [
      { id: "a", providerGroupId: "openrouter" },
      { id: "b", providerGroupId: "openrouter" },
      { id: "c", providerGroupId: "anthropic" },
      { id: "d", providerGroupId: null },
    ];
    expect(
      hiddenModelProviderCount(
        rows,
        new Set(["openrouter", "anthropic", "absent"]),
      ),
    ).toBe(2);
    expect(hiddenModelProviderCount(rows, new Set())).toBe(0);
  });
});
