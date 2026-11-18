import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { WorktreeHostEntry } from "@traycer/protocol/host/index";
import { WorktreeDeleteProgressStrip } from "@/components/settings/panels/worktree-delete-progress-strip";
import type {
  WorktreeDeleteProgressSummary,
  WorktreeDeleteRunRecord,
} from "@/components/settings/panels/use-worktree-delete-run";
import "@/index.css";

/**
 * Real-layout fixture for the Worktrees settings progress strip
 * (`WorktreeDeleteProgressStrip`): a batch where many backgrounded targets
 * failed with a multi-line error tail must not push the rest of the panel
 * (the worktree inventory) out of its card. jsdom lays nothing out, so only a
 * real engine can say how tall the strip and the inventory end up.
 *
 * Renders the PRODUCTION strip, and nothing of the panel's layout beyond the
 * constraint a settings panel imposes from outside: a fill-height flex column
 * in an `overflow-hidden` card, with a `min-h-0 flex-1` scrolling inventory
 * below the strip. Driven by
 * `browser-tests/worktree-delete-progress-overflow.spec.ts`.
 */

const FAILED_COUNT = 10;
const TAIL_LINES = 20;

function failedRecord(index: number): WorktreeDeleteRunRecord {
  const worktreePath = `/synthetic/worktrees/repo-${index}`;
  const target: WorktreeHostEntry = {
    worktreePath,
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    branch: `feat-${index}`,
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
  };
  const errorTail = Array.from(
    { length: TAIL_LINES },
    (_, line) => `repo-${index} tail line ${line}`,
  ).join("\n");
  return {
    key: `run-${index}`,
    hostId: "synthetic-host",
    batchKey: "batch-1",
    target,
    backgrounded: true,
    run: {
      status: "failed",
      hasTeardown: false,
      activePhase: null,
      log: [],
      deleted: false,
      declined: null,
      error: "git worktree remove failed",
      errorTail,
      pendingBusyHolders: null,
    },
  };
}

const runs: readonly WorktreeDeleteRunRecord[] = Array.from(
  { length: FAILED_COUNT },
  (_, index) => failedRecord(index),
);

const summary: WorktreeDeleteProgressSummary = {
  scopeKeys: runs.map((record) => record.key),
  total: FAILED_COUNT,
  deleted: 0,
  failed: FAILED_COUNT,
  active: 0,
  declinedKind: null,
};

export function WorktreeDeleteProgressOverflowFixture(): ReactNode {
  return (
    <div className="flex h-full w-full flex-col p-4">
      <div
        data-testid="fixture-card"
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border"
      >
        <WorktreeDeleteProgressStrip
          summary={summary}
          runs={runs}
          onDismiss={() => undefined}
        />
        <div
          data-testid="fixture-inventory"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {Array.from({ length: 60 }, (_, row) => (
            <div key={row} className="px-5 py-2">
              inventory row {row}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("fixture root missing");
createRoot(root).render(<WorktreeDeleteProgressOverflowFixture />);
