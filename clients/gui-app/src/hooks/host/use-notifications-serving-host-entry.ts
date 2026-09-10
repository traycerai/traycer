import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useReactiveLocalHostEntry } from "@/hooks/host/use-reactive-local-host-entry";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * The host whose stream serves this client's notification feeds.
 *
 * A shell that HAS a local host serves notifications from it and only from
 * it - never from whichever host happens to be active in a composer/tab
 * elsewhere in the app - so on those shells this is exactly
 * `useReactiveLocalHostEntry()`.
 *
 * A shell that has NO local host at all (a relay-only shell: mobile, web)
 * has nothing to bind that rule to, so the same streams bind to the BOUND
 * host instead. That is a fallback, not a replacement: it can only be
 * reached where the local-host rule has no subject.
 *
 * Serving-host choice is transport, not content. Both feeds are reached
 * THROUGH a host rather than owned by one, and the cloud plane behind them is
 * a per-user, cross-device store every host relays the same merged view of -
 * so which host serves a relay-only shell changes who carries the bytes, not
 * which rows exist.
 *
 * The fallback is gated on the SHELL's declared capability
 * (`IRunnerHost.hasLocalHost`), not on the shell's identity and not on "the
 * local entry is null at this instant":
 *
 *  - Capability rather than identity keeps the rule shell-agnostic: every
 *    relay-only shell takes this path, whatever platform it runs on.
 *  - Capability rather than a momentarily absent entry is what keeps a
 *    booting local host from being stood in for. A local host that has not
 *    published yet leaves `useReactiveLocalHostEntry()` null for a while, and
 *    falling back across that window would serve another machine's feed and
 *    then tear it down the moment the local host lands.
 *
 * `null` before the host runtime resolves a binding, and on a relay-only
 * shell before a host is bound - callers open no stream until one exists.
 */
interface ServingHostSelection {
  /** The local host's entry, and the answer outright whenever it exists. */
  readonly localEntry: HostDirectoryEntry | null;
  /**
   * The bound host's id when this shell TAKES the relay-only fallback, and
   * `null` whenever it does not - so a consumer never has to re-derive the
   * gate to know whether the id in hand is admissible.
   */
  readonly fallbackHostId: string | null;
}

/**
 * The serving-host RULE, resolved once for both projections below.
 *
 * Deliberately a shared internal rather than two hooks that each re-derive it:
 * a second copy is a second selector, and the two would drift on exactly the
 * shell where only one of them is exercised.
 *
 * Every read here is null-tolerant outside a `<HostRuntimeProvider>`
 * (`useHostBinding` is a bare context read, `useRunnerHostOrNull` is null by
 * name, and `useAddressableHostId` documents the same tolerance), which is what
 * lets {@link useNotificationsServingHostId} be called from ordinary chrome.
 */
function useServingHostSelection(): ServingHostSelection {
  const localEntry = useReactiveLocalHostEntry();
  const runnerHost = useRunnerHostOrNull();
  const boundHostId = useAddressableHostId();
  // An undeclared shell (no `RunnerHostProvider` in the tree) is treated as
  // local-capable, so a harness that never states which shell it is cannot
  // silently acquire the fallback.
  const takesFallback =
    localEntry === null && runnerHost !== null && !runnerHost.hasLocalHost;
  return {
    localEntry,
    fallbackHostId: takesFallback ? boundHostId : null,
  };
}

export function useNotificationsServingHostEntry(): HostDirectoryEntry | null {
  const { localEntry, fallbackHostId } = useServingHostSelection();
  // Read through the same directory every other host consumer binds through,
  // so this is the app's existing notion of "the bound host" projected as an
  // entry - not a second, independently drifting selector.
  //
  // Looked up under the empty id unless the fallback is actually taken, so a
  // shell that will never consult it holds a permanently-null snapshot here
  // and cannot rebind a stream over a directory row it would discard. It does
  // NOT make this hook inert on such a shell: `useAddressableHostId` is
  // subscribed unconditionally, so an active-host switch still re-renders
  // consumers. That render carries no new value - the returned entry, and
  // every callback and effect keyed on it, are unchanged - so it settles
  // without reopening anything.
  const boundEntry = useHostDirectoryEntry(fallbackHostId ?? "");
  if (localEntry !== null) return localEntry;
  return fallbackHostId === null ? null : boundEntry;
}

/**
 * {@link useNotificationsServingHostEntry}'s ID half, for consumers that only
 * need to name the serving host rather than address it.
 *
 * Not `useNotificationsServingHostEntry()?.hostId`: that hook resolves the
 * fallback through `useHostDirectoryEntry`, which reads `useHostDirectory()`
 * and therefore THROWS outside a `<HostRuntimeProvider>`. The notification
 * indicator query and the tab strip read this id from trees with no host
 * runtime at all, so composing the entry hook there would turn a null host
 * into a render crash.
 *
 * The id needs no directory row to be correct: `useAddressableHostId` is
 * already resolved against the directory and answers `null` until the bound
 * host's row exists, which is the same instant the entry stops being `null`.
 */
export function useNotificationsServingHostId(): string | null {
  const { localEntry, fallbackHostId } = useServingHostSelection();
  return localEntry?.hostId ?? fallbackHostId;
}
