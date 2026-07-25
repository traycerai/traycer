import { Fragment, type ReactNode } from "react";
import { Lock } from "lucide-react";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { useCompactRelativeTime } from "@/lib/relative-time";
import {
  deriveOwnerSettingsHeader,
  type OwnerSettingsHeaderView,
} from "@/components/worktree/worktree-owner-settings-model";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useGuiHarnessCatalog } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useChatById } from "@/lib/epic-selectors";

const EMPTY_PROFILES: ReadonlyArray<ProviderProfile> = [];

interface SettingsSegment {
  readonly key: string;
  readonly node: ReactNode;
}

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
  const isChat = props.ownerKind === "chat";
  const chatSettings = isChat ? (chat?.settings ?? null) : null;
  const hasSubject = isChat ? chatSettings !== null : tuiAgent !== null;

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
  const view = deriveOwnerSettingsHeader({
    ownerKind: props.ownerKind,
    chatSettings,
    tuiHarnessId: tuiAgent?.harnessId ?? null,
    tuiModel: tuiAgent?.model ?? null,
    harnesses: catalog.harnesses,
    profiles: listedProfiles(providersList.data?.providers ?? null),
  });
  if (view === null) return null;
  return (
    <OwnerSettingsHeaderRows
      view={view}
      updatedAt={ownerUpdatedAt(props.ownerKind, chat, tuiAgent)}
    />
  );
}

/** Flattens every provider's profiles, or the shared empty list when cold. */
function listedProfiles(
  providers: ReadonlyArray<{
    readonly profiles: ReadonlyArray<ProviderProfile>;
  }> | null,
): ReadonlyArray<ProviderProfile> {
  if (providers === null) return EMPTY_PROFILES;
  return providers.flatMap((provider) => provider.profiles);
}

/** Both record kinds carry `updatedAt`; read whichever this owner is. */
function ownerUpdatedAt(
  ownerKind: WorktreeBindingOwnerKind,
  chat: { readonly updatedAt: number } | null | undefined,
  tuiAgent: { readonly updatedAt: number } | null,
): number | null {
  const subject = ownerKind === "chat" ? chat : tuiAgent;
  if (subject === null || subject === undefined) return null;
  return subject.updatedAt;
}

/**
 * The run settings as ONE dense line: provider mark, model, reasoning, then the
 * permission mode behind a lock. Field labels ("Provider", "Model", …) are
 * deliberately gone - each value is self-identifying, and the label column was
 * costing four stacked rows to say what one line says. The harness NAME is
 * dropped too: its brand mark already identifies it, and repeating the word
 * next to the icon was the same redundancy in miniature.
 *
 * `flex-wrap` rather than a hard single line: a long model + profile pair on a
 * narrow card wraps instead of overflowing or forcing a truncation that would
 * hide the permission mode - the one value here with a safety consequence.
 */
function OwnerSettingsHeaderRows(props: {
  readonly view: OwnerSettingsHeaderView;
  readonly updatedAt: number | null;
}): ReactNode {
  const { view } = props;
  // Collected as a list, then dot-joined - so a separator can only ever land
  // BETWEEN two values that are actually present. Conditioning each dot on its
  // own neighbours is what produces a leading dot when the model is absent, or
  // a doubled one when reasoning is; that bug re-appears with every field
  // added. Here a missing field simply drops out and its neighbours close up.
  const allSegments: ReadonlyArray<SettingsSegment | null> = [
    view.modelLabel === null
      ? null
      : {
          key: "model",
          node: (
            <span
              className="truncate font-medium"
              data-testid="owner-settings-model"
            >
              {view.modelLabel}
            </span>
          ),
        },
    view.reasoningLabel === null
      ? null
      : {
          key: "reasoning",
          node: (
            <span
              className="truncate text-muted-foreground"
              data-testid="owner-settings-reasoning"
            >
              {view.reasoningLabel}
            </span>
          ),
        },
    view.fastMode
      ? {
          key: "fast-mode",
          node: (
            <span
              className="text-muted-foreground"
              data-testid="owner-settings-fast-mode"
            >
              Fast
            </span>
          ),
        }
      : null,
    view.permissionLabel === null
      ? null
      : {
          key: "permissions",
          node: (
            <span
              className="flex min-w-0 items-center gap-1 text-muted-foreground"
              data-testid="owner-settings-permissions"
            >
              <Lock className="size-3 shrink-0" />
              <span className="truncate">{view.permissionLabel}</span>
            </span>
          ),
        },
    view.profileLabel === null
      ? null
      : {
          key: "profile",
          node: (
            <span
              className="truncate text-muted-foreground"
              data-testid="owner-settings-profile"
            >
              {view.profileLabel}
            </span>
          ),
        },
  ];
  const segments = allSegments.filter(
    (segment): segment is SettingsSegment => segment !== null,
  );
  return (
    <span
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/70 px-3 py-2 text-ui-xs"
      data-testid="owner-settings-header"
    >
      <HarnessIcon harnessId={view.harnessId} className="size-3.5 shrink-0" />
      {segments.map((segment, index) => (
        <Fragment key={segment.key}>
          {index === 0 ? null : (
            // The separator the collapsed model picker uses
            // (`harness-model-trigger.tsx`), so the two surfaces read as one
            // vocabulary. Never follows the harness mark - a bullet hanging off
            // an icon reads as debris rather than as joining two values.
            <span
              aria-hidden="true"
              className="shrink-0 text-muted-foreground/70"
            >
              ·
            </span>
          )}
          {segment.node}
        </Fragment>
      ))}
      {props.updatedAt === null ? null : (
        // `ml-auto` pins it to the far right of the line. Placed last so that
        // when the row wraps on a narrow card the time trails the settings
        // rather than stranding them under it.
        <OwnerSettingsUpdatedAt updatedAt={props.updatedAt} />
      )}
    </span>
  );
}

/**
 * Relative "last touched" for the owner, isolated in its own leaf because
 * `useRelativeTimestamp` re-renders on a timer - keeping it here means the tick
 * repaints this one span rather than the whole settings line.
 */
function OwnerSettingsUpdatedAt(props: {
  readonly updatedAt: number;
}): ReactNode {
  const relative = useCompactRelativeTime(props.updatedAt);
  return (
    <span
      className="ml-auto shrink-0 whitespace-nowrap tabular-nums text-muted-foreground"
      data-testid="owner-settings-updated-at"
    >
      {relative}
    </span>
  );
}
