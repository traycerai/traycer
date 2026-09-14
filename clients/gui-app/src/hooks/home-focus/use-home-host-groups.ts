import { useMemo } from "react";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import {
  focusHostIds,
  isUnknownHostId,
  shouldGroupByHost,
} from "@/lib/home-focus/focus-host-groups";
import type { FocusModel } from "@/lib/home-focus/focus-model";

const FIELD_SEPARATOR = "\u0000";
const ENTRY_SEPARATOR = "\u0001";

/** What the unknown bucket's subheading says. A sentence rather than the
 * sentinel id, which is an implementation detail no reader should meet. */
const UNKNOWN_HOST_LABEL = "Unknown host";

/**
 * Everything Home needs to split its sections by machine: whether to split at
 * all, the order the machines go in, and what to call them.
 *
 * One hook for the whole page rather than one per section, because "does this
 * page span more than one host" is a single decision across every row (see
 * `focusHostIds`). The sections then each group their own rows against the same
 * answer.
 *
 * `useEffectiveHostId` is the right scope here, not a tab host: Home is an
 * app-wide surface with no tab of its own, and the active host is both what an
 * unnamed row resolves to and what the `active` pill marks.
 */
export interface HomeHostGrouping {
  /** `false` on the common single-host install, and then the page renders
   * exactly as it did before host grouping existed. */
  readonly enabled: boolean;
  readonly activeHostId: string | null;
  readonly registryOrder: ReadonlyArray<string>;
  /** The host's display name, falling back to its id - which is ugly and
   * honest, and better than a heading that says "another host" twice. The
   * unknown bucket gets a real sentence instead, since its "id" is a sentinel
   * no reader should ever see. */
  readonly labelOf: (hostId: string) => string;
}

export function useHomeHostGroups(model: FocusModel): HomeHostGrouping {
  const activeHostId = useEffectiveHostId();
  // The list hook rather than the raw picker query: it owns the directory
  // binding, its registration and the change subscription that refetches when a
  // host joins or leaves, so this page sees a fleet that moves.
  const hosts = useHostDirectoryList();
  // Encoded to a primitive so the memo below does not rebuild on every query
  // emit: the query hands back a fresh array whenever the directory re-emits,
  // including for changes to fields this page never reads. Two NUL
  // separators, the one byte neither a host id nor a label can carry - the same
  // encoding `use-focus-model` uses for its own ref keys.
  const registryKey = (hosts.data ?? [])
    .map((entry) => [entry.hostId, entry.label].join(FIELD_SEPARATOR))
    .join(ENTRY_SEPARATOR);
  return useMemo(() => {
    const labels = new Map<string, string>();
    const registryOrder: string[] = [];
    for (const entry of registryKey.length === 0
      ? []
      : registryKey.split(ENTRY_SEPARATOR)) {
      const separator = entry.indexOf(FIELD_SEPARATOR);
      if (separator < 0) continue;
      const hostId = entry.slice(0, separator);
      registryOrder.push(hostId);
      const label = entry.slice(separator + 1);
      if (label.length > 0) labels.set(hostId, label);
    }
    return {
      enabled: shouldGroupByHost(focusHostIds(model, activeHostId)),
      activeHostId,
      registryOrder,
      labelOf: (hostId: string) =>
        isUnknownHostId(hostId)
          ? UNKNOWN_HOST_LABEL
          : (labels.get(hostId) ?? hostId),
    };
  }, [model, activeHostId, registryKey]);
}
