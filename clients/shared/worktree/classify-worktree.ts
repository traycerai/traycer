/**
 * Compatibility re-export. The tier ladder itself now lives in
 * `@traycer/protocol/worktree/classify-worktree` so the host can classify with
 * the exact same precedence the GUI and CLI render - see that module's header.
 *
 * Client code keeps importing it from here: this file is the clients' existing
 * import surface, and forwarding preserves every caller unchanged rather than
 * making a pure module move a rename across the GUI and CLI. Nothing is
 * redefined here; `__tests__/classify-worktree-parity.test.ts` pins the
 * forwarded symbols to the protocol module by identity so the two can never
 * drift into two implementations.
 */
export {
  GIT_UNREADABLE_REASON,
  WORKTREE_TIER_LABEL,
  WORKTREE_TIER_ORDER,
  WORKTREE_TIER_TOOLTIP,
  classifyWorktree,
  classifyWorktreeTier,
  describeReviewReasons,
  provenRemovable,
  worktreeTierRank,
} from "@traycer/protocol/worktree/classify-worktree";
export type {
  WorktreeClassification,
  WorktreeTier,
} from "@traycer/protocol/worktree/classify-worktree";
