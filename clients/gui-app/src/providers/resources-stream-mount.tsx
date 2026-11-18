import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ResourcesStreamClient } from "@traycer-clients/shared/host-transport/resources-stream-client";
import {
  useStreamHostId,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import {
  useGlobalResourcesPreCheckUnsupported,
  useGlobalResourcesUnsupported,
} from "@/hooks/resources/use-global-resources-unsupported";
import {
  holdGlobalResourcesConsumer,
  useGlobalResourcesConsumerPresent,
} from "@/stores/resources/global-resources-consumers";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import {
  createResourcesStore,
  type ResourcesStreamClientFactory,
} from "@/stores/resources/resources-store";
import { getResourcesStreamClientFactoryOverride } from "@/providers/resources-stream-factory-override";
import { useEpicResourcesLease } from "@/hooks/resources/use-epic-resources-lease";

export interface ResourcesStreamMountProps {
  readonly epicId: string;
}

export interface GlobalResourcesStreamMountProps {
  /** True only while the resource-monitor popover is actually visible. */
  readonly interactive: boolean;
}

/**
 * The epic pane's lease: held only while a global consumer is on screen AND
 * the host cannot serve a global subscribe.
 *
 * An epic's own numbers are leased by the chips that draw them, so the pane
 * holds no stream of its own. That leaves one reader no chip covers: an `@1.0`
 * host answers the global monitor through the registry's per-epic FALLBACK,
 * which aggregates whatever epic entries exist. With no pane lease there would
 * be none, and the panel (or an opted-in readout) would wait for data forever.
 * So the pane supplies its entry for exactly that window.
 *
 * The verdict is the full one - the pre-check for a local host, and the live
 * global stream's own negotiation for a remote one - read against the ambient
 * host this pane's lease would be opened on.
 *
 * The demand is the consumer itself, NOT the layout switches the pane's own
 * stream used to be gated on (the monitor's Shown, the agent rows'
 * readings): a mounted global consumer is what reads the fallback.
 */
export function EpicResourcesFallbackMount(
  props: ResourcesStreamMountProps,
): ReactNode {
  const hostId = useStreamHostId();
  const consumerPresent = useGlobalResourcesConsumerPresent(hostId);
  const globalUnsupported = useGlobalResourcesUnsupported(hostId);
  useEpicResourcesLease(props.epicId, consumerPresent && globalUnsupported);
  return null;
}

export function GlobalResourcesStreamMount(
  props: GlobalResourcesStreamMountProps,
): ReactNode {
  const wsStreamClient = useWsStreamClient();
  // Taken from the SAME binding as the client above, never from a prop or a
  // scope model: the host id republished on the projection is what a scoped
  // reader checks its data against, so it has to be the host this transport is
  // actually dialing rather than the one the caller believes it asked for.
  const hostId = useStreamHostId();
  // Registered for as long as this consumer is mounted, independent of whether
  // its stream can open, and under the host it dials - see
  // `global-resources-consumers.ts`.
  useEffect(() => holdGlobalResourcesConsumer(hostId), [hostId]);
  // The PRE-STREAM verdict only, never the full one the panel reads. The full
  // one includes this stream's own negotiation, so gating the acquire on it
  // would be a loop: acquire → learn `unsupported` → release → the verdict dies
  // with the store → acquire again. The pre-check cannot move as a result of
  // anything this effect does, which is what makes it safe to gate on.
  //
  // So a host convicted only by its own stream keeps that stream open. It costs
  // one idle subscription: an `@1.0` host answers a global probe with a single
  // empty projection and then, having nothing to say about an epic that does
  // not exist, stays silent.
  const resourcesUnsupported = useGlobalResourcesPreCheckUnsupported();
  // Bumped ONLY by the recovery listener below — never during a render.
  const [reprobeGeneration, setReprobeGeneration] = useState(0);
  // "Which stream should be open": the transport, plus the re-probe generation.
  // The generation belongs in the identity rather than in the effect alone, so
  // a bump rebuilds the entry even when a second lease holder would otherwise
  // keep the existing one alive.
  const reacquireToken = useMemo(
    () => ({ transport: wsStreamClient, reprobeGeneration }),
    [wsStreamClient, reprobeGeneration],
  );

  /**
   * Re-probes a verdict that cannot clear itself.
   *
   * A version verdict self-heals: that stream stays open, a drop takes its
   * negotiated version with it, and the resume re-negotiates. A TERMINAL
   * incompatible close has no such path — it fails only the stream, while the
   * shared session stays healthy, so the transport identity never changes and
   * nothing above would ever rebuild. A host that advertises no bridgeable
   * `resources.subscribe` and is then upgraded in place would keep being called
   * incapable for as long as this surface stayed mounted.
   *
   * Driven off transport recovery, which is the only positive evidence that the
   * host on the other end may not be the one we judged.
   */
  useEffect(() => {
    if (wsStreamClient === null) return;
    return wsStreamClient.subscribeAvailabilityRecovered(() => {
      // Read IMPERATIVELY. As an effect dependency this verdict is a loop:
      // it changes → the effect re-runs → release/acquire → the fresh store
      // reports `unknown` → it changes again. Edge-triggered off recovery it
      // cannot self-perpetuate, because a re-probe that lands on the same
      // terminal verdict emits no further recovery event.
      //
      // Gated on `unsupported` so an ordinary reconnect — including the clean
      // first open, which `RemoteStreamClient` also reports — does not tear
      // down and rebuild a working stream, losing its projection each time.
      if (resourcesRegistry.getGlobalScopeSupport(hostId) !== "unsupported") {
        return;
      }
      setReprobeGeneration((generation) => generation + 1);
    });
  }, [hostId, wsStreamClient]);

  useEffect(() => {
    if (resourcesUnsupported) return;
    const override = getResourcesStreamClientFactoryOverride();
    if (override === null && wsStreamClient === null) return;
    const clientToken: unknown = reacquireToken;
    const streamClientFactory: ResourcesStreamClientFactory =
      override !== null
        ? override
        : (scope, callbacks) => {
            if (wsStreamClient === null) {
              throw new Error(
                "GlobalResourcesStreamMount: WsStreamClient missing at open time.",
              );
            }
            return new ResourcesStreamClient({
              wsStreamClient,
              scope,
              callbacks,
            });
          };
    resourcesRegistry.acquireGlobal(clientToken, hostId, () =>
      createResourcesStore({
        scope: { kind: "global" },
        streamClientFactory,
      }),
    );
    return () => {
      resourcesRegistry.releaseGlobal();
    };
    // `hostId` belongs in the deps, not just in the closure: the name is fixed
    // at acquire time, so a host id that resolves after its transport did must
    // rebuild the entry rather than leave the projection speaking for the wrong
    // machine. In practice it now moves WITH `wsStreamClient` (one binding, one
    // change), so this rarely fires on its own.
  }, [hostId, reacquireToken, resourcesUnsupported, wsStreamClient]);

  // Demand is aggregated by the registry across every lease holder, so a
  // holder that unmounts while interactive (a header panel closing) drops the
  // shared stream back to background instead of leaving it at the cadence
  // only the departed holder asked for. Only a mount that HOLDS the
  // lease may add demand: one that acquired nothing (its host convicted by the
  // pre-check, or no transport yet) would otherwise speed up another holder's
  // stream on a machine it is not watching.
  const holdsLease =
    !resourcesUnsupported &&
    (getResourcesStreamClientFactoryOverride() !== null ||
      wsStreamClient !== null);
  useEffect(
    () =>
      props.interactive && holdsLease
        ? resourcesRegistry.holdInteractiveGlobalDemand()
        : undefined,
    [holdsLease, props.interactive],
  );

  return null;
}
