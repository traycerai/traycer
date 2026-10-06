import type { MutationScope } from "@tanstack/react-query";

/**
 * Write key for the account-wide chat auto-archive setting
 * (`chatAutoArchive.set`). Its own namespace for the reason
 * `autoModeMutationKeys` has one: the method proxies an account record on
 * traycer-server, not a host file, so a queued save is never mistaken for a
 * machine-config write.
 */
export const chatAutoArchiveMutationKeys = {
  set: () => ["chatAutoArchive.set"] as const,
};

/**
 * The save queue, ONE for the whole app rather than one per host, for the
 * reason `autoPolicyWriteScope` gives: the record is account-wide and
 * last-write-wins, so two hosts are two routes to the same row. Keyed per host,
 * a save through host A still pending while Settings moves to host B could be
 * overtaken by B's newer save and then land last, replacing it.
 */
export function chatAutoArchiveWriteScope(): MutationScope {
  return { id: "chatAutoArchive.set:account" };
}
