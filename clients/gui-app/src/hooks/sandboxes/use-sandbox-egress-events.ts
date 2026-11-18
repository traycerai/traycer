import { useEffect, useState } from "react";
import {
  SANDBOX_EGRESS_SNAPSHOT_MAX_EVENTS,
  sandboxEgressSubscribeServerFrameSchemaV10,
  type SandboxEgressEvent,
} from "@traycer/protocol/host/sandbox-egress";
import { useSurfaceHostStreamBinding } from "@/hooks/host/use-surface-host-stream-binding";
import { useStreamMethodSupportFor } from "@/lib/host/stream-runtime-context";

const NO_EVENTS: readonly SandboxEgressEvent[] = [];

/**
 * `events` as they stand after `incoming`: appended, a replayed id dropped,
 * and the oldest dropped past the snapshot cap, so a long-lived card holds no
 * more than a fresh one would be sent.
 */
export function appendSandboxEgressEvent(
  events: readonly SandboxEgressEvent[],
  incoming: SandboxEgressEvent,
): readonly SandboxEgressEvent[] {
  if (events.some((event) => event.id === incoming.id)) return events;
  const next = [...events, incoming];
  return next.length > SANDBOX_EGRESS_SNAPSHOT_MAX_EVENTS
    ? next.slice(next.length - SANDBOX_EGRESS_SNAPSHOT_MAX_EVENTS)
    : next;
}

interface HeldEvents {
  /** The host the events belong to, so one host's are never shown as another's. */
  readonly hostId: string;
  readonly events: readonly SandboxEgressEvent[];
}

/**
 * The typed egress events of one sandbox host
 * (`host.sandbox.egress.subscribe@1.0`), oldest first: refusals, teardowns,
 * held connections and unsupported modes, as its forwarder and the gateway
 * raise them.
 *
 * `hostId` is `null` while the sandbox is not awake: nothing is brokered then
 * and the stream has nothing to say, and a card on screen must not be the
 * reason a connection is held to a sleeping sandbox. A host that does not
 * serve the stream (one from before it, or any host that is not a sandbox)
 * yields no events.
 */
export function useSandboxEgressEvents(
  hostId: string | null,
): readonly SandboxEgressEvent[] {
  const binding = useSurfaceHostStreamBinding(hostId);
  // Only a client proven to be this host's: the binding is the ambient one
  // while `hostId` is null, and that is some other machine.
  const client =
    hostId !== null && binding !== null && binding.hostId === hostId
      ? binding.wsStreamClient
      : null;
  const support = useStreamMethodSupportFor(
    client,
    "host.sandbox.egress.subscribe",
  );
  const [held, setHeld] = useState<HeldEvents | null>(null);
  useEffect(() => {
    if (client === null || hostId === null || support === "unsupported") {
      return undefined;
    }
    let active = true;
    const session = client.subscribe("host.sandbox.egress.subscribe", {});
    session.onServerFrame((envelope) => {
      if (!active) return;
      const parsed =
        sandboxEgressSubscribeServerFrameSchemaV10.safeParse(envelope);
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.kind === "snapshot") {
        setHeld({ hostId, events: frame.events });
        return;
      }
      if (frame.kind === "event") {
        setHeld((current) => ({
          hostId,
          events: appendSandboxEgressEvent(
            current !== null && current.hostId === hostId
              ? current.events
              : NO_EVENTS,
            frame.event,
          ),
        }));
      }
    });
    return () => {
      active = false;
      session.close();
    };
  }, [client, hostId, support]);
  return held !== null && held.hostId === hostId ? held.events : NO_EVENTS;
}
