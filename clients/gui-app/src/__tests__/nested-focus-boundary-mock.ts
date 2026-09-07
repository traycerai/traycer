import { vi } from "vitest";
import type { PrepareNestedFocusTarget } from "@/lib/epic-nested-focus-navigation";

export type { PrepareNestedFocusTarget };

/** Import first. Spy runs prepare against the real canvas store; only the route write is skipped. Do not mock the canvas store instead. */
const mockState = vi.hoisted(() => ({
  navigateNested: vi.fn(
    (_epicId: string, _tabId: string, prepare: PrepareNestedFocusTarget) =>
      prepare(),
  ),
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => mockState.navigateNested,
}));

export const nestedFocusBoundaryMock = mockState;
