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
import {
  useGuiHarnessCatalogForClient,
  useGuiHarnessModelsWarmup,
} from "@/hooks/harnesses/use-gui-harness-catalog";
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

/** Labels resolve against the owner's host's live GUI harness catalog, with a raw-slug fallback whenever the
 * catalog lacks the entry (or the owner's host cannot be resolved at all). */
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
  // Pinned to the owner's host, not the tab's or the app-active one - shared with the provider-list read below,
  // which needs the same host for the same reason.
  const hostClient = useHostClientForHostId(props.hostId);
  // So a pre-pivot chat's frozen tuple survives every subsequent model, profile and permission change.
  const runSettingsQuery = useChatRunSettings({
    client: hostClient,
    epicId: props.epicId,
    chatId: props.ownerId,
    enabled: isChat,
  });
  // Local carries the card only while there is no answer to prefer: in flight, errored, `E_HOST_UNSUPPORTED`, or
  // no reachable host to ask (the query is disabled and never settles).
  const chatSettings = runSettingsQuery.isSuccess
    ? runSettingsQuery.data.settings
    : localChatSettings;
  const hasSubject = ownerHasSubject(isChat, chatSettings, tuiAgent);
  const subjectHarnessId = ownerHarnessId(chatSettings, tuiAgent);

  // Scoped to the owner's host like the provider-list read below.
  const catalog = useGuiHarnessCatalogForClient(hostClient, null, {
    enabled: hasSubject,
    subscribed: hasSubject,
    modelsFetch: "cached-only",
  });
  // Gated on the subject's availability, not just `hasSubject`: the tuple is persisted history, so it can name a
  // harness the owner's host has since disabled or lost.
  const subjectAvailable =
    catalog.harnesses.find((harness) => harness.id === subjectHarnessId)
      ?.available === true;
  useGuiHarnessModelsWarmup(hostClient, subjectHarnessId, {
    enabled: hasSubject && subjectAvailable,
    subscribed: hasSubject,
  });

  // Terminal agents only badge managed profiles. Ambient stays the bare harness mark; a managed id needs the
  // live list for its label and accent, while an unknown/tombstoned id silently stays bare.
  const profileActivity = ownerProfileActivity(isChat, tuiAgent);
  // Chats preserve their cache-only behavior. A managed terminal profile actively resolves against this owner's
  // fixed host, so the hover card is self-sufficient even if no other profile surface warmed the query first.
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
      subjectHarnessId,
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

function ownerUpdatedAt(
  ownerKind: WorktreeBindingOwnerKind,
  chat: { readonly updatedAt: number } | null | undefined,
  tuiAgent: { readonly updatedAt: number } | null,
): number | null {
  const subject = ownerKind === "chat" ? chat : tuiAgent;
  if (subject === null || subject === undefined) return null;
  return subject.updatedAt;
}

/** The profile is dropped from the line for the same reason, but one step further: it rides the harness mark as
 * a corner dot instead of a trailing word (`OwnerSettingsHarnessMark`). */
function OwnerSettingsHeaderRows(props: {
  readonly view: OwnerSettingsHeaderView;
  readonly updatedAt: number | null;
}): ReactNode {
  const { view } = props;
  // Collected as a list, then dot-joined - so a separator can only ever land between two values that are
  // actually present.
  const allSegments: ReadonlyArray<SettingsSegment | null> = [
    view.modelLabel === null && !view.fastMode
      ? null
      : {
          key: "model",
          node: (
            // The only segment allowed to shrink.
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
            // Second to give way, after the model. Not `shrink-0`: this label comes from the harness catalog
            // (`supportedReasoningEfforts[].label`), i.e. provider-supplied text we do not bound.
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
            // Never follows the harness mark - a bullet hanging off an icon reads as debris rather than as joining two
            // values.
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
        // `ml-auto` pins it to the far right whenever the line is shorter than the card's floor width; at the ceiling
        // the auto margin collapses and it simply trails the settings across a `gap-2`.
        <OwnerSettingsUpdatedAt updatedAt={props.updatedAt} />
      )}
    </span>
  );
}

/** Named here rather than left as a bare icon because `AccentDot` is `aria-hidden` by construction and its own
 * contract requires callers to pair it with a name. */
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

/** Permission mode with the icon the rest of the app already uses for it - `ShieldCheck` / `FileCheck2` /
 * `UnlockKeyhole`, resolved through the shared `findPermissionOption` table rather than chosen here. */
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

/** Relative "last touched" for the owner, isolated in its own leaf because `useRelativeTimestamp` re-renders on
 * a timer - keeping it here means the tick repaints this one span rather than the whole settings line. */
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
