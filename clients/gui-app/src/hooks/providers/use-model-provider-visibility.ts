import { useCallback, useMemo, useState } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  useHostMethodSchemaVersion,
  useHostMethodSupport,
} from "@/hooks/host/use-host-supports-method";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSetModelProviderHidden } from "@/hooks/providers/use-providers-set-model-provider-hidden-mutation";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { providersListReportsHiddenModelProviders } from "@/lib/providers/provider-hidden-model-providers";

export type ModelProviderVisibility = {
  /** The host reads AND writes the list, so rows draw the switch. */
  readonly supported: boolean;
  readonly isShown: (modelProviderId: string) => boolean;
  /** This row's write, or the read-back it triggered, is still in flight. */
  readonly isSettling: (modelProviderId: string) => boolean;
  readonly setShown: (modelProviderId: string, shown: boolean) => void;
};

type VisibilityEcho = {
  readonly hidden: boolean;
  /** The stored value the choice was made against. */
  readonly against: boolean;
  /** `providers.list`'s `dataUpdatedAt` when the choice was made. */
  readonly seenAt: number;
};

const NO_ECHOES: ReadonlyMap<string, VisibilityEcho> = new Map();

/**
 * Which model providers a harness's pickers show, as the Model Providers tab's
 * switches read and write it.
 *
 * Drawn only when the host can READ the list back (`providers.list@10.10`, and
 * the row carries the field) AND WRITE it (`providers.setModelProviderHidden`,
 * an optional method). A host without either shows no switch, and its pickers
 * hide nothing.
 *
 * Each row holds the choice this window just made until the host's own echo
 * comes back through `providers.list`, as `ProviderNativeMemoryGroup` does: the
 * mutation reports success while the refetch it triggered is still in flight.
 * The echo is per row, so a write on one row never holds another.
 */
export function useModelProviderVisibility(args: {
  readonly hostId: string | null;
  readonly providerId: ProviderId;
  /** The row's `hiddenModelProviders`; `undefined` from a host that has none. */
  readonly stored: readonly string[] | undefined;
}): ModelProviderVisibility {
  const { hostId, providerId, stored } = args;
  const setSupported = useHostMethodSupport(
    hostId,
    "providers.setModelProviderHidden",
  );
  const readable = providersListReportsHiddenModelProviders(
    useHostMethodSchemaVersion(hostId, "providers.list"),
  );
  const supported = setSupported === true && readable && stored !== undefined;
  const harnessId = providerIdToGuiHarnessId(providerId);
  const setHidden = useProvidersSetModelProviderHidden(harnessId);
  const providersQuery = useProvidersList({
    enabled: supported,
    subscribed: supported,
  });
  const updatedAt = providersQuery.dataUpdatedAt;
  const readBackInFlight = setHidden.isPending || providersQuery.isFetching;
  const [echoes, setEchoes] = useState(NO_ECHOES);
  const storedIds = useMemo(() => new Set(stored ?? []), [stored]);

  const liveEcho = useCallback(
    (modelProviderId: string): VisibilityEcho | null => {
      const echo = echoes.get(modelProviderId);
      if (echo === undefined) return null;
      if (echo.against !== storedIds.has(modelProviderId)) return null;
      return echo.seenAt === updatedAt ? echo : null;
    },
    [echoes, storedIds, updatedAt],
  );

  const isShown = useCallback(
    (modelProviderId: string) =>
      !(liveEcho(modelProviderId)?.hidden ?? storedIds.has(modelProviderId)),
    [liveEcho, storedIds],
  );
  const isSettling = useCallback(
    (modelProviderId: string) =>
      readBackInFlight && liveEcho(modelProviderId) !== null,
    [liveEcho, readBackInFlight],
  );
  const mutate = setHidden.mutate;
  const setShown = useCallback(
    (modelProviderId: string, shown: boolean) => {
      const hidden = !shown;
      setEchoes((previous) =>
        new Map(previous).set(modelProviderId, {
          hidden,
          against: storedIds.has(modelProviderId),
          seenAt: updatedAt,
        }),
      );
      mutate(
        { harnessId, modelProviderId, hidden },
        {
          // A refused write leaves the stored list where it was; the toast says
          // what happened and this puts the switch back.
          onError: () => {
            setEchoes((previous) => {
              const next = new Map(previous);
              next.delete(modelProviderId);
              return next;
            });
          },
        },
      );
    },
    [harnessId, mutate, storedIds, updatedAt],
  );

  return { supported, isShown, isSettling, setShown };
}
