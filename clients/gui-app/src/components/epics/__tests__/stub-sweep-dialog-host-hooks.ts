/**
 * Side-effect import for suites that mount `<EpicsListPanel>` (or a parent
 * that does) without exercising Sweep. The panel always mounts
 * `SweepWorktreesDialog`, whose title/name/query hooks require a host
 * runtime. Import this file before the SUT so a new hook is stubbed once.
 */
import { vi } from "vitest";

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktree-candidates-query", () => ({
  useEpicSweepWorktreeCandidatesForClient: () => ({
    hostId: "host-test",
    rows: [],
    isPending: false,
    isError: false,
    checkedAt: null,
    canRefresh: true,
    refresh: () => Promise.resolve([]),
  }),
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktrees-mutation", () => ({
  useEpicSweepWorktrees: () => ({
    isPending: false,
    mutate: () => {},
  }),
  useSweepingWorktreePaths: () => new Set<string>(),
}));

vi.mock("@/components/settings/panels/use-worktree-task-titles", () => ({
  useWorktreeTaskTitles: () => new Map<string, string>(),
}));

vi.mock("@/lib/worktree/teardown-agent-names", () => ({
  useTeardownAgentNames: () => new Map<string, string>(),
}));
