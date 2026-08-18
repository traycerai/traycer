/**
 * Deadlines for host-dependent loading states (redesign invariant 6: every
 * host-dependent loading state carries a deadline AND a terminal
 * presentation).
 *
 * They live in one module because the failure this epic is fixing is not any
 * single missing timer - it is that six unrelated surfaces each decided
 * separately whether to bound their wait, and five of them decided no. A
 * budget that is a shared constant is a budget the next surface inherits
 * instead of re-deciding.
 *
 * All three values are 15s. Deliberately one number rather than a tuned
 * per-surface table: nothing measured says a terminal tile deserves a
 * different patience than an epic session, and two numbers would be two
 * things to keep true.
 *
 * `ESTABLISHING_DEADLINE_MS` was the one bounded host load that already
 * existed when this table was written, and it stayed in
 * `epic-session-provider.tsx` as a private copy because that file was the
 * least-disturbable in the tree mid-phase. It converges here now (P4.3): a
 * duplicated budget is exactly the shape this module exists to prevent - the
 * two could drift, and the copy that drifted would be the one nobody thought
 * to look at.
 */

/**
 * How long a tile waits for a host that is starting before it stops saying
 * "starting" and falls to the unreachable presentation WITH its affordances
 * (audit F4/S2: `host-starting` was unbounded, so a chat bound to a host that
 * never published withheld its Clone offer forever).
 *
 * The fall is a PRESENTATION change, not a death verdict - see
 * `HostReachability.basis`, which is what keeps a slow boot from firing a
 * persisted "terminal permanently closed" notification.
 */
export const HOST_STARTING_BUDGET_MS = 15_000;

/**
 * How long tab content waits for its host's data before it stops spinning and
 * says so (audit S3/S4/S5). Applies to whatever the surface is waiting on -
 * a disabled `useHostQuery`, a stream subscription that never delivers, a
 * chat-session handle that never resolves - because the user cannot tell
 * those apart and the same sentence is true of all three.
 */
export const TILE_CONTENT_BUDGET_MS = 15_000;

/**
 * How long an epic session waits for its host to establish - the authority to
 * attach and a snapshot to arrive - before it presents the gap instead of a
 * skeleton (invariant 6, and P2.4's `attached: false` arm, where the deadline
 * has to be armed from its own effect so a detach/reattach never joins the
 * acquire deps).
 *
 * This is the ORIGINAL of the three. The other two were written to match it.
 */
export const ESTABLISHING_DEADLINE_MS = 15_000;
