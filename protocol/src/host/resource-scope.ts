/**
 * The one scope a host-owned resource is addressed under: one epic, or no epic
 * at all.
 *
 * Plain terminals, browser sessions and the local-servers request all answer
 * the same question - "which epic does this belong to, if any?" - and before
 * this module they answered it in three separate spellings. Structural
 * identity is not one definition: the host's lifted scope-match predicate is
 * typed against a single union, and two copies of an authorization scope drift
 * into a silently widened boundary, not into a type error.
 *
 * The discriminant is the whole encoding. `independent` carries no epic id
 * because there is none to carry, so an "unlinked" resource can never be
 * addressed by an epic-scoped subscriber through a sentinel or an empty
 * string.
 *
 * TWO NEIGHBOURS THAT ARE DELIBERATELY NOT THIS UNION:
 *
 * - `terminalScopeSchema` (`terminal/unary-schemas.ts`) is this union's
 *   RELEASED twin, with non-strict members and no `min(1)` on `epicId`. It is
 *   bound into the major-2 terminal unary lines and `terminal.subscribe@1.4`,
 *   so tightening it would narrow an already-shipped client->host slot. Leave
 *   it where it is; it is frozen by release, not by preference.
 * - `plainTerminalScopeSchemaV10` (`terminal/plain-v1-schemas.ts`) keeps its
 *   own literal copy for the same reason - a frozen file's whole job is to
 *   stop moving when this one changes.
 *
 * `resourcesSubscribeScopeSchema` (`resources/subscribe.ts`) is a third,
 * unrelated concept despite the shared word: its `global` member means "every
 * epic's owners", not "the owners with no epic".
 */
import { z } from "zod";

export const epicHostResourceScopeSchema = z.strictObject({
  kind: z.literal("epic"),
  epicId: z.string().min(1),
});
export type EpicHostResourceScope = z.infer<typeof epicHostResourceScopeSchema>;

export const independentHostResourceScopeSchema = z.strictObject({
  kind: z.literal("independent"),
});
export type IndependentHostResourceScope = z.infer<
  typeof independentHostResourceScopeSchema
>;

export const hostResourceScopeSchema = z.discriminatedUnion("kind", [
  epicHostResourceScopeSchema,
  independentHostResourceScopeSchema,
]);
export type HostResourceScope = z.infer<typeof hostResourceScopeSchema>;
