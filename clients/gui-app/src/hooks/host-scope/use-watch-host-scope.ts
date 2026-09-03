import {
  useHostScopeFor,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { useWatchHostStore } from "@/stores/host-scope/watch-host-store";

/**
 * Which host the app's WATCHING surfaces are reading — the usage glyph and its
 * popover, the resource monitor, and the bottom strip that hosts both when the
 * placement moves there.
 *
 * One pick, one resolution, one hook. They are not three surfaces that happen
 * to agree: the strip's chip and the popover it opens are the same choice seen
 * twice, so a second derivation of the same store is a way for them to disagree
 * for a commit — which is the whole failure the host-scope contract exists to
 * prevent, arrived at from inside.
 *
 * The queries underneath (`useHostDirectoryList`, `useRegisteredHosts`) are the
 * shared, already-cached ones every other host surface reads, so a watcher
 * joins their subscribers rather than opening a second source of host truth.
 */
export interface WatchHostScope {
  readonly scope: HostScope;
  /**
   * A host was EXPLICITLY picked, as opposed to following the active one.
   *
   * This is the difference between "I cannot show you the machine you chose"
   * and "the machine this window runs on is having a moment", and only the
   * first is worth replacing readings with a notice. Following the active host,
   * an `unreachable` scope is routine - a directory entry blips `unavailable`,
   * and the rate-limit envelope's whole `lastGood`/`degraded` design exists to
   * keep showing the last real reading through exactly that. Trading that for a
   * notice would make a single-host user strictly worse off for a picker they
   * never used.
   *
   * It is also the burden of proof a projection has to meet before its numbers
   * may be printed under a host's name (`attributedProjection`).
   *
   * `HostScope` alone cannot answer it: `unreachable` and `connecting` look
   * identical whether they came from a pick or from the active host.
   */
  readonly hasExplicitPick: boolean;
}

export function useWatchHostScope(): WatchHostScope {
  const scopedHostId = useWatchHostStore((state) => state.scopedHostId);
  const setScopedHostId = useWatchHostStore((state) => state.setScopedHostId);
  const scope = useHostScopeFor({ scopedHostId, setScopedHostId });
  return { scope, hasExplicitPick: scopedHostId !== null };
}
