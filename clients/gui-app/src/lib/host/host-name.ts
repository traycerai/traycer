/**
 * What copy calls a host by. Pure and import-free, so `@/lib/host` itself and
 * the runtime provider it re-exports can name a host without a cycle through
 * the hooks; `use-host-reachability` re-exports these for everyone else.
 */

/**
 * What copy calls a host the directory has no name for: before it resolves, a
 * host it does not list, a listed one whose label is empty or the id itself.
 * Never the host id, which names nothing a person can act on; keys and
 * diagnostics use `hostId`.
 */
export const UNNAMED_HOST_LABEL = "the host";

/**
 * A label as a host's name, or {@link UNNAMED_HOST_LABEL}: an empty label, or
 * one that is the host id itself, names nothing. The registry hands a host it
 * has no display name for to the directory labelled with its id
 * (`hostListItemToDirectoryEntry`), so a label is not a name just for being
 * there.
 */
export function hostNameFromLabel(
  label: string | null,
  hostId: string,
): string {
  if (label === null || label.length === 0 || label === hostId) {
    return UNNAMED_HOST_LABEL;
  }
  return label;
}

/**
 * A host label where it opens a sentence: "The host" when the host has no
 * name, a real name exactly as the host reported it - never recapitalized.
 */
export function hostLabelAtSentenceStart(hostLabel: string): string {
  return hostLabel === UNNAMED_HOST_LABEL ? "The host" : hostLabel;
}

/**
 * A host where copy quotes its name: `host "Ada's Mac"`, or "the host" when it
 * has none - never `host "the host"`. `atSentenceStart` capitalizes the
 * leading word, which is never part of the name.
 */
export function quotedHostReference(
  hostLabel: string,
  atSentenceStart: boolean,
): string {
  if (hostLabel === UNNAMED_HOST_LABEL) {
    return atSentenceStart ? "The host" : UNNAMED_HOST_LABEL;
  }
  return `${atSentenceStart ? "Host" : "host"} "${hostLabel}"`;
}
