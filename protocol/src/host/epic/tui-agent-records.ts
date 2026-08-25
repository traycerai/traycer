import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { agentModeSchema } from "@traycer/protocol/persistence/epic/schemas";
import { worktreeBindingWorkspaceModeSchema } from "@traycer/protocol/host/worktree-schemas";

/**
 * `epic.listTuiAgents@1.0` - the terminal-agent RECORD read, the TUI sibling
 * of `epic.listChatRecords`.
 *
 * ## Why a sibling method and not a `kind` on the chat rows
 *
 * The chat row is deliberately small ("the harness id and only the harness
 * id, because that is all the row holds"); a terminal-agent row is the
 * OPPOSITE - its resume metadata IS the record (session id, workspace
 * folders, launch overrides, model tuple), there are a handful of them per
 * epic, and the renderer's terminal slice consumes all of it. Folding nine
 * TUI-only nullable fields onto every chat row to share a method would trade
 * one registry read for a permanently muddier shape - and `epic.listChatRecords`
 * is released, so widening its response is a new major, while a sibling
 * OPTIONAL method is exactly what the protocol's evolution rules provide for.
 *
 * ## Scope: the CALLER'S OWN rows, always
 *
 * Terminal agents are ALWAYS private to their owner (user ruling 2026-08-12).
 * The serving host's registry may hold other users' rows (a shared epic on a
 * multi-slot dev host); they are never serialized here. The
 * enumeration-oracle property holds: an epic with no terminal agents and an
 * epic whose terminal agents all belong to someone else answer identically.
 *
 * ## Optional, with a degrade story
 *
 * Registered `degrade: { kind: "unsupported" }` and never on the released
 * floor. A host predating this method answers `E_HOST_UNSUPPORTED`, and the
 * client's contract is DOC-ONLY MODE: that host still writes and serves the
 * epic doc's `tuiAgents` map, which is precisely the projection the renderer
 * already has. The two sources never overlap for one record: a host new
 * enough to serve this method has stopped writing the map and swept its own
 * entries.
 *
 * ## `@1.1` - why "swept its OWN entries" was not enough
 *
 * That last sentence is true and was still load-bearing in the wrong place.
 * The eviction sweep is gated on the BINDING host: it refuses to touch an
 * entry another host owns, because that host may still be writing it. So a
 * serving host's doc map legitimately holds entries bound to un-upgraded
 * PEER hosts, and `@1.0` answers for none of them - correctly, because the
 * `@1.0` client had its own doc replica and unioned them in itself.
 *
 * `epic.subscribe@2` deletes that replica. The union therefore has to move to
 * the only party that still has both halves - this host - or those agents
 * simply stop existing for the user. `@1.1` is that union: registry rows plus
 * the doc-resident remainder, each row saying which side it came from.
 *
 * ## The gate is the CALLER'S declaration, not its version
 *
 * Serving the remainder is correct for a caller that has no doc replica and
 * WRONG for one that does - it duplicates rows the caller already holds, and
 * the client's union then has to choose between its live doc entry and this
 * host's poll-time copy of the same entry. That choice has no good answer.
 *
 * The first cut gated on `epic.listTuiAgents`' own negotiated minor, which
 * CANNOT ANSWER THE QUESTION: whether a caller holds a replica is decided by
 * `epic.subscribe`'s negotiated MAJOR, a different method negotiated
 * independently on the same connection. A renderer that speaks
 * `listTuiAgents@1.1` while still subscribing at `@1` is not hypothetical - it
 * is every build between this change and the `@2` client landing, and it took
 * both halves of a cold review to see it.
 *
 * So `@1.1` grows its REQUEST instead: the caller states whether it has a doc
 * replica, and the host serves the remainder only when it does not. The client
 * is the only party that knows, and a fact it declares cannot drift out of
 * step with a version it negotiated elsewhere.
 */
export const listTuiAgentsRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type ListTuiAgentsRequest = z.infer<typeof listTuiAgentsRequestSchema>;

/**
 * One terminal agent, as the serving host's registry knows it.
 *
 * Field-for-field what the renderer's terminal slice renders plus the launch
 * fields it forwards - i.e. the persisted record MINUS the host-internal
 * bookkeeping that must never reach a client (`pinnedUserProviderHandle`,
 * `lastDeliveredRolesDigest`, `pendingForkSourceHarnessSessionId`).
 *
 * `archived` / `archivedAt` ship as the same pair the chat row carries and
 * for the same reason: the boolean is the rendering-authoritative field every
 * plane can answer; the timestamp is display metadata.
 *
 * `revision` is the row's per-record monotonic staleness test (the registry
 * head seq), exactly as on `chatRecordSummarySchema`: a consumer applies an
 * upsert only when its revision strictly exceeds the one held.
 */
export const tuiAgentRecordSummarySchema = z.object({
  tuiAgentId: z.string().min(1),
  /** IDENTITY-BEARING, as on the chat row - never render, always key. */
  ownerUserId: z.string().min(1),
  /**
   * The BINDING host - the record is bound to it for life. Non-empty like the
   * owner: a row with no binding could not be addressed by any affordance.
   */
  hostId: z.string().min(1),
  /**
   * The harness discriminator, an OPEN string on the wire so a newer host's
   * vendor still parses; clients narrow through their own harness catalog
   * and drop what they cannot dispatch.
   */
  harnessId: z.string().min(1),
  harnessSessionId: z.string().nullable(),
  parentId: z.string().nullable(),
  title: z.string(),
  isTitleEditedByUser: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archived: z.boolean(),
  archivedAt: z.number().int().nonnegative().nullable(),
  workspaceFolders: z.array(z.string()),
  workspaceMode: worktreeBindingWorkspaceModeSchema.nullable(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  agentMode: agentModeSchema,
  profileId: z.string().nullable(),
  terminalAgentArgs: z.string().nullable(),
  terminalShellCommand: z.string().nullable(),
  terminalShellArgs: z.array(z.string()).nullable(),
  revision: z.number().int().nonnegative(),
});
export type TuiAgentRecordSummary = z.infer<typeof tuiAgentRecordSummarySchema>;

export const listTuiAgentsResponseSchema = z.object({
  tuiAgents: z.array(tuiAgentRecordSummarySchema),
});
export type ListTuiAgentsResponse = z.infer<typeof listTuiAgentsResponseSchema>;

export const epicListTuiAgentsV10 = defineRpcContract({
  method: "epic.listTuiAgents",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listTuiAgentsRequestSchema,
  responseSchema: listTuiAgentsResponseSchema,
});

/**
 * The `@1.1` row: the `@1.0` summary plus its ORIGIN.
 *
 * `docResident: true` means this row was read out of the epic doc's
 * `tuiAgents` map, not the chat registry - an agent bound to a peer host that
 * has not upgraded, which this host may read but must never adopt or write.
 *
 * ## Why the client is told, rather than handed a seamless union
 *
 * A `@1.0` client derived exactly this bit from its own doc replica, and the
 * GUI still routes on it (`isDocOnlyTerminalAgent`): a doc-resident agent is
 * NOT addressable through the registry-backed affordances, so a client that
 * cannot tell the two apart would route its reparent to `epic.reparentChat`
 * with an id naming no registry chat. Serving the union without the marker
 * would fix the disappearance and silently introduce that mis-route, which is
 * the worse bug of the two - it fails on write instead of on render.
 *
 * So the marker is not metadata. It is the doc-replica-derived distinction,
 * preserved for a client that no longer has a doc replica to derive it from.
 */
export const tuiAgentRecordSummaryV11Schema =
  tuiAgentRecordSummarySchema.extend({
    docResident: z.boolean(),
  });
export type TuiAgentRecordSummaryV11 = z.infer<
  typeof tuiAgentRecordSummaryV11Schema
>;

export const listTuiAgentsResponseV11Schema = z.object({
  tuiAgents: z.array(tuiAgentRecordSummaryV11Schema),
});
export type ListTuiAgentsResponseV11 = z.infer<
  typeof listTuiAgentsResponseV11Schema
>;

/**
 * The `@1.1` request: the `@1.0` request plus the caller's own answer to the
 * only question that decides what this method should serve.
 *
 * `hasDocReplica: true` means the caller still holds a live epic-doc replica
 * (it subscribed at `epic.subscribe@1`) and therefore already sees every
 * doc-resident entry, continuously, without this method's help. It gets
 * registry rows only - exactly `@1.0` content.
 *
 * `false` means it has no replica (`epic.subscribe@2`), so the doc-resident
 * remainder reaches it here or nowhere.
 *
 * REQUIRED, not optional: a `@1.1` caller always knows this about itself, and
 * an absent field would have to be given a default - which is precisely the
 * host-side guess this field exists to remove.
 */
export const listTuiAgentsRequestV11Schema = listTuiAgentsRequestSchema.extend({
  hasDocReplica: z.boolean(),
});
export type ListTuiAgentsRequestV11 = z.infer<
  typeof listTuiAgentsRequestV11Schema
>;

export const epicListTuiAgentsV11 = defineRpcContract({
  method: "epic.listTuiAgents",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: listTuiAgentsRequestV11Schema,
  responseSchema: listTuiAgentsResponseV11Schema,
});

/**
 * Both fills are FACTS about a `@1.0` peer, not defaults - which is what makes
 * the upgraded value safe to act on rather than merely well-typed.
 *
 * REQUEST, `hasDocReplica: true`: a caller that speaks only `@1.0` predates
 * `epic.subscribe@2` entirely - `@1.1` and the `@2` stream line ship in the
 * same `@traycer/protocol`, so there is no build that has one without the
 * other. It therefore holds a doc replica, and the host must serve it registry
 * rows only. A wrong guess here would hand the oldest clients in the fleet the
 * duplicate-row conflict this whole minor exists to avoid.
 *
 * RESPONSE, `docResident: false`: a host serving `@1.0` returns REGISTRY ROWS
 * ONLY by construction, so every row an older host can produce is
 * registry-backed. A `@1.1` client reading an older host still has to union
 * that host's doc map itself - the upgrade path cannot invent rows the wire
 * never carried, and must not pretend it did.
 */
export const epicListTuiAgentsUpgradeV10ToV11 = defineUpgradePath<
  typeof epicListTuiAgentsV10,
  typeof epicListTuiAgentsV11
>({
  from: epicListTuiAgentsV10.schemaVersion,
  to: epicListTuiAgentsV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, hasDocReplica: true }),
  upgradeResponse: (response) => ({
    ...response,
    tuiAgents: response.tuiAgents.map((row) => ({
      ...row,
      docResident: false,
    })),
  }),
});
