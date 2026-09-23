/**
 * The two identity lanes are ONE capability, and this is where that is
 * enforced.
 *
 * The contracts state the rule and give the reason: `agentIdentity.file
 * .subscribe` requires an `authorityEpoch` on its open request, and
 * `agentIdentity.state.subscribe` is the only thing that mints one. A host
 * advertising the body lane alone therefore serves a lane nothing can legally
 * attach to; one advertising the index lane alone serves an identity whose files
 * can be listed and never opened. Either way the Identities surface cannot be
 * rendered honestly, so the client treats the pair as indivisible.
 *
 * ## The degrade here is HIDDEN, not legacy
 *
 * This is the one place the identity lanes differ from the epic ones. A host
 * without the epic lanes still serves `epic.subscribe@1`, so that predicate
 * chooses between two working paths. There is no `@1` for identities: the whole
 * `agentIdentity.*` family is post-v1.0.0 and registered `degrade: { kind:
 * "unsupported" }`, so a host that lacks it has no identities at all and the
 * client hides the section rather than degrading it.
 *
 * That makes failing CLOSED even more important than it is for the epic lanes. A
 * client that guessed yes would render an Identities list, open a subscription
 * the host answers with a fatal, and leave a user looking at an empty panel with
 * no explanation - where failing closed simply does not offer the feature.
 */

/**
 * The two method names, in one place so a selector cannot check one of them.
 *
 * A tuple rather than two exported constants: the failure this module exists to
 * prevent is checking a SUBSET, and two separate constants invite exactly that
 * at every call site.
 */
export const AGENT_IDENTITY_LANE_METHODS = [
  "agentIdentity.state.subscribe",
  "agentIdentity.file.subscribe",
] as const;

/**
 * Whether this connection may open the identity lanes.
 *
 * `support` answers per method in the transport's own three-valued vocabulary:
 * `"supported"`, `"unsupported"`, or `"unknown"` when the handshake has not
 * settled - and a remote mux transport answers `"unknown"` forever, because it
 * resolves an incompatible method as a fatal on the subscribe attempt rather
 * than as a queryable pre-check. `"unknown"` must therefore not be read as a
 * yes: a client that waited for it to resolve would wait for nothing, and one
 * that took it as support would open two lanes against a host that answers
 * neither.
 *
 * This answers for the STREAMS only. The family's unaries degrade through the
 * RPC manifest's own `unsupported` channel, which a caller reads there; a client
 * that finds either half missing must treat the whole family as absent, because
 * an Identities panel that can subscribe and cannot create is not a feature.
 */
export function hostServesAgentIdentityLanes(
  support: (method: string) => "unknown" | "supported" | "unsupported",
): boolean {
  return AGENT_IDENTITY_LANE_METHODS.every(
    (method) => support(method) === "supported",
  );
}
