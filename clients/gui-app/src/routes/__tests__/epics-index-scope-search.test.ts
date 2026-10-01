import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/epics/epics-list", () => ({
  EpicsList: () => null,
}));

import { parseHistorySearch } from "@/lib/history-search";
import { Route as EpicsIndexRoute } from "@/routes/epics/index";

type ValidateSearch = (
  search: Record<string, unknown>,
) => Record<string, unknown>;
type LoaderDeps = (args: { search: Record<string, unknown> }) => unknown;

const validateSearch = EpicsIndexRoute.options.validateSearch as ValidateSearch;
const loaderDeps = EpicsIndexRoute.options.loaderDeps as LoaderDeps;

describe("/epics search: history scope", () => {
  it("keeps a non-default scope in the validated search", () => {
    expect(validateSearch({ historyScope: "tasks" })).toMatchObject({
      historyScope: "tasks",
    });
    expect(validateSearch({ historyScope: "messages" })).toMatchObject({
      historyScope: "messages",
    });
  });

  it("drops the default and invalid values so the URL stays clean", () => {
    expect(
      validateSearch({ historyScope: "all" }).historyScope,
    ).toBeUndefined();
    expect(
      validateSearch({ historyScope: "bogus" }).historyScope,
    ).toBeUndefined();
    expect(validateSearch({}).historyScope).toBeUndefined();
  });

  it("carries the scope alongside the other history params", () => {
    expect(
      validateSearch({ historyQuery: "api", historyScope: "messages" }),
    ).toMatchObject({ historyQuery: "api", historyScope: "messages" });
  });

  it("keeps scope out of loaderDeps so a scope change never re-runs the prefetch", () => {
    const base = { historyQuery: "api" };
    const all = loaderDeps({ search: validateSearch(base) });
    expect(
      loaderDeps({
        search: validateSearch({ ...base, historyScope: "tasks" }),
      }),
    ).toEqual(all);
    expect(
      loaderDeps({
        search: validateSearch({ ...base, historyScope: "messages" }),
      }),
    ).toEqual(all);
    expect(all).toEqual({ historySearch: parseHistorySearch(base) });
  });
});
