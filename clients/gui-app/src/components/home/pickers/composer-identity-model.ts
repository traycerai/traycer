/**
 * What a composer's identity control shows, derived in one place so the
 * desktop dropdown and the phone options sheet cannot disagree about it.
 *
 * ## Whose host
 *
 * The composer's RUN TARGET - the host the chat is (or will be) created on and
 * runs its turns on: a chat tab's bound host, the landing composer's placement,
 * the new-conversation modal's pinned host. The same id the harness/model
 * picker resolves its catalog through, and for the same reason: an identity the
 * control offers has to be one that host can inject. Never the app-wide
 * effective host.
 *
 * ## Gate
 *
 * The control exists only while that host advertises `agentIdentity.list`, the
 * unary the whole family is gated on (the header's Identities button reads the
 * same probe). The picker needs nothing else: it lists and writes a field on
 * the settings tuple. The lane pair (`hostServesAgentIdentityLanes`) is the
 * identity TAB's gate, and a remote mux transport answers `unknown` for it
 * forever, so gating a composer control on it would hide the picker on every
 * remote host. A host without the family renders no control, and an
 * `identityId` already on the chat is left on the tuple for that host to
 * ignore - clearing it would lose the choice for a host that does serve it.
 *
 * ## Resolution
 *
 * The toolbar store holds the raw id and never clears it on its own. This
 * classifies it against the host's list:
 *
 * - `none` - no identity.
 * - `selected` - the list returns it.
 * - `removed` - the list has LOADED and does not return it: the identity was
 *   deleted (tombstoned) since the chat picked it. The control says so and
 *   offers a one-click clear; it never clears silently, because a list is only
 *   as good as the read behind it.
 * - `unresolved` - an id is set and the list has not loaded (or failed). The
 *   id is shown as-is rather than guessed at either way.
 */
import { useStore } from "zustand";
import type { AgentIdentitySummary } from "@traycer/protocol/host/agent-identity/schemas";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useIdentityListForClient } from "@/hooks/identities/use-identity-queries";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

/** The unary the whole family is gated on; a host that has one has them all. */
export const COMPOSER_IDENTITY_LIST_METHOD = "agentIdentity.list";

export type ComposerIdentityResolution =
  | { readonly kind: "none" }
  | { readonly kind: "selected"; readonly identity: AgentIdentitySummary }
  | { readonly kind: "removed"; readonly identityId: string }
  | { readonly kind: "unresolved"; readonly identityId: string };

export interface ComposerIdentityModel {
  /** The host the list was read from and a create or manage entry opens on. */
  readonly hostId: string;
  /** `undefined` while the list has not loaded. */
  readonly identities: ReadonlyArray<AgentIdentitySummary> | undefined;
  readonly listFailed: boolean;
  readonly resolution: ComposerIdentityResolution;
}

export function resolveComposerIdentity(
  identityId: string | null,
  identities: ReadonlyArray<AgentIdentitySummary> | undefined,
): ComposerIdentityResolution {
  if (identityId === null) return { kind: "none" };
  if (identities === undefined) return { kind: "unresolved", identityId };
  const identity = identities.find((row) => row.identityId === identityId);
  return identity === undefined
    ? { kind: "removed", identityId }
    : { kind: "selected", identity };
}

/** The id the store holds, whatever the list says about it. */
export function selectedIdentityIdOf(
  resolution: ComposerIdentityResolution,
): string | null {
  switch (resolution.kind) {
    case "none":
      return null;
    case "selected":
      return resolution.identity.identityId;
    case "removed":
    case "unresolved":
      return resolution.identityId;
  }
}

/** Display name for a row: the list shows untitled identities the same way. */
export function composerIdentityTitle(identity: AgentIdentitySummary): string {
  return identity.title.length > 0 ? identity.title : "Untitled identity";
}

/** What the control's trigger says for each resolution. */
export function composerIdentityLabel(
  resolution: ComposerIdentityResolution,
): string {
  switch (resolution.kind) {
    case "none":
      return "None";
    case "selected":
      return composerIdentityTitle(resolution.identity);
    case "removed":
      return "Removed";
    case "unresolved":
      return resolution.identityId;
  }
}

/**
 * `null` when the control must not render: no run target yet, or the host
 * does not serve the family.
 */
export function useComposerIdentityModel(
  store: ComposerToolbarStore,
  hostId: string | null,
): ComposerIdentityModel | null {
  const activityEnabled = useSurfaceActivity();
  const supported = useHostSupportsMethod(
    hostId,
    COMPOSER_IDENTITY_LIST_METHOD,
  );
  const client = useHostClientForHostId(hostId);
  // Fetched only while the surface is active, like the harness catalog; a
  // cached list still renders on an inactive pane.
  const listQuery = useIdentityListForClient(
    client,
    supported && hostId !== null && activityEnabled,
  );
  const identityId = useStore(store, (s) => s.identityId);
  if (hostId === null || !supported) return null;
  const identities = listQuery.data?.identities;
  return {
    hostId,
    identities,
    listFailed: listQuery.isError,
    resolution: resolveComposerIdentity(identityId, identities),
  };
}
