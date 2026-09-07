/**
 * Deadlines for host-dependent loading states (redesign invariant 6: every host-dependent loading state carries a deadline AND a terminal presentation).
 */

/**
 * How long a tile waits for a host that is starting before it stops saying "starting" and falls to the unreachable presentation WITH its affordances (audit F4/S2: `host-starting` was unbounded, so a chat bound to a host that never published withheld its.
 */
export const HOST_STARTING_BUDGET_MS = 15_000;

/**
 * How long tab content waits for its host's data before it stops spinning and says so (audit S3/S4/S5).
 * Applies to whatever the surface is waiting on - a disabled `useHostQuery`, a stream subscription that never delivers, a chat-session handle that never resolves - because the user cannot tell those apart and the same sentence is true of all three.
 */
export const TILE_CONTENT_BUDGET_MS = 15_000;

/**
 * How long an epic session waits for its host to establish - the authority to attach and a snapshot to arrive - before it presents the gap instead of a skeleton (invariant 6, and P2.4's `attached: false` arm, where the deadline has to be armed from its own.
 */
export const ESTABLISHING_DEADLINE_MS = 15_000;
