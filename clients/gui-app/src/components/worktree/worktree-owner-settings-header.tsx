import type { ReactNode } from "react";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  deriveOwnerSettingsHeader,
  type OwnerSettingsHeaderView,
} from "@/components/worktree/worktree-owner-settings-model";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useGuiHarnessCatalog } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useChatById } from "@/lib/epic-selectors";
import { cn } from "@/lib/utils";

const EMPTY_PROFILES: ReadonlyArray<ProviderProfile> = [];

/**
 * The run-settings header block atop the chat/terminal-agent hover card. It
 * self-sources the owner's settings from the already-local per-Epic store
 * (`useChatById` / the `tuiAgents` slice) keyed by the `ownerId` the tooltip
 * already carries - it takes no settings prop, so the sidebar row that renders
 * the tooltip owns none of this. Labels resolve against the live GUI harness
 * catalog, with a raw-slug fallback whenever the catalog lacks the entry.
 *
 * It renders only while the hover card is open (mounted by `HoverCardContent`,
 * which has no `forceMount`), so nothing here can fire before open: the catalog
 * observer attaches on open and detaches on close.
 *
 * The settings themselves cost nothing - they are a store read - and the
 * profile label is a pure cache read (see below). The catalog is NOT free
 * though: `useGuiHarnessesQuery` carries a finite 15-min staleTime, so opening
 * the card on a stale availability query can refetch it, and if that surfaces a
 * newly-available harness with no cached model list the `listModels` fan-out
 * follows (which, per that module's header, can spawn the OpenCode server and
 * reset the host's idle-reap clock). In the steady state - the app-load
 * prefetcher has filled the cache and models are `staleTime: Infinity` - an
 * open renders straight from cache.
 */
export function WorktreeOwnerSettingsHeader(props: {
  readonly ownerId: string;
  readonly hostId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
}): ReactNode {
  const chat = useChatById(props.ownerId);
  const tuiAgent = useEpicStore((state) =>
    Object.hasOwn(state.tuiAgents.byId, props.ownerId)
      ? state.tuiAgents.byId[props.ownerId]
      : null,
  );
  const chatSettings =
    props.ownerKind === "chat" ? (chat?.settings ?? null) : null;
  const hasSubject =
    props.ownerKind === "chat" ? chatSettings !== null : tuiAgent !== null;

  // The dynamic label source, gated on `hasSubject` so a legacy row with no
  // settings never mounts the catalog fan-out at all. Warm entries render from
  // cache; see the component doc above for when an open can still refetch.
  const catalog = useGuiHarnessCatalog(null, {
    enabled: hasSubject,
    subscribed: hasSubject,
  });

  const profileId = chatSettings?.profileId ?? null;
  const profileNeeded = profileId !== null;
  const hostClient = useHostClientForHostId(props.hostId);
  // Profile label is a PURE CACHE READ: `enabled: false` never fires a request,
  // so the profile row costs no RPC of its own. It resolves only when the chat
  // host's provider list is already warm (the composer / Settings populated
  // it); otherwise `deriveOwnerSettingsHeader` omits the row rather than
  // surfacing the opaque profile id.
  const providersList = useProvidersListForClient(hostClient, {
    enabled: false,
    subscribed: profileNeeded,
  });
  const profiles =
    providersList.data?.providers.flatMap((provider) => provider.profiles) ??
    EMPTY_PROFILES;

  const view = deriveOwnerSettingsHeader({
    ownerKind: props.ownerKind,
    chatSettings,
    tuiHarnessId: tuiAgent?.harnessId ?? null,
    tuiModel: tuiAgent?.model ?? null,
    harnesses: catalog.harnesses,
    profiles,
  });
  if (view === null) return null;
  return <OwnerSettingsHeaderRows view={view} />;
}

function OwnerSettingsHeaderRows(props: {
  readonly view: OwnerSettingsHeaderView;
}): ReactNode {
  const { view } = props;
  return (
    <span
      className="flex flex-col gap-1 border-b border-border/70 px-3 py-2"
      data-testid="owner-settings-header"
    >
      <span className="pb-0.5 text-ui-xs font-medium text-muted-foreground">
        Agent
      </span>
      <OwnerSettingsRow label="Provider" align="center">
        <HarnessIcon harnessId={view.harnessId} className="size-3.5" />
        <span className="truncate">{view.harnessName}</span>
      </OwnerSettingsRow>
      {view.modelLabel === null ? null : (
        <OwnerSettingsRow label="Model" align="baseline">
          <span className="truncate">{view.modelLabel}</span>
        </OwnerSettingsRow>
      )}
      {view.reasoningLabel === null ? null : (
        <OwnerSettingsRow label="Reasoning" align="baseline">
          <span className="truncate">{view.reasoningLabel}</span>
        </OwnerSettingsRow>
      )}
      {view.fastMode ? (
        <OwnerSettingsRow label="Fast mode" align="baseline">
          <span>On</span>
        </OwnerSettingsRow>
      ) : null}
      {view.profileLabel === null ? null : (
        <OwnerSettingsRow label="Profile" align="baseline">
          <span className="truncate">{view.profileLabel}</span>
        </OwnerSettingsRow>
      )}
      {view.permissionLabel === null ? null : (
        <OwnerSettingsRow label="Permissions" align="baseline">
          <span className="truncate">{view.permissionLabel}</span>
        </OwnerSettingsRow>
      )}
    </span>
  );
}

function OwnerSettingsRow(props: {
  readonly label: string;
  readonly align: "baseline" | "center";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <span
      className={cn(
        "flex justify-between gap-4",
        props.align === "center" ? "items-center" : "items-baseline",
      )}
    >
      <span className="shrink-0 text-ui-xs text-muted-foreground">
        {props.label}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-ui-xs font-medium">
        {props.children}
      </span>
    </span>
  );
}
