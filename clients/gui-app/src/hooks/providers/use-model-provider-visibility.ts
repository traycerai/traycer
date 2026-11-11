import { useCallback, useMemo, useRef, useState } from "react";
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
  /** Which choice on this row this is; a later click replaces it. */
  readonly generation: number;
  /** When its write succeeded, or `null` while it is queued or in flight. */
  readonly settledAt: number | null;
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
 * Each row holds the choice this window just made until `providers.list` reads
 * back AFTER that row's own write succeeded. Writes on one host queue behind
 * each other, so a read that lands after another row's write, or an unrelated
 * refresh, says nothing about this row: keying the hold on "any newer read"
 * flipped a queued row back on while its write was still waiting. The
 * mutation invalidates `providers.list` as it settles, before the per-call
 * callbacks below run, so a read stamped at or after `settledAt` is that
 * read-back. A read that fails after it releases the hold too, so a row is
 * never stuck disabled.
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
  const { dataUpdatedAt, errorUpdatedAt } = providersQuery;
  const [echoes, setEchoes] = useState(NO_ECHOES);
  const generationRef = useRef(0);
  const storedIds = useMemo(() => new Set(stored ?? []), [stored]);

  const heldEcho = useCallback(
    (modelProviderId: string): VisibilityEcho | null => {
      const echo = echoes.get(modelProviderId);
      if (echo === undefined) return null;
      if (echo.settledAt === null) return echo;
      return dataUpdatedAt < echo.settledAt && errorUpdatedAt < echo.settledAt
        ? echo
        : null;
    },
    [dataUpdatedAt, echoes, errorUpdatedAt],
  );

  const isShown = useCallback(
    (modelProviderId: string) =>
      !(heldEcho(modelProviderId)?.hidden ?? storedIds.has(modelProviderId)),
    [heldEcho, storedIds],
  );
  const isSettling = useCallback(
    (modelProviderId: string) => heldEcho(modelProviderId) !== null,
    [heldEcho],
  );
  const mutateAsync = setHidden.mutateAsync;
  const setShown = useCallback(
    (modelProviderId: string, shown: boolean) => {
      const hidden = !shown;
      generationRef.current += 1;
      const generation = generationRef.current;
      // Touches only this row's echo, and only while it is still this click's:
      // a later click on the same row owns it from then on.
      const settle = (settledAt: number | null): void => {
        setEchoes((previous) => {
          const echo = previous.get(modelProviderId);
          if (echo === undefined || echo.generation !== generation) {
            return previous;
          }
          const next = new Map(previous);
          if (settledAt === null) next.delete(modelProviderId);
          else next.set(modelProviderId, { ...echo, settledAt });
          return next;
        });
      };
      setEchoes((previous) =>
        new Map(previous).set(modelProviderId, {
          hidden,
          generation,
          settledAt: null,
        }),
      );
      // `mutateAsync`, not `mutate(vars, callbacks)`: per-call callbacks fire
      // only for the observer's LATEST call, so a row clicked before another
      // row's write settled would never settle. The promise is per call.
      void mutateAsync({ harnessId, modelProviderId, hidden }).then(
        () => {
          settle(Date.now());
        },
        // A refused write leaves the stored list where it was; the hook's toast
        // says what happened and this puts the switch back.
        () => {
          settle(null);
        },
      );
    },
    [harnessId, mutateAsync],
  );

  return { supported, isShown, isSettling, setShown };
}
