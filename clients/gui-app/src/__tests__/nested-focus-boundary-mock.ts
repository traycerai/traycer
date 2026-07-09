import { vi } from "vitest";
import type { PrepareNestedFocusTarget } from "@/lib/epic-nested-focus-navigation";

export type { PrepareNestedFocusTarget };

/**
 * Shared mock for the nested-focus-opener boundary
 * (`useEpicNestedFocusNavigation`). The spy runs `prepare` against the REAL
 * canvas store instead of a stub, so assertions see the actual resulting
 * canvas state - only the route write itself is skipped. Import this module
 * first (before importing the component under test) so `vi.mock` registers
 * before anything pulls in the real hook.
 *
 * Mocking the raw canvas store instead of this boundary is exactly the
 * pattern that let two of the six nested-focus regressions ship with a
 * passing test suite - this is the one target test authors should reach for.
 */
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
