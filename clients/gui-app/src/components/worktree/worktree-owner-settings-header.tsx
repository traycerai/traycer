import { Fragment, type ReactNode } from "react";
import { Zap } from "lucide-react";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import { ProfileBadgedHarnessIcon } from "@/components/providers/profile-badged-harness-icon";
import {
  findPermissionOption,
  type PermissionMode,
} from "@/components/home/data/landing-options";
import { useCompactRelativeTime } from "@/lib/relative-time";
import {
  deriveOwnerSettingsHeader,
  type OwnerSettingsHeaderView,
} from "@/components/worktree/worktree-owner-settings-model";
import { harnessProfiles } from "@/components/worktree/worktree-owner-settings-profiles";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useChatRunSettings } from "@/hooks/chats/use-chat-run-settings-query";
import { useGuiHarnessCatalogForClient } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useChatById } from "@/lib/epic-selectors";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";

interface SettingsSegment {
  readonly key: string;
  readonly node: ReactNode;
}

interface TuiHeaderFields {
  readonly tuiHarnessId: TuiAgentProjection["harnessId"] | null;
  readonly tuiModel: string | null;
  readonly tuiReasoningEffort: string | null;
  readonly tuiProfileId: string | null;
}

/**
 * The run-settings header block atop the chat/terminal-agent hover card. It
 * self-sources the owner's settings from the already-local per-Epic store
 * (`useChatById` / the `tuiAgents` slice) keyed by the `ownerId` the tooltip
 * already carries - it takes no settings prop, so the sidebar row that renders
 * the tooltip owns none of this. Labels resolve against the OWNER's host's
 * live GUI harness catalog, with a raw-slug fallback whenever the catalog
 * lacks the entry (or the owner's host cannot be resolved at all).
 *
 * It renders only while the hover card is open (mounted by `HoverCardContent`,
 * which has no `forceMount`), so nothing here can fire before open: the catalog
 * observer attaches on open and detaches on close.
 *
 * The settings themselves cost nothing - they are a store read. Chat profile
 * labels remain pure cache reads; managed terminal profiles can fetch the same
 * live provider list their launch/fork surfaces use. The catalog is NOT free,
 * though: the harnesses query carries a finite 15-min staleTime, so opening
 * the card on a stale availability query can refetch it, and if that surfaces a
 * newly-available harness with no cached model list the `listModels` fan-out
 * follows (which, per that module's header, can spawn the OpenCode server and
 * reset the host's idle-reap clock) - and both now land on the OWNER's host.
 * For an owner on the default host that is the steady state as before: the
 * app-load prefetcher filled the same host-id-keyed cache slot and models are
 * `staleTime: Infinity`, so an open renders straight from cache. For an owner
 * on another host the first open fetches that host's catalog cold - the same
 * self-sufficiency trade the provider-list read below already makes.
 */
export function WorktreeOwnerSettingsHeader(props: {
  readonly ownerId: string;
  readonly hostId: string;
  readonly epicId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
}): ReactNode {
  const chat = useChatById(props.ownerId);
  const tuiAgent = useEpicStore((state) =>
    selectTuiAgent(state.tuiAgents.byId, props.ownerId),
  );
  const isChat = props.ownerKind === "chat";
  const localChatSettings = ownerChatSettings(isChat, chat?.settings ?? null);
  // Pinned to the OWNER's host, not the tab's or the app-active one - shared
  // with the provider-list read below, which needs the same host for the same
  // reason. A chat on another of the viewer's hosts is served by that host.
  const hostClient = useHostClientForHostId(props.hostId);
  // Terminal agents still carry their settings on the store projection, so this
  // is CHAT-ONLY: the single-write pivot took the doc chat entry away and left
  // the registry row's harness-id summary, which is not a tuple.
  //
  // Runs for EVERY chat, including one that already has a local tuple, because
  // that tuple can be stale in a way nothing here can detect. `unionChatsSlice`
  // deliberately prefers a surviving doc entry's `settings` over the record's,
  // but since the pivot `epic.updateChatRunSettings` and `epic.updateChatProfile`
  // write only the host's authoritative store - nothing re-writes that doc entry
  // ever again. So a pre-pivot chat's frozen tuple survives every subsequent
  // model, profile and permission change, and gating the read on its absence
  // would pin the card to values that stopped being true the first time the user
  // changed anything. The host is the authority; local is the fallback.
  const runSettingsQuery = useChatRunSettings({
    client: hostClient,
    epicId: props.epicId,
    chatId: props.ownerId,
    enabled: isChat,
  });
  // Keyed on whether the read SETTLED, not on whether it produced a tuple.
  // `{ settings: null }` is a successful answer - the host stating this chat has
  // no persisted tuple - and it has to outrank a stale local one, so coalescing
  // with `??` would be wrong: it would fall through to a frozen doc tuple the
  // host just contradicted. Local carries the card only while there is no answer
  // to prefer: in flight, errored, `E_HOST_UNSUPPORTED`, or no reachable host to
  // ask (the query is disabled and never settles). That keeps every fallback
  // that matters without letting absence-of-answer impersonate an answer.
  const chatSettings = runSettingsQuery.isSuccess
    ? runSettingsQuery.data.settings
    : localChatSettings;
  const hasSubject = ownerHasSubject(isChat, chatSettings, tuiAgent);

  // The dynamic label source, gated on `hasSubject` so a legacy row with no
  // settings never mounts the catalog fan-out at all. Warm entries render from
  // cache; see the component doc above for when an open can still refetch.
  //
  // Scoped to the OWNER's host like the provider-list read below: the tuple
  // being labeled is what THAT host runs, so a model only that host offers
  // must not fall back to a raw slug just because the default host's catalog
  // lacks it. On the common path (owner on the default host) this is the same
  // cache slot the app-load prefetcher warmed - host-id-keyed, so nothing
  // refetches. A `null` client (owner's host missing from the directory,
  // signed out) disables the read and labels fall back to raw slugs - honest,
  // rather than borrowing another host's catalog under this host's name.
  const catalog = useGuiHarnessCatalogForClient(hostClient, null, {
    enabled: hasSubject,
    subscribed: hasSubject,
  });

  // Every CHAT needs the provider list, not just profile-bearing ones: a null
  // `profileId` is the AMBIENT profile and now earns its own accent dot, so a
  // subscription gated on `profileId !== null` left ambient chats unable to
  // re-render when the list landed in cache after mount.
  // Terminal agents only badge managed profiles. Ambient stays the bare
  // harness mark; a managed id needs the live list for its label and accent,
  // while an unknown/tombstoned id silently stays bare.
  const profileActivity = ownerProfileActivity(isChat, tuiAgent);
  // Chats preserve their cache-only behavior. A managed terminal profile
  // actively resolves against this owner's fixed host, so the hover card is
  // self-sufficient even if no other profile surface warmed the query first.
  const providersList = useProvidersListForClient(hostClient, {
    enabled: profileActivity.enabled,
    subscribed: profileActivity.subscribed,
  });
  const tuiFields = tuiHeaderFields(tuiAgent);
  const view = deriveOwnerSettingsHeader({
    ownerKind: props.ownerKind,
    chatSettings,
    ...tuiFields,
    harnesses: catalog.harnesses,
    profiles: harnessProfiles(
      providersList.data?.providers ?? null,
      ownerHarnessId(chatSettings, tuiAgent),
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

function selectTuiAgent(
  byId: Readonly<Record<string, TuiAgentProjection>>,
  ownerId: string,
): TuiAgentProjection | null {
  return Object.hasOwn(byId, ownerId) ? byId[ownerId] : null;
}

function ownerChatSettings(
  isChat: boolean,
  settings: ChatRunSettings | null,
): ChatRunSettings | null {
  return isChat ? settings : null;
}

function ownerHasSubject(
  isChat: boolean,
  chatSettings: ChatRunSettings | null,
  tuiAgent: TuiAgentProjection | null,
): boolean {
  return isChat ? chatSettings !== null : tuiAgent !== null;
}

function ownerProfileActivity(
  isChat: boolean,
  tuiAgent: TuiAgentProjection | null,
): { readonly enabled: boolean; readonly subscribed: boolean } {
  const managedTerminalProfile =
    tuiAgent !== null && tuiAgent.profileId !== null;
  return {
    enabled: !isChat && managedTerminalProfile,
    subscribed: isChat || managedTerminalProfile,
  };
}

function tuiHeaderFields(tuiAgent: TuiAgentProjection | null): TuiHeaderFields {
  if (tuiAgent === null) {
    return {
      tuiHarnessId: null,
      tuiModel: null,
      tuiReasoningEffort: null,
      tuiProfileId: null,
    };
  }
  return {
    tuiHarnessId: tuiAgent.harnessId,
    tuiModel: tuiAgent.model,
    tuiReasoningEffort: tuiAgent.reasoningEffort,
    tuiProfileId: tuiAgent.profileId,
  };
}

function ownerHarnessId(
  chatSettings: ChatRunSettings | null,
  tuiAgent: TuiAgentProjection | null,
): TuiAgentProjection["harnessId"] | ChatRunSettings["harnessId"] | null {
  if (chatSettings !== null) return chatSettings.harnessId;
  return tuiAgent === null ? null : tuiAgent.harnessId;
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
    view.modelLabel === null && !view.fastMode
      ? null
      : {
          key: "model",
          node: (
            // The only segment allowed to shrink. Model names are the
            // unbounded value on this line ("Claude Opus 4.7 (1M context)"),
            // so at the card's ceiling this ellipsizes and the short, bounded
            // segments beside it survive intact.
            <span
              className="flex min-w-0 items-center gap-1 truncate font-medium"
              data-testid="owner-settings-model"
            >
              {view.modelLabel === null ? null : (
                <span className="min-w-0 truncate">{view.modelLabel}</span>
              )}
              {view.fastMode ? (
                <Zap
                  aria-label="Fast mode"
                  className="size-3.5 shrink-0 fill-current text-amber-500"
                  strokeWidth={2}
                />
              ) : null}
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
  return (
    <ProfileBadgedHarnessIcon
      harnessId={props.view.harnessId}
      harnessName={props.view.harnessName}
      profileAccentDot={props.view.profileAccentDot}
      iconClassName="size-4 shrink-0"
      className={undefined}
      testId="owner-settings-harness-mark"
    />
  );
}

/** Terminal-agent mode in the same icon + label grammar as chat permission. */
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
