import type { SandboxEgressEvent } from "@traycer/protocol/host/sandbox-egress";
import { sandboxEgressRefusalCopyFor } from "@/lib/sandboxes/sandbox-egress-refusal-copy";

/**
 * One typed egress event as the sandbox card shows it. The same table the
 * transcript reads names a refusal (`sandbox-egress-refusal-copy.ts`), so a
 * database, SSH or broker refusal - which reaches its own client only as that
 * protocol's authentication failure - reads here as what it really was.
 */
export interface SandboxEgressEventLine {
  readonly id: string;
  readonly at: number;
  /** `refused` and `closed` are things that went wrong for a client. */
  readonly tone: "refused" | "closed" | "notice";
  readonly headline: string;
  readonly description: string;
  /** The route the event is about, for joining its destination; else `null`. */
  readonly route: string | null;
  /**
   * The sandbox raised it about itself, so anything running on the sandbox
   * could have shaped it. Shown, so the line is never read as Traycer's word.
   */
  readonly reportedBySandbox: boolean;
}

/** The longest run of emitter-authored text one field contributes. */
const FIELD_MAX_LENGTH = 120;

function clamp(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > FIELD_MAX_LENGTH
    ? `${trimmed.slice(0, FIELD_MAX_LENGTH)}…`
    : trimmed;
}

function clampOrNull(text: string | null): string | null {
  if (text === null) return null;
  const clamped = clamp(text);
  return clamped.length === 0 ? null : clamped;
}

const TEARDOWN_DESCRIPTION: Record<
  Extract<SandboxEgressEvent, { kind: "egress.teardown" }>["reason"],
  string
> = {
  revoke:
    "The grant behind this route was revoked or changed, so its open connections were closed. Anything the destination had already accepted is not undone.",
  stale:
    "Traycer could not confirm this sandbox's grants, so the route's open connections were closed. They can reopen once authorization is confirmed.",
  resume:
    "The sandbox woke with a new gateway credential, so connections from before it slept were closed. Reconnect.",
  drain:
    "Traycer's gateway was restarting, so the route's connections were closed. Reconnect.",
  secret_rotated:
    "This secret's value was replaced, so connections opened with the old value were cut. Anything the destination had already accepted is not undone. Reconnect.",
};

/** "0.4 s", "12 s", "3 min". */
function formatWaited(waitedMs: number): string {
  if (waitedMs < 1000) return `${(waitedMs / 1000).toFixed(1)} s`;
  const seconds = Math.round(waitedMs / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

export function sandboxEgressEventLine(
  event: SandboxEgressEvent,
): SandboxEgressEventLine {
  const base = {
    id: event.id,
    at: event.at,
    reportedBySandbox: event.untrusted,
  };
  switch (event.kind) {
    case "egress.refused": {
      const subject = {
        secret: clampOrNull(event.secret),
        host: clampOrNull(event.host),
        protocol: clampOrNull(event.protocol),
      };
      const copy = sandboxEgressRefusalCopyFor(event.code, subject);
      return {
        ...base,
        tone: "refused",
        headline:
          copy === null ? `Refused: ${clamp(event.code)}` : copy.headline,
        description:
          copy === null
            ? `A connection to ${subject.host ?? "a destination"} was refused.`
            : copy.description,
        route: event.route,
      };
    }
    case "egress.teardown":
      return {
        ...base,
        tone: "closed",
        headline: "Connections closed",
        description: TEARDOWN_DESCRIPTION[event.reason],
        route: event.route,
      };
    case "egress.held":
      return {
        ...base,
        tone: "notice",
        headline: "Connection held while waking",
        description: `A connection waited ${formatWaited(event.waitedMs)} for the sandbox to finish waking, then went through.`,
        route: event.route,
      };
    case "egress.unsupported_mode": {
      const reason = clamp(event.reason);
      return {
        ...base,
        tone: "refused",
        headline: "Mode not supported",
        description:
          reason.length === 0
            ? `${clamp(event.mode)} is not carried on this route.`
            : `${clamp(event.mode)} is not carried on this route: ${reason}`,
        route: event.route,
      };
    }
  }
}

/** How many events the card lists; the newest, newest first. */
export const SANDBOX_CARD_EGRESS_EVENT_LIMIT = 5;

export function sandboxCardEgressEventLines(
  events: readonly SandboxEgressEvent[],
): readonly SandboxEgressEventLine[] {
  return events
    .slice(-SANDBOX_CARD_EGRESS_EVENT_LIMIT)
    .reverse()
    .map(sandboxEgressEventLine);
}
