/**
 * Whether a terminal agent's session is alive, asleep or over - the
 * vocabulary three surfaces need and none of them owns.
 *
 * `epic.listTuiAgents` rows, `host.chatRecords.subscribe`'s `tuiUpsert` rows
 * and `agent.list` summaries all answer the same question about the same
 * fact, so the enums live at the `host/` root beside `worktree-schemas.ts`
 * rather than inside either method's module. A second spelling in the agent
 * surface would be a seam where "asleep" and "sleeping" could drift apart.
 *
 * ## The misreading this exists to fix
 *
 * A terminal agent whose PTY is idle long enough is REAPED - its session is
 * torn down with no viewer to tell, and nothing on the wire distinguished that
 * from an agent that was stopped for good. Everything downstream read the
 * absence as death: the tile showed a dead-agent banner, and an orchestrator
 * asking `agent.list` concluded its peer had died and stopped addressing it.
 * Every PTY exit is in fact RESUMABLE - opening the agent or sending it a
 * message revives the same session - so the honest wire answer is "asleep",
 * and these two fields are what carries it.
 *
 * Allowed dependencies: `zod` only.
 */
import { z } from "zod";

/**
 * The agent's session, as its BINDING host knows it.
 *
 * - `running`  - a live session exists on the binding host right now.
 * - `sleeping` - no live session, and the agent RESUMES on the next open or
 *   message. Every PTY exit lands here, whatever ended it: an idle reap, a
 *   user stop, a restart-shaped kill, or the CLI exiting on its own.
 * - `stopped`  - the agent is over as a RECORD: archived, or deleted. Written
 *   only by the record-level operations that end an agent, never by a session
 *   ending. Reporting `stopped` for a resumable agent is precisely the
 *   misreading above, so the two are kept structurally apart rather than
 *   distinguished by a second field.
 *
 * Carried NULLABLE everywhere it appears, and `null` is a real answer rather
 * than a gap to paper over: it means the serving host cannot know. A row
 * written before this field existed, a row bound to a PEER host (only the
 * binding host observes its own session transitions), and a cloud replica
 * (the metadata projection does not carry the facet) all read `null`, and a
 * consumer renders them exactly as it rendered every row before this field
 * shipped.
 *
 * CLOSED enum. A state this contract version cannot represent would leave a
 * consumer unable to render the agent at all, so widening it is a NEW MINOR
 * with the response growth declared - never a silent addition, which an older
 * peer's schema would refuse outright.
 */
export const agentSessionStateSchema = z.enum([
  "running",
  "sleeping",
  "stopped",
]);
export type AgentSessionState = z.infer<typeof agentSessionStateSchema>;

/**
 * WHY the last session ended, for an agent that is `sleeping`.
 *
 * - `reaped`       - the idle sweep took the session down with no viewer
 *   attached.
 * - `user-stop`    - somebody stopped it (the Resource Manager's stop, or the
 *   equivalent affordance).
 * - `restart`      - the host tore the session down to rebuild it (a worktree
 *   rebind, a holder reclaim, a setup-shell replacement). The respawn happens
 *   on the NEXT launch, which may be hours later, so this is a sleeping agent
 *   and not a transient.
 * - `process-exit` - the provider CLI ended on its own, at any exit code.
 *
 * Display metadata, never a routing decision: all four resume identically, and
 * a consumer that branched on this to decide whether an agent can be revived
 * would be re-introducing the dead/asleep confusion one level down. It exists
 * so the UI can say "stopped by you" instead of "asleep" and so an
 * orchestrator can tell a peer it stopped from one that timed out.
 *
 * `null` where the reason is unknown or does not apply - a `running` agent, a
 * peer-host row, a replica, or a row that went to sleep before this field
 * shipped. Deliberately NOT collapsed into `sessionState`: the state decides
 * what an agent IS, the reason only says how it got there, and a combined enum
 * would multiply out every time either half grew.
 *
 * CLOSED enum, widened only by a new minor - same rule as the state above.
 *
 * NOT the frozen wire exit-reason enum that terminal snapshots carry
 * (`session.exitReason`): that one answers what the PTY did, is negotiated on
 * its own line, and must not be widened to carry these values.
 */
export const agentSessionLastExitSchema = z.enum([
  "reaped",
  "user-stop",
  "restart",
  "process-exit",
]);
export type AgentSessionLastExit = z.infer<typeof agentSessionLastExitSchema>;
