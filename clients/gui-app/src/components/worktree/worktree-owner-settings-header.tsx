import { Fragment, type ReactNode } from "react";
import type {
  ProviderProfile,
  ProviderId as WireProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { AccentDot } from "@/components/providers/accent-dot";
import {
  findPermissionOption,
  type PermissionMode,
  type ProviderId,
} from "@/components/home/data/landing-options";
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

  // Every CHAT needs the provider list, not just profile-bearing ones: a null
  // `profileId` is the AMBIENT profile and now earns its own accent dot, so a
  // subscription gated on `profileId !== null` left ambient chats unable to
  // re-render when the list landed in cache after mount.
  const profileNeeded = isChat;
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
    profiles: harnessProfiles(
      providersList.data?.providers ?? null,
      chatSettings?.harnessId ?? null,
    ),
  });
  if (view === null) return null;
  return (
    <OwnerSettingsHeaderRows
      view={view}
      updatedAt={ownerUpdatedAt(props.ownerKind, chat, tuiAgent)}
    />
  );
}

/**
 * The chat harness's OWN profiles, or the shared empty list when the provider
 * cache is cold. Scoped rather than flattened across every provider: the accent
 * dot is gated on "this provider has 2+ accounts", and a flattened list crosses
 * that gate as soon as ANY two providers each have one - which would badge a
 * single-account provider on the strength of an unrelated one.
 *
 * The two id spaces are NOT interchangeable despite both being spelled
 * `ProviderId`: the GUI harness id is `claude` where the wire provider id is
 * `claude-code`, so this goes through `guiHarnessIdToProviderId` rather than
 * comparing the two directly (which type-checks nowhere and would silently
 * match zero providers if it did).
 */
function harnessProfiles(
  providers: ReadonlyArray<{
    readonly providerId: WireProviderId;
    readonly profiles: ReadonlyArray<ProviderProfile>;
  }> | null,
  harnessId: ProviderId | null,
): ReadonlyArray<ProviderProfile> {
  if (providers === null || harnessId === null) return EMPTY_PROFILES;
  const providerId = guiHarnessIdToProviderId(harnessId);
  if (providerId === null) return EMPTY_PROFILES;
  const provider =
    providers.find((candidate) => candidate.providerId === providerId) ?? null;
  return provider === null ? EMPTY_PROFILES : provider.profiles;
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
 * permission mode behind its own icon. Field labels ("Provider", "Model", …)
 * are deliberately gone - each value is self-identifying, and the label column
 * was costing four stacked rows to say what one line says. The harness NAME is
 * dropped too: its brand mark already identifies it, and repeating the word
 * next to the icon was the same redundancy in miniature.
 *
 * The PROFILE is dropped from the line for the same reason, but one step
 * further: it rides the harness mark as a corner dot instead of a trailing word
 * (`OwnerSettingsHarnessMark`). As text it was the one unbounded value here -
 * a user-chosen account name - and a long one wrapped the row in two, pushing
 * the permission mode onto a second line.
 *
 * ONE LINE, always. This row does not wrap - the card grows to fit it instead
 * (see the container in `worktree-owner-metadata.tsx`, which sizes itself from
 * this row between a 24rem floor and a viewport-capped ceiling). Wrapping was
 * the previous behaviour and it read badly: the line broke between two values
 * that belong together and pushed the permission mode - the one value here with
 * a safety consequence - onto a second row.
 *
 * At the ceiling the MODEL gives way first: it carries `min-w-0 truncate`, so
 * an unbounded model name ellipsizes while reasoning and the permission mode,
 * both short and bounded, stay whole.
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
            // The only segment allowed to shrink. Model names are the
            // unbounded value on this line ("Claude Opus 4.7 (1M context)"),
            // so at the card's ceiling this ellipsizes and the short, bounded
            // segments beside it survive intact.
            <span
              className="min-w-0 truncate font-medium"
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
            // Second to give way, after the model. NOT `shrink-0`: this label
            // comes from the harness catalog (`supportedReasoningEfforts[].label`),
            // i.e. provider-supplied text we do not bound. If every segment but
            // the model were unshrinkable, a verbose one could push the row past
            // the card's ceiling and - since the card is `overflow-hidden` - clip
            // the permission mode off the right edge with no ellipsis at all.
            <span
              className="min-w-0 truncate text-muted-foreground"
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
              className="shrink-0 text-muted-foreground"
              data-testid="owner-settings-fast-mode"
            >
              Fast
            </span>
          ),
        }
      : null,
    view.permissionMode === null
      ? null
      : {
          key: "permissions",
          node: <OwnerSettingsPermission mode={view.permissionMode} />,
        },
  ];
  const segments = allSegments.filter(
    (segment): segment is SettingsSegment => segment !== null,
  );
  return (
    <span
      className="flex flex-nowrap items-center gap-2 whitespace-nowrap border-b border-border/70 px-3 py-2 text-ui-xs"
      data-testid="owner-settings-header"
    >
      <OwnerSettingsHarnessMark view={view} />
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
        // `ml-auto` pins it to the far right whenever the line is shorter than
        // the card's floor width; at the ceiling the auto margin collapses and
        // it simply trails the settings across a `gap-2`.
        <OwnerSettingsUpdatedAt updatedAt={props.updatedAt} />
      )}
    </span>
  );
}

/**
 * Harness brand mark carrying the profile as a corner dot - the composer
 * model-picker trigger's exact pairing (`harness-model-trigger.tsx`), down to
 * the `size-4` mark and the `compact` corner dot, so the same account reads as
 * the same mark whether you are picking it or auditing it.
 *
 * Named here rather than left as a bare icon because `AccentDot` is
 * `aria-hidden` by construction and its own contract requires callers to pair
 * it with a name. With the profile's text segment gone, this label is the only
 * place the account is announced at all - so it carries the harness and the
 * profile together, which is also the first time this row named its harness to
 * a screen reader.
 */
function OwnerSettingsHarnessMark(props: {
  readonly view: OwnerSettingsHeaderView;
}): ReactNode {
  const { view } = props;
  const accentDot = view.profileAccentDot;
  return (
    <span
      role="img"
      aria-label={
        accentDot === null
          ? view.harnessName
          : `${view.harnessName}, ${accentDot.label}`
      }
      className="relative flex shrink-0 items-center"
      data-testid="owner-settings-harness-mark"
    >
      <HarnessIcon harnessId={view.harnessId} className="size-4 shrink-0" />
      {accentDot === null ? null : (
        <AccentDot
          profileId={accentDot.profileId}
          accentColor={accentDot.accentColor}
          label={accentDot.label}
          variant="corner"
          size="compact"
          className={undefined}
        />
      )}
    </span>
  );
}

/**
 * Permission mode with the icon the rest of the app already uses for it -
 * `ShieldCheck` / `FileCheck2` / `UnlockKeyhole`, resolved through the shared
 * `findPermissionOption` table rather than chosen here.
 *
 * This row previously hardcoded a closed padlock for ALL THREE modes, so the
 * least restricted one - "Full access" - was the one that read as locked down.
 * Taking the icon from the same lookup as the label is what makes that
 * inversion unrepresentable rather than merely fixed.
 */
function OwnerSettingsPermission(props: {
  readonly mode: PermissionMode;
}): ReactNode {
  const option = findPermissionOption(props.mode);
  const Icon = option.icon;
  return (
    <span
      className="flex shrink-0 items-center gap-1 text-muted-foreground"
      data-testid="owner-settings-permissions"
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span>{option.label}</span>
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
