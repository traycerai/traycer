/**
 * User-facing copy for an `agentIdentity.*` refusal.
 *
 * The wire `detail` is a host-side log summary and is never rendered; every
 * reason the family can answer has a sentence here, and an unknown one (a
 * newer host) falls back to a generic line rather than to the detail.
 */
import type { AgentIdentityRefusalReason } from "@traycer/protocol/host/agent-identity/schemas";

const REFUSAL_COPY: Readonly<Record<AgentIdentityRefusalReason, string>> = {
  identityNotFound: "This identity no longer exists on the host.",
  invalidPath:
    "That name isn't allowed. Use letters, digits, dots, dashes and folders like memories/ or skills/.",
  pathExists: "A file with that name already exists.",
  pathNotFound: "That file no longer exists.",
  unsupportedBodyKind: "This kind of file can't be edited here.",
  tooLarge: "That file is too large for an identity.",
  capExceeded: "This identity already holds as many files as it can.",
  refusedContent: "The host refused this content.",
  projectionUnavailable: "The host can't read this identity right now.",
};

export function identityRefusalCopy(reason: string): string {
  return (
    (REFUSAL_COPY as Readonly<Record<string, string>>)[reason] ??
    "The host refused this change."
  );
}
