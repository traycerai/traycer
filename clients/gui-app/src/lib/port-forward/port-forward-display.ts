import type {
  ChatPortForward,
  PortForwardEvent,
  PortForwardEventKind,
} from "@traycer/protocol/host/port-forward";

/** The port a person types into a browser: the bound one, once there is one. */
export function portForwardListenPort(forward: ChatPortForward): number {
  return forward.listen.boundPort ?? forward.listen.requestedPort;
}

export function portForwardEventLabel(kind: PortForwardEventKind): string {
  switch (kind) {
    case "port-taken":
      return "Port taken";
    case "target-refused":
      return "Nothing listening";
    case "lease-reaped":
      return "Lease ended";
    case "link-dropped":
      return "Link dropped";
    case "cut-by-user":
      return "Cut";
  }
  const unreachableKind: never = kind;
  return unreachableKind;
}

export interface KeyedPortForwardEvent {
  readonly key: string;
  readonly event: PortForwardEvent;
}

/**
 * A forward's recent events, newest first, each with a key that is stable
 * across re-renders. An event carries no id, and two refusals can share a
 * millisecond, so the key is the event's own `(atMs, kind)` plus how many of
 * that pair came before it - counted oldest first, so a new event arriving at
 * the head never renames the ones already on screen.
 */
export function keyedPortForwardEventsNewestFirst(
  events: ReadonlyArray<PortForwardEvent>,
): KeyedPortForwardEvent[] {
  const seen = new Map<string, number>();
  const keyed: KeyedPortForwardEvent[] = [];
  for (const event of events) {
    const base = `${event.atMs}-${event.kind}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    keyed.push({ key: `${base}-${occurrence}`, event });
  }
  return keyed.reverse();
}
