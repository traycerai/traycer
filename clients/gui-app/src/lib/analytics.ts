import posthog, { type CaptureResult, type PostHogConfig } from "posthog-js";

export type AnalyticsSource =
  | "direct_ui"
  | "command_palette"
  | "keyboard_shortcut"
  | "native_menu"
  | "native_menu_accelerator"
  | "system_tray"
  | "os_jump_list_or_dock"
  | "window_chrome"
  | "notification"
  | "history"
  | "deep_link"
  | "restored_session";

export type AnalyticsBlocker =
  | "authentication"
  | "authorization"
  | "cancelled"
  | "conflict"
  | "host_incompatible"
  | "host_unavailable"
  | "invalid_input"
  | "migration"
  | "network"
  | "not_found"
  | "permission"
  | "provider_unavailable"
  | "rate_limit"
  | "setup"
  | "timeout"
  | "unsupported"
  | "unknown";

export type AnalyticsCommand =
  | "create_task"
  | "create_chat"
  | "duplicate_tab"
  | "history_back"
  | "history_forward"
  | "open_artifact"
  | "open_chat"
  | "open_diff"
  | "open_file"
  | "open_logs"
  | "open_settings"
  | "open_task"
  | "open_terminal"
  | "install_host_update"
  | "report_issue"
  | "restart_host"
  | "switch_task";

export type AnalyticsSettingsSection =
  | "agents"
  | "appearance"
  | "diagnostics"
  | "general"
  | "host"
  | "keybindings"
  | "notifications"
  | "providers"
  | "shell"
  | "worktrees";

export type AnalyticsArtifactKind = "review" | "spec" | "story" | "ticket";

export type AnalyticsEditor = "cursor" | "vscode" | "windsurf" | "zed";

export type AnalyticsHarness =
  | "amp"
  | "claude"
  | "codex"
  | "copilot"
  | "cursor"
  | "devin"
  | "droid"
  | "grok"
  | "kilocode"
  | "kimi"
  | "kiro"
  | "opencode"
  | "openrouter"
  | "pi"
  | "qwen"
  | "traycer";

/** Product vocabulary only - never the internal host/app-local/global source
 * seam. Callers pass `MergedNotificationRow.category`, already mapped at the
 * projection boundary by `categoryForNotificationSource`. */
export type AnalyticsNotificationCategory = "task" | "collaboration" | "system";

/** Bounded count buckets for every notification-analytics count. `unknown`
 * is legal only when an exact composite count cannot be formed (host
 * summary unavailable) - never as a generic "didn't bother computing it"
 * escape hatch. */
export type AnalyticsCountBucket =
  "unknown" | "0" | "1" | "2-5" | "6-20" | "21+";

export type AnalyticsNotificationEntryPoint = Extract<
  AnalyticsSource,
  "direct_ui" | "notification"
>;

export type AnalyticsNotificationHostState = "exact" | "unknown";

export type AnalyticsNotificationFilter =
  "unread_only" | AnalyticsNotificationCategory;

export type AnalyticsNotificationSection = "attention" | "recent";

export type AnalyticsNotificationSurface = "center" | "toast" | "native";

export type AnalyticsNotificationAcknowledgmentSource =
  "explicit_action" | "activation";

export type AnalyticsNotificationOutcome = "success" | "failure";

/** Maps a count to one of the fixed buckets `0`, `1`, `2-5`, `6-20`, `21+`.
 * Pass `null` when the exact composite count cannot be formed (e.g. the host
 * summary is unavailable) to get `"unknown"` - never derive `"unknown"` from
 * the numeric value itself. */
export function analyticsCountBucket(
  count: number | null,
): AnalyticsCountBucket {
  if (count === null) return "unknown";
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  if (count <= 20) return "6-20";
  return "21+";
}

export type AnalyticsOnboardingStep =
  | "agent-guide"
  | "command-theme"
  | "navigation"
  | "providers"
  | "task-context"
  | "task-tabs";

export type AnalyticsProviderOperation =
  | "ambient_drift"
  | "api_key"
  | "custom_path"
  | "enabled"
  | "env_override"
  | "profile"
  | "selection"
  | "terminal_args";

export type AnalyticsProvider =
  | "amp"
  | "claude-code"
  | "codex"
  | "copilot"
  | "cursor"
  | "devin"
  | "droid"
  | "grok"
  | "kilocode"
  | "kimi"
  | "kiro"
  | "opencode"
  | "openrouter"
  | "pi"
  | "qwen"
  | "traycer";

export type AnalyticsRole = "editor" | "owner" | "viewer";

export type AnalyticsSetting =
  | "allowPrereleaseUpdates"
  | "artifactIconColorMode"
  | "artifactIconColors"
  | "codeFontFamily"
  | "codeFontSize"
  | "composerMode"
  | "defaultAgentMode"
  | "defaultEditor"
  | "defaultPermission"
  | "defaultReasoning"
  | "defaultSelection"
  | "defaultServiceTier"
  | "diffViewerPreferences"
  | "pinContextUsageBreakdown"
  | "pointerCursors"
  | "preventSleepWhileRunning"
  | "quoteReplyEnabled"
  | "showGlobalResourceMonitor"
  | "showNavigatorResourceStats"
  | "summonHotkeyChord"
  | "summonHotkeyEnabled"
  | "terminalCursorBlink"
  | "terminalCursorStyle"
  | "terminalFontFamily"
  | "terminalFontSize"
  | "theme"
  | "themePreset"
  | "uiFontFamily"
  | "uiFontSize"
  | "voiceInputEnabled"
  | "voiceLanguage";

export type AnalyticsTheme =
  | "mode:dark"
  | "mode:light"
  | "mode:system"
  | "preset:amoled"
  | "preset:ayu"
  | "preset:blue"
  | "preset:catppuccin"
  | "preset:dracula"
  | "preset:everforest"
  | "preset:github"
  | "preset:green"
  | "preset:gruvbox"
  | "preset:neutral"
  | "preset:nord"
  | "preset:orange"
  | "preset:pink"
  | "preset:rose"
  | "preset:tokyo-night"
  | "preset:traycer-green"
  | "preset:violet";

export enum AnalyticsEvent {
  AppOpened = "app_opened",
  SignInStarted = "sign_in_started",
  SignInApprovalOpened = "sign_in_approval_opened",
  SignInSucceeded = "sign_in_succeeded",
  SignInFailed = "sign_in_failed",
  SignOutRequested = "sign_out_requested",
  HostSetupStarted = "host_setup_started",
  HostSetupSucceeded = "host_setup_succeeded",
  HostSetupFailed = "host_setup_failed",
  HostSelected = "host_selected",
  HostUpdateStarted = "host_update_started",
  HostUpdateSucceeded = "host_update_succeeded",
  HostUpdateFailed = "host_update_failed",
  HostUpdateSnoozed = "host_update_snoozed",
  OnboardingStarted = "onboarding_started",
  OnboardingNavigated = "onboarding_navigated",
  OnboardingCompleted = "onboarding_completed",
  OnboardingSkipped = "onboarding_skipped",
  OnboardingThemeChanged = "onboarding_theme_changed",
  AgentGuideSaved = "agent_guide_saved",
  ProviderProfileLinkStarted = "provider_profile_link_started",
  ProviderProfileLinkSucceeded = "provider_profile_link_succeeded",
  ProviderProfileLinkFailed = "provider_profile_link_failed",
  ProviderProfileLinkCancelled = "provider_profile_link_cancelled",
  ProviderConfigurationChanged = "provider_configuration_changed",
  AccountContextChanged = "account_context_changed",
  SubscriptionRefreshed = "subscription_refreshed",
  SubscriptionManagementOpened = "subscription_management_opened",
  TaskCreationStarted = "task_creation_started",
  TaskCreated = "task_created",
  TaskCreationFailed = "task_creation_failed",
  TaskOpened = "task_opened",
  TaskRenamed = "task_renamed",
  TaskDeleted = "task_deleted",
  TaskShared = "task_shared",
  AttachmentAdded = "attachment_added",
  AttachmentRemoved = "attachment_removed",
  AttachmentRejected = "attachment_rejected",
  WorkspaceFolderAdded = "workspace_folder_added",
  WorkspaceFolderRemoved = "workspace_folder_removed",
  WorkspacePrimaryChanged = "workspace_primary_changed",
  WorkspaceFileOpened = "workspace_file_opened",
  WorkspaceOpenedInEditor = "workspace_opened_in_editor",
  WorktreeCreated = "worktree_created",
  WorktreeImported = "worktree_imported",
  WorktreeSelected = "worktree_selected",
  WorktreeDeleted = "worktree_deleted",
  WorktreesBulkDeleted = "worktrees_bulk_deleted",
  SetupScriptsOpened = "setup_scripts_opened",
  SetupScriptsSaved = "setup_scripts_saved",
  SetupScriptsRetryStarted = "setup_scripts_retry_started",
  ChatOpened = "chat_opened",
  ChatMessageSent = "chat_message_sent",
  ChatMessageEdited = "chat_message_edited",
  ChatMessageSuffixDeleted = "chat_message_suffix_deleted",
  ChatForked = "chat_forked",
  ChatStopped = "chat_stopped",
  ChatBackgroundItemStopped = "chat_background_item_stopped",
  ChatQueuePaused = "chat_queue_paused",
  ChatQueueResumed = "chat_queue_resumed",
  ChatQueueItemEdited = "chat_queue_item_edited",
  ChatQueueItemReordered = "chat_queue_item_reordered",
  ChatQueueItemCancelled = "chat_queue_item_cancelled",
  ChatQueueItemSteered = "chat_queue_item_steered",
  ApprovalDecided = "approval_decided",
  FileEditApprovalDecided = "file_edit_approval_decided",
  CheckpointRestored = "checkpoint_restored",
  InterviewAnswered = "interview_answered",
  FileChangesReverted = "file_changes_reverted",
  DiffOpened = "diff_opened",
  HarnessChanged = "harness_changed",
  CommandPaletteOpened = "command_palette_opened",
  CommandExecuted = "command_executed",
  HistoryNavigationUsed = "history_navigation_used",
  TabCreated = "tab_created",
  TabDuplicated = "tab_duplicated",
  TabSplit = "tab_split",
  TabMoved = "tab_moved",
  TabClosed = "tab_closed",
  ArtifactCreated = "artifact_created",
  ArtifactOpened = "artifact_opened",
  ArtifactRenamed = "artifact_renamed",
  ArtifactStatusChanged = "artifact_status_changed",
  ArtifactDeleted = "artifact_deleted",
  ArtifactExported = "artifact_exported",
  CommentCreated = "comment_created",
  CommentReplied = "comment_replied",
  CommentEdited = "comment_edited",
  CommentResolved = "comment_resolved",
  CommentReopened = "comment_reopened",
  CommentDeleted = "comment_deleted",
  ShareInviteSent = "share_invite_sent",
  ShareRoleChanged = "share_role_changed",
  ShareAccessRevoked = "share_access_revoked",
  NotificationCenterOpened = "notification_center_opened",
  NotificationFilterChanged = "notification_filter_changed",
  NotificationActivationCompleted = "notification_activation_completed",
  NotificationMarkedRead = "notification_marked_read",
  NotificationsMarkedAllRead = "notifications_marked_all_read",
  NotificationPageLoaded = "notification_page_loaded",
  NotificationNewRevealed = "notification_new_revealed",
  TerminalOpened = "terminal_opened",
  TerminalRenamed = "terminal_renamed",
  TerminalKilled = "terminal_killed",
  TerminalAgentLaunched = "terminal_agent_launched",
  TerminalAgentForked = "terminal_agent_forked",
  TerminalAgentStopped = "terminal_agent_stopped",
  AgentStopped = "agent_stopped",
  VoiceEnabled = "voice_enabled",
  VoiceDisabled = "voice_disabled",
  VoiceDictationStarted = "voice_dictation_started",
  VoiceDictationStopped = "voice_dictation_stopped",
  VoiceDictationCancelled = "voice_dictation_cancelled",
  VoicePermissionResolved = "voice_permission_resolved",
  VoiceCaptureFailed = "voice_capture_failed",
  VoiceTranscriptionSucceeded = "voice_transcription_succeeded",
  VoiceTranscriptionFailed = "voice_transcription_failed",
  SettingsOpened = "settings_opened",
  SettingChanged = "setting_changed",
  UpdateDownloadStarted = "update_download_started",
  UpdateDownloadSucceeded = "update_download_succeeded",
  UpdateRestartRequested = "update_restart_requested",
  UpdateInstallGuidanceOpened = "update_install_guidance_opened",
  UpdateFailed = "update_failed",
  ReportIssueOpened = "report_issue_opened",
  ReportIssueHandedOff = "report_issue_handed_off",
  AppQuitRequested = "app_quit_requested",
  TabCloseBlocked = "tab_close_blocked",
}

type SourceProperties = { readonly source: AnalyticsSource };
type BlockedProperties = SourceProperties & {
  readonly blocker: AnalyticsBlocker;
};
type WorkspaceKind = "local" | "unknown" | "worktree";
export type AnalyticsTargetKind =
  | "artifact"
  | "chat"
  | "diff"
  | "file"
  | "task"
  | "terminal"
  | "terminal_agent";

export function analyticsTargetForCanvasTileType(
  tileType: string,
): AnalyticsTargetKind | null {
  switch (tileType) {
    case "chat":
      return "chat";
    case "terminal":
      return "terminal";
    case "terminal-agent":
      return "terminal_agent";
    case "workspace-file":
      return "file";
    case "git-diff":
    case "snapshot-diff":
      return "diff";
    case "spec":
    case "ticket":
    case "story":
    case "review":
      return "artifact";
    default:
      return null;
  }
}

export function analyticsArtifactKindForCanvasTileType(
  tileType: string,
): AnalyticsArtifactKind | null {
  switch (tileType) {
    case "review":
    case "spec":
    case "story":
    case "ticket":
      return tileType;
    default:
      return null;
  }
}

export interface AnalyticsEventProperties {
  readonly [AnalyticsEvent.AppOpened]: SourceProperties & {
    readonly launch_reason: "normal" | "update_restart";
    readonly restored_tabs: boolean;
  };
  readonly [AnalyticsEvent.SignInStarted]: SourceProperties;
  readonly [AnalyticsEvent.SignInApprovalOpened]: SourceProperties;
  readonly [AnalyticsEvent.SignInSucceeded]: null;
  // Deliberately source-less: success/failure are emitted from the terminal
  // auth transition inside AuthService, where the originating UI gesture is
  // unknown; funnels take `source` from `sign_in_started`.
  readonly [AnalyticsEvent.SignInFailed]: {
    readonly blocker: AnalyticsBlocker;
  };
  readonly [AnalyticsEvent.SignOutRequested]: SourceProperties;
  readonly [AnalyticsEvent.HostSetupStarted]: {
    readonly reason: "launch" | "recovery" | "reinstall" | "update";
  };
  readonly [AnalyticsEvent.HostSetupSucceeded]: {
    readonly reason: "launch" | "recovery" | "reinstall" | "update";
  };
  readonly [AnalyticsEvent.HostSetupFailed]: BlockedProperties;
  readonly [AnalyticsEvent.HostSelected]: SourceProperties & {
    readonly host_kind: "local" | "remote";
  };
  readonly [AnalyticsEvent.HostUpdateStarted]: SourceProperties;
  readonly [AnalyticsEvent.HostUpdateSucceeded]: null;
  readonly [AnalyticsEvent.HostUpdateFailed]: {
    readonly blocker: AnalyticsBlocker;
  };
  readonly [AnalyticsEvent.HostUpdateSnoozed]: SourceProperties;
  readonly [AnalyticsEvent.OnboardingStarted]: {
    readonly mode: "first_run" | "replay";
  };
  readonly [AnalyticsEvent.OnboardingNavigated]: {
    readonly direction: "back" | "continue";
    readonly step: AnalyticsOnboardingStep;
  };
  readonly [AnalyticsEvent.OnboardingCompleted]: {
    readonly last_step: AnalyticsOnboardingStep;
  };
  readonly [AnalyticsEvent.OnboardingSkipped]: {
    readonly last_step: AnalyticsOnboardingStep;
  };
  readonly [AnalyticsEvent.OnboardingThemeChanged]: {
    readonly theme: AnalyticsTheme;
  };
  readonly [AnalyticsEvent.AgentGuideSaved]: { readonly customized: boolean };
  readonly [AnalyticsEvent.ProviderProfileLinkStarted]: SourceProperties & {
    readonly provider: AnalyticsProvider;
    readonly mode: "create" | "reauth";
  };
  readonly [AnalyticsEvent.ProviderProfileLinkSucceeded]: {
    readonly provider: AnalyticsProvider;
    readonly mode: "create" | "reauth";
  };
  readonly [AnalyticsEvent.ProviderProfileLinkFailed]: {
    readonly provider: AnalyticsProvider;
    readonly mode: "create" | "reauth";
    readonly blocker: AnalyticsBlocker;
  };
  readonly [AnalyticsEvent.ProviderProfileLinkCancelled]: {
    readonly provider: AnalyticsProvider;
    readonly mode: "create" | "reauth";
  };
  readonly [AnalyticsEvent.ProviderConfigurationChanged]: {
    readonly operation: AnalyticsProviderOperation;
  };
  readonly [AnalyticsEvent.AccountContextChanged]: {
    readonly context: "personal" | "team";
  };
  readonly [AnalyticsEvent.SubscriptionRefreshed]: SourceProperties;
  readonly [AnalyticsEvent.SubscriptionManagementOpened]: SourceProperties;
  readonly [AnalyticsEvent.TaskCreationStarted]: SourceProperties & {
    readonly mode: "chat" | "terminal_agent";
    readonly workspace_count: number;
  };
  readonly [AnalyticsEvent.TaskCreated]: {
    readonly mode: "chat" | "terminal_agent";
  };
  readonly [AnalyticsEvent.TaskCreationFailed]: BlockedProperties & {
    readonly mode: "chat" | "terminal_agent";
  };
  readonly [AnalyticsEvent.TaskOpened]: SourceProperties;
  readonly [AnalyticsEvent.TaskRenamed]: SourceProperties;
  readonly [AnalyticsEvent.TaskDeleted]: SourceProperties & {
    readonly cleanup_worktrees: boolean;
  };
  readonly [AnalyticsEvent.TaskShared]: null;
  readonly [AnalyticsEvent.AttachmentAdded]: {
    readonly kind: "image";
    readonly surface: "draft" | "chat";
  };
  readonly [AnalyticsEvent.AttachmentRemoved]: {
    readonly kind: "image";
    readonly surface: "draft" | "chat";
  };
  readonly [AnalyticsEvent.AttachmentRejected]: {
    readonly kind: "image";
    readonly surface: "draft" | "chat";
    readonly blocker: AnalyticsBlocker;
  };
  readonly [AnalyticsEvent.WorkspaceFolderAdded]: SourceProperties & {
    readonly workspace_kind: WorkspaceKind;
  };
  readonly [AnalyticsEvent.WorkspaceFolderRemoved]: SourceProperties & {
    readonly workspace_kind: WorkspaceKind;
  };
  readonly [AnalyticsEvent.WorkspacePrimaryChanged]: SourceProperties;
  readonly [AnalyticsEvent.WorkspaceFileOpened]: SourceProperties;
  readonly [AnalyticsEvent.WorkspaceOpenedInEditor]: SourceProperties & {
    readonly editor: AnalyticsEditor;
  };
  readonly [AnalyticsEvent.WorktreeCreated]: SourceProperties;
  readonly [AnalyticsEvent.WorktreeImported]: SourceProperties;
  readonly [AnalyticsEvent.WorktreeSelected]: SourceProperties;
  readonly [AnalyticsEvent.WorktreeDeleted]:
    | { readonly outcome: "failed"; readonly blocker: AnalyticsBlocker }
    | { readonly outcome: "succeeded"; readonly blocker: null };
  readonly [AnalyticsEvent.WorktreesBulkDeleted]: {
    readonly requested_count: number;
    readonly succeeded_count: number;
    readonly failed_count: number;
  };
  readonly [AnalyticsEvent.SetupScriptsOpened]: SourceProperties;
  readonly [AnalyticsEvent.SetupScriptsSaved]: {
    readonly script_count: number;
  };
  readonly [AnalyticsEvent.SetupScriptsRetryStarted]: SourceProperties;
  readonly [AnalyticsEvent.ChatOpened]: SourceProperties;
  readonly [AnalyticsEvent.ChatMessageSent]: {
    readonly harness: AnalyticsHarness;
    readonly mode: "epic" | "regular";
  };
  readonly [AnalyticsEvent.ChatMessageEdited]: null;
  readonly [AnalyticsEvent.ChatMessageSuffixDeleted]: null;
  readonly [AnalyticsEvent.ChatForked]: SourceProperties & {
    readonly include_history: boolean;
  };
  readonly [AnalyticsEvent.ChatStopped]: {
    readonly scope: "current" | "with_children";
  };
  readonly [AnalyticsEvent.ChatBackgroundItemStopped]: {
    readonly scope: "one" | "all";
  };
  readonly [AnalyticsEvent.ChatQueuePaused]: null;
  readonly [AnalyticsEvent.ChatQueueResumed]: null;
  readonly [AnalyticsEvent.ChatQueueItemEdited]: null;
  readonly [AnalyticsEvent.ChatQueueItemReordered]: null;
  readonly [AnalyticsEvent.ChatQueueItemCancelled]: null;
  readonly [AnalyticsEvent.ChatQueueItemSteered]: {
    readonly settings_changed: boolean;
  };
  readonly [AnalyticsEvent.ApprovalDecided]: {
    readonly decision: "approved" | "denied";
  };
  readonly [AnalyticsEvent.FileEditApprovalDecided]: {
    readonly decision: "approved" | "denied";
  };
  readonly [AnalyticsEvent.CheckpointRestored]: {
    readonly revert_artifacts: boolean;
  };
  readonly [AnalyticsEvent.InterviewAnswered]: {
    readonly answer_count: number;
  };
  readonly [AnalyticsEvent.FileChangesReverted]: {
    readonly file_count: number;
    readonly revert_artifacts: boolean;
  };
  readonly [AnalyticsEvent.DiffOpened]: SourceProperties & {
    readonly scope: "all" | "file";
  };
  readonly [AnalyticsEvent.HarnessChanged]: {
    readonly from: AnalyticsHarness;
    readonly to: AnalyticsHarness;
  };
  readonly [AnalyticsEvent.CommandPaletteOpened]: null;
  readonly [AnalyticsEvent.CommandExecuted]: SourceProperties & {
    readonly command: AnalyticsCommand;
  };
  readonly [AnalyticsEvent.HistoryNavigationUsed]: {
    readonly direction: "back" | "forward";
  };
  readonly [AnalyticsEvent.TabCreated]: {
    readonly target: AnalyticsTargetKind;
  };
  readonly [AnalyticsEvent.TabDuplicated]: {
    readonly target: AnalyticsTargetKind;
  };
  readonly [AnalyticsEvent.TabSplit]: { readonly target: AnalyticsTargetKind };
  readonly [AnalyticsEvent.TabMoved]: { readonly target: AnalyticsTargetKind };
  readonly [AnalyticsEvent.TabClosed]: { readonly target: AnalyticsTargetKind };
  readonly [AnalyticsEvent.ArtifactCreated]: {
    readonly kind: AnalyticsArtifactKind;
  };
  readonly [AnalyticsEvent.ArtifactOpened]: SourceProperties & {
    readonly kind: AnalyticsArtifactKind;
  };
  readonly [AnalyticsEvent.ArtifactRenamed]: null;
  readonly [AnalyticsEvent.ArtifactStatusChanged]: {
    readonly kind: AnalyticsArtifactKind;
    readonly status: 0 | 1 | 2;
  };
  readonly [AnalyticsEvent.ArtifactDeleted]: null;
  readonly [AnalyticsEvent.ArtifactExported]: {
    readonly format: "markdown" | "pdf";
    readonly artifact_count: number;
  };
  readonly [AnalyticsEvent.CommentCreated]: { readonly has_mention: boolean };
  readonly [AnalyticsEvent.CommentReplied]: { readonly has_mention: boolean };
  readonly [AnalyticsEvent.CommentEdited]: null;
  readonly [AnalyticsEvent.CommentResolved]: null;
  readonly [AnalyticsEvent.CommentReopened]: null;
  readonly [AnalyticsEvent.CommentDeleted]: null;
  readonly [AnalyticsEvent.ShareInviteSent]: {
    readonly target: "person" | "team";
    readonly role: AnalyticsRole;
  };
  readonly [AnalyticsEvent.ShareRoleChanged]: {
    readonly target: "person" | "team";
    readonly role: AnalyticsRole;
  };
  readonly [AnalyticsEvent.ShareAccessRevoked]: {
    readonly target: "person" | "team";
  };
  readonly [AnalyticsEvent.NotificationCenterOpened]: {
    readonly entry_point: AnalyticsNotificationEntryPoint;
    readonly host_state: AnalyticsNotificationHostState;
    readonly attention_bucket: AnalyticsCountBucket;
    readonly unread_bucket: AnalyticsCountBucket;
  };
  readonly [AnalyticsEvent.NotificationFilterChanged]: {
    readonly filter: AnalyticsNotificationFilter;
    readonly enabled: boolean;
  };
  readonly [AnalyticsEvent.NotificationActivationCompleted]: {
    readonly category: AnalyticsNotificationCategory;
    readonly section: AnalyticsNotificationSection;
    readonly surface: AnalyticsNotificationSurface;
    readonly outcome: AnalyticsNotificationOutcome;
  };
  readonly [AnalyticsEvent.NotificationMarkedRead]: {
    readonly category: AnalyticsNotificationCategory;
    readonly acknowledgment_source: AnalyticsNotificationAcknowledgmentSource;
  };
  readonly [AnalyticsEvent.NotificationsMarkedAllRead]: {
    readonly affected_count_bucket: AnalyticsCountBucket;
  };
  readonly [AnalyticsEvent.NotificationPageLoaded]:
    | {
        readonly section: AnalyticsNotificationSection;
        readonly outcome: "success";
        readonly result_count_bucket: AnalyticsCountBucket;
        readonly has_more: boolean;
      }
    | {
        readonly section: AnalyticsNotificationSection;
        readonly outcome: "failure";
        readonly result_count_bucket: null;
        readonly has_more: null;
      };
  readonly [AnalyticsEvent.NotificationNewRevealed]: {
    readonly count_bucket: AnalyticsCountBucket;
  };
  readonly [AnalyticsEvent.TerminalOpened]: SourceProperties & {
    readonly kind: "agent" | "shell";
  };
  readonly [AnalyticsEvent.TerminalRenamed]: {
    readonly kind: "agent" | "shell";
  };
  readonly [AnalyticsEvent.TerminalKilled]: {
    readonly kind: "agent" | "shell";
  };
  readonly [AnalyticsEvent.TerminalAgentLaunched]: SourceProperties & {
    readonly harness: AnalyticsHarness;
  };
  readonly [AnalyticsEvent.TerminalAgentForked]: SourceProperties & {
    readonly harness: AnalyticsHarness;
  };
  readonly [AnalyticsEvent.TerminalAgentStopped]: SourceProperties;
  readonly [AnalyticsEvent.AgentStopped]: SourceProperties & {
    readonly cascade: boolean;
  };
  readonly [AnalyticsEvent.VoiceEnabled]: SourceProperties;
  readonly [AnalyticsEvent.VoiceDisabled]: SourceProperties;
  readonly [AnalyticsEvent.VoiceDictationStarted]: SourceProperties;
  readonly [AnalyticsEvent.VoiceDictationStopped]: {
    readonly duration_bucket: "under_10s" | "10_to_30s" | "over_30s";
  };
  readonly [AnalyticsEvent.VoiceDictationCancelled]: null;
  readonly [AnalyticsEvent.VoicePermissionResolved]: {
    readonly permission: "granted" | "denied" | "unavailable";
  };
  readonly [AnalyticsEvent.VoiceCaptureFailed]: BlockedProperties;
  readonly [AnalyticsEvent.VoiceTranscriptionSucceeded]: {
    readonly duration_bucket: "under_10s" | "10_to_30s" | "over_30s";
  };
  readonly [AnalyticsEvent.VoiceTranscriptionFailed]: {
    readonly blocker: AnalyticsBlocker;
  };
  readonly [AnalyticsEvent.SettingsOpened]: SourceProperties & {
    readonly section: AnalyticsSettingsSection;
  };
  readonly [AnalyticsEvent.SettingChanged]: SourceProperties & {
    readonly section: AnalyticsSettingsSection;
    readonly setting: AnalyticsSetting;
  };
  readonly [AnalyticsEvent.UpdateDownloadStarted]: SourceProperties;
  readonly [AnalyticsEvent.UpdateDownloadSucceeded]: null;
  readonly [AnalyticsEvent.UpdateRestartRequested]: SourceProperties;
  readonly [AnalyticsEvent.UpdateInstallGuidanceOpened]: SourceProperties;
  readonly [AnalyticsEvent.UpdateFailed]: {
    readonly blocker: AnalyticsBlocker;
  };
  readonly [AnalyticsEvent.ReportIssueOpened]: SourceProperties;
  readonly [AnalyticsEvent.ReportIssueHandedOff]:
    | { readonly outcome: "failed"; readonly blocker: AnalyticsBlocker }
    | { readonly outcome: "succeeded"; readonly blocker: null };
  readonly [AnalyticsEvent.AppQuitRequested]: SourceProperties;
  readonly [AnalyticsEvent.TabCloseBlocked]: {
    readonly decision: "cancel" | "discard";
  };
}

export const POSTHOG_CONFIG = {
  api_host: "https://us.i.posthog.com",
  autocapture: false,
  rageclick: false,
  capture_pageview: false,
  capture_pageleave: false,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  capture_exceptions: false,
  capture_performance: false,
  disable_session_recording: true,
  disable_surveys: true,
  disable_surveys_automatic_display: true,
  disable_product_tours: true,
  disable_web_experiments: true,
  advanced_disable_decide: true,
  advanced_disable_feature_flags: true,
  person_profiles: "identified_only",
  save_campaign_params: false,
  save_referrer: false,
  before_send: sanitizePostHogCaptureResult,
  property_denylist: [
    "$current_url",
    "$host",
    "$pathname",
    "$referrer",
    "$referring_domain",
    "$initial_current_url",
    "$initial_referrer",
    "$initial_referring_domain",
    "$session_entry_url",
  ],
} satisfies Partial<PostHogConfig>;

type AnalyticsPropertyValue = boolean | number | string | null;

const ANALYTICS_SOURCES = new Set<string>([
  "command_palette",
  "deep_link",
  "direct_ui",
  "history",
  "keyboard_shortcut",
  "native_menu",
  "native_menu_accelerator",
  "notification",
  "os_jump_list_or_dock",
  "restored_session",
  "system_tray",
  "window_chrome",
]);

const ANALYTICS_BLOCKERS = new Set<string>([
  "authentication",
  "authorization",
  "cancelled",
  "conflict",
  "host_incompatible",
  "host_unavailable",
  "invalid_input",
  "migration",
  "network",
  "not_found",
  "permission",
  "provider_unavailable",
  "rate_limit",
  "setup",
  "timeout",
  "unknown",
  "unsupported",
]);

const ANALYTICS_COMMANDS = new Set<string>([
  "create_chat",
  "create_task",
  "duplicate_tab",
  "history_back",
  "history_forward",
  "install_host_update",
  "open_artifact",
  "open_chat",
  "open_diff",
  "open_file",
  "open_logs",
  "open_settings",
  "open_task",
  "open_terminal",
  "report_issue",
  "restart_host",
  "switch_task",
]);

const ANALYTICS_HARNESSES = new Set<string>([
  "amp",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "devin",
  "droid",
  "grok",
  "kilocode",
  "kimi",
  "kiro",
  "opencode",
  "openrouter",
  "pi",
  "qwen",
  "traycer",
]);

const ANALYTICS_PROVIDERS = new Set<string>([
  "amp",
  "claude-code",
  "codex",
  "copilot",
  "cursor",
  "devin",
  "droid",
  "grok",
  "kilocode",
  "kimi",
  "kiro",
  "opencode",
  "openrouter",
  "pi",
  "qwen",
  "traycer",
]);

const ANALYTICS_SETTINGS_SECTIONS = new Set<string>([
  "agents",
  "appearance",
  "diagnostics",
  "general",
  "host",
  "keybindings",
  "notifications",
  "providers",
  "shell",
  "worktrees",
]);

const ANALYTICS_SETTINGS = new Set<string>([
  "allowPrereleaseUpdates",
  "artifactIconColorMode",
  "artifactIconColors",
  "codeFontFamily",
  "codeFontSize",
  "composerMode",
  "defaultAgentMode",
  "defaultEditor",
  "defaultPermission",
  "defaultReasoning",
  "defaultSelection",
  "defaultServiceTier",
  "diffViewerPreferences",
  "pinContextUsageBreakdown",
  "pointerCursors",
  "preventSleepWhileRunning",
  "quoteReplyEnabled",
  "showGlobalResourceMonitor",
  "showNavigatorResourceStats",
  "terminalCursorBlink",
  "terminalCursorStyle",
  "terminalFontFamily",
  "terminalFontSize",
  "theme",
  "themePreset",
  "uiFontFamily",
  "uiFontSize",
  "voiceInputEnabled",
  "voiceLanguage",
]);

const ANALYTICS_THEMES = new Set<string>([
  "mode:dark",
  "mode:light",
  "mode:system",
  "preset:amoled",
  "preset:ayu",
  "preset:blue",
  "preset:catppuccin",
  "preset:dracula",
  "preset:everforest",
  "preset:github",
  "preset:green",
  "preset:gruvbox",
  "preset:neutral",
  "preset:nord",
  "preset:orange",
  "preset:pink",
  "preset:rose",
  "preset:tokyo-night",
  "preset:traycer-green",
  "preset:violet",
]);

const ANALYTICS_ONBOARDING_STEPS = new Set<string>([
  "agent-guide",
  "command-theme",
  "navigation",
  "providers",
  "task-context",
  "task-tabs",
]);

const ANALYTICS_TARGETS = new Set<string>([
  "artifact",
  "chat",
  "diff",
  "file",
  "task",
  "terminal",
  "terminal_agent",
]);

const ANALYTICS_COUNT_BUCKETS = new Set<string>([
  "unknown",
  "0",
  "1",
  "2-5",
  "6-20",
  "21+",
]);

/** `unknown` is reserved for a composite count that genuinely cannot be
 * formed (e.g. the host summary is unavailable). A completed page load and a
 * revealed arrival count are always derived from local, exact data, so
 * neither may report `unknown`. */
const ANALYTICS_EXACT_COUNT_BUCKETS = new Set<string>(
  [...ANALYTICS_COUNT_BUCKETS].filter((bucket) => bucket !== "unknown"),
);

const ANALYTICS_NOTIFICATION_CATEGORIES = new Set<string>([
  "task",
  "collaboration",
  "system",
]);

const ANALYTICS_NOTIFICATION_ENTRY_POINTS = new Set<string>([
  "direct_ui",
  "notification",
]);

const ANALYTICS_NOTIFICATION_HOST_STATES = new Set<string>([
  "exact",
  "unknown",
]);

const ANALYTICS_NOTIFICATION_FILTERS = new Set<string>([
  "unread_only",
  "task",
  "collaboration",
  "system",
]);

const ANALYTICS_NOTIFICATION_ACKNOWLEDGMENT_SOURCES = new Set<string>([
  "explicit_action",
  "activation",
]);

const ANALYTICS_EVENTS = new Set<string>(Object.values(AnalyticsEvent));

function isAnalyticsEvent(event: string): event is AnalyticsEvent {
  return ANALYTICS_EVENTS.has(event);
}

function eventKeyEntries(
  events: ReadonlyArray<AnalyticsEvent>,
  keys: ReadonlyArray<string>,
): ReadonlyArray<readonly [AnalyticsEvent, ReadonlyArray<string>]> {
  return events.map((event) => [event, keys]);
}

const EVENT_PROPERTY_KEYS = new Map<AnalyticsEvent, ReadonlyArray<string>>([
  ...eventKeyEntries(
    [AnalyticsEvent.AppOpened],
    ["source", "launch_reason", "restored_tabs"],
  ),
  ...eventKeyEntries(
    [
      AnalyticsEvent.SignInStarted,
      AnalyticsEvent.SignInApprovalOpened,
      AnalyticsEvent.SignOutRequested,
      AnalyticsEvent.HostUpdateStarted,
      AnalyticsEvent.HostUpdateSnoozed,
      AnalyticsEvent.SubscriptionRefreshed,
      AnalyticsEvent.SubscriptionManagementOpened,
      AnalyticsEvent.TaskOpened,
      AnalyticsEvent.TaskRenamed,
      AnalyticsEvent.WorkspacePrimaryChanged,
      AnalyticsEvent.WorkspaceFileOpened,
      AnalyticsEvent.WorktreeCreated,
      AnalyticsEvent.WorktreeImported,
      AnalyticsEvent.WorktreeSelected,
      AnalyticsEvent.SetupScriptsOpened,
      AnalyticsEvent.SetupScriptsRetryStarted,
      AnalyticsEvent.ChatOpened,
      AnalyticsEvent.TerminalAgentStopped,
      AnalyticsEvent.VoiceEnabled,
      AnalyticsEvent.VoiceDisabled,
      AnalyticsEvent.VoiceDictationStarted,
      AnalyticsEvent.UpdateDownloadStarted,
      AnalyticsEvent.UpdateRestartRequested,
      AnalyticsEvent.UpdateInstallGuidanceOpened,
      AnalyticsEvent.ReportIssueOpened,
      AnalyticsEvent.AppQuitRequested,
    ],
    ["source"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.HostSetupFailed, AnalyticsEvent.VoiceCaptureFailed],
    ["source", "blocker"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.TaskCreationFailed],
    ["source", "blocker", "mode"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.HostSetupStarted, AnalyticsEvent.HostSetupSucceeded],
    ["reason"],
  ),
  ...eventKeyEntries([AnalyticsEvent.HostSelected], ["source", "host_kind"]),
  ...eventKeyEntries(
    [
      AnalyticsEvent.SignInFailed,
      AnalyticsEvent.HostUpdateFailed,
      AnalyticsEvent.VoiceTranscriptionFailed,
      AnalyticsEvent.UpdateFailed,
    ],
    ["blocker"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.OnboardingStarted, AnalyticsEvent.TaskCreated],
    ["mode"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.OnboardingNavigated],
    ["direction", "step"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.OnboardingCompleted, AnalyticsEvent.OnboardingSkipped],
    ["last_step"],
  ),
  ...eventKeyEntries([AnalyticsEvent.OnboardingThemeChanged], ["theme"]),
  ...eventKeyEntries([AnalyticsEvent.AgentGuideSaved], ["customized"]),
  ...eventKeyEntries(
    [AnalyticsEvent.ProviderProfileLinkStarted],
    ["source", "provider", "mode"],
  ),
  ...eventKeyEntries(
    [
      AnalyticsEvent.ProviderProfileLinkSucceeded,
      AnalyticsEvent.ProviderProfileLinkCancelled,
    ],
    ["provider", "mode"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.ProviderProfileLinkFailed],
    ["provider", "mode", "blocker"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.ProviderConfigurationChanged],
    ["operation"],
  ),
  ...eventKeyEntries([AnalyticsEvent.AccountContextChanged], ["context"]),
  ...eventKeyEntries(
    [AnalyticsEvent.TaskCreationStarted],
    ["source", "mode", "workspace_count"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.TaskDeleted],
    ["source", "cleanup_worktrees"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.AttachmentAdded, AnalyticsEvent.AttachmentRemoved],
    ["kind", "surface"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.AttachmentRejected],
    ["kind", "surface", "blocker"],
  ),
  ...eventKeyEntries(
    [
      AnalyticsEvent.WorkspaceFolderAdded,
      AnalyticsEvent.WorkspaceFolderRemoved,
    ],
    ["source", "workspace_kind"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.WorkspaceOpenedInEditor],
    ["source", "editor"],
  ),
  ...eventKeyEntries([AnalyticsEvent.WorktreeDeleted], ["outcome", "blocker"]),
  ...eventKeyEntries(
    [AnalyticsEvent.WorktreesBulkDeleted],
    ["requested_count", "succeeded_count", "failed_count"],
  ),
  ...eventKeyEntries([AnalyticsEvent.SetupScriptsSaved], ["script_count"]),
  ...eventKeyEntries([AnalyticsEvent.ChatMessageSent], ["harness", "mode"]),
  ...eventKeyEntries(
    [AnalyticsEvent.ChatForked],
    ["source", "include_history"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.ChatStopped, AnalyticsEvent.ChatBackgroundItemStopped],
    ["scope"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.ChatQueueItemSteered],
    ["settings_changed"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.ApprovalDecided, AnalyticsEvent.FileEditApprovalDecided],
    ["decision"],
  ),
  ...eventKeyEntries([AnalyticsEvent.CheckpointRestored], ["revert_artifacts"]),
  ...eventKeyEntries([AnalyticsEvent.InterviewAnswered], ["answer_count"]),
  ...eventKeyEntries(
    [AnalyticsEvent.FileChangesReverted],
    ["file_count", "revert_artifacts"],
  ),
  ...eventKeyEntries([AnalyticsEvent.DiffOpened], ["source", "scope"]),
  ...eventKeyEntries([AnalyticsEvent.HarnessChanged], ["from", "to"]),
  ...eventKeyEntries([AnalyticsEvent.CommandExecuted], ["source", "command"]),
  ...eventKeyEntries([AnalyticsEvent.HistoryNavigationUsed], ["direction"]),
  ...eventKeyEntries(
    [
      AnalyticsEvent.TabCreated,
      AnalyticsEvent.TabDuplicated,
      AnalyticsEvent.TabSplit,
      AnalyticsEvent.TabMoved,
      AnalyticsEvent.TabClosed,
      AnalyticsEvent.ShareAccessRevoked,
    ],
    ["target"],
  ),
  ...eventKeyEntries([AnalyticsEvent.ArtifactCreated], ["kind"]),
  ...eventKeyEntries([AnalyticsEvent.ArtifactOpened], ["source", "kind"]),
  ...eventKeyEntries(
    [AnalyticsEvent.ArtifactStatusChanged],
    ["kind", "status"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.ArtifactExported],
    ["format", "artifact_count"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.CommentCreated, AnalyticsEvent.CommentReplied],
    ["has_mention"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.ShareInviteSent, AnalyticsEvent.ShareRoleChanged],
    ["target", "role"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.NotificationCenterOpened],
    ["entry_point", "host_state", "attention_bucket", "unread_bucket"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.NotificationFilterChanged],
    ["filter", "enabled"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.NotificationActivationCompleted],
    ["category", "section", "surface", "outcome"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.NotificationMarkedRead],
    ["category", "acknowledgment_source"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.NotificationsMarkedAllRead],
    ["affected_count_bucket"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.NotificationPageLoaded],
    ["section", "outcome", "result_count_bucket", "has_more"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.NotificationNewRevealed],
    ["count_bucket"],
  ),
  ...eventKeyEntries([AnalyticsEvent.TerminalOpened], ["source", "kind"]),
  ...eventKeyEntries(
    [AnalyticsEvent.TerminalRenamed, AnalyticsEvent.TerminalKilled],
    ["kind"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.TerminalAgentLaunched, AnalyticsEvent.TerminalAgentForked],
    ["source", "harness"],
  ),
  ...eventKeyEntries([AnalyticsEvent.AgentStopped], ["source", "cascade"]),
  ...eventKeyEntries(
    [
      AnalyticsEvent.VoiceDictationStopped,
      AnalyticsEvent.VoiceTranscriptionSucceeded,
    ],
    ["duration_bucket"],
  ),
  ...eventKeyEntries([AnalyticsEvent.VoicePermissionResolved], ["permission"]),
  ...eventKeyEntries([AnalyticsEvent.SettingsOpened], ["source", "section"]),
  ...eventKeyEntries(
    [AnalyticsEvent.SettingChanged],
    ["source", "section", "setting"],
  ),
  ...eventKeyEntries(
    [AnalyticsEvent.ReportIssueHandedOff],
    ["outcome", "blocker"],
  ),
  ...eventKeyEntries([AnalyticsEvent.TabCloseBlocked], ["decision"]),
]);

const EVENTS_WITHOUT_PROPERTIES = new Set<AnalyticsEvent>([
  AnalyticsEvent.SignInSucceeded,
  AnalyticsEvent.HostUpdateSucceeded,
  AnalyticsEvent.TaskShared,
  AnalyticsEvent.ChatMessageEdited,
  AnalyticsEvent.ChatMessageSuffixDeleted,
  AnalyticsEvent.ChatQueuePaused,
  AnalyticsEvent.ChatQueueResumed,
  AnalyticsEvent.ChatQueueItemEdited,
  AnalyticsEvent.ChatQueueItemReordered,
  AnalyticsEvent.ChatQueueItemCancelled,
  AnalyticsEvent.CommandPaletteOpened,
  AnalyticsEvent.ArtifactRenamed,
  AnalyticsEvent.ArtifactDeleted,
  AnalyticsEvent.CommentEdited,
  AnalyticsEvent.CommentResolved,
  AnalyticsEvent.CommentReopened,
  AnalyticsEvent.CommentDeleted,
  AnalyticsEvent.VoiceDictationCancelled,
  AnalyticsEvent.UpdateDownloadSucceeded,
]);

function eventPropertyKeys(
  event: AnalyticsEvent,
): ReadonlyArray<string> | null {
  const keys = EVENT_PROPERTY_KEYS.get(event);
  if (keys !== undefined) return keys;
  return EVENTS_WITHOUT_PROPERTIES.has(event) ? [] : null;
}

export function analyticsEventContractIsComplete(): boolean {
  return Object.values(AnalyticsEvent).every((event) => {
    const hasProperties = EVENT_PROPERTY_KEYS.has(event);
    const hasNoProperties = EVENTS_WITHOUT_PROPERTIES.has(event);
    const keys = eventPropertyKeys(event);
    return (
      hasProperties !== hasNoProperties &&
      keys !== null &&
      keys.every((key) => analyticsPropertyHasValidator(event, key))
    );
  });
}

const EXACT_PROPERTY_VALUES: {
  readonly [key: string]: ReadonlySet<string> | undefined;
} = {
  acknowledgment_source: ANALYTICS_NOTIFICATION_ACKNOWLEDGMENT_SOURCES,
  affected_count_bucket: ANALYTICS_COUNT_BUCKETS,
  attention_bucket: ANALYTICS_COUNT_BUCKETS,
  category: ANALYTICS_NOTIFICATION_CATEGORIES,
  command: ANALYTICS_COMMANDS,
  context: new Set(["personal", "team"]),
  count_bucket: ANALYTICS_COUNT_BUCKETS,
  entry_point: ANALYTICS_NOTIFICATION_ENTRY_POINTS,
  filter: ANALYTICS_NOTIFICATION_FILTERS,
  host_state: ANALYTICS_NOTIFICATION_HOST_STATES,
  operation: new Set([
    "ambient_drift",
    "api_key",
    "custom_path",
    "enabled",
    "env_override",
    "profile",
    "selection",
    "terminal_args",
  ]),
  duration_bucket: new Set(["10_to_30s", "over_30s", "under_10s"]),
  editor: new Set(["cursor", "vscode", "windsurf", "zed"]),
  format: new Set(["markdown", "pdf"]),
  from: ANALYTICS_HARNESSES,
  harness: ANALYTICS_HARNESSES,
  host_kind: new Set(["local", "remote"]),
  launch_reason: new Set(["normal", "update_restart"]),
  last_step: ANALYTICS_ONBOARDING_STEPS,
  permission: new Set(["denied", "granted", "unavailable"]),
  provider: ANALYTICS_PROVIDERS,
  role: new Set(["editor", "owner", "viewer"]),
  section: ANALYTICS_SETTINGS_SECTIONS,
  setting: ANALYTICS_SETTINGS,
  source: ANALYTICS_SOURCES,
  step: ANALYTICS_ONBOARDING_STEPS,
  surface: new Set(["chat", "draft"]),
  theme: ANALYTICS_THEMES,
  to: ANALYTICS_HARNESSES,
  unread_bucket: ANALYTICS_COUNT_BUCKETS,
  workspace_kind: new Set(["local", "unknown", "worktree"]),
};

function eventValueEntries(
  events: ReadonlyArray<AnalyticsEvent>,
  key: string,
  values: ReadonlySet<string>,
): ReadonlyArray<readonly [string, ReadonlySet<string>]> {
  return events.map((event) => [`${event}:${key}`, values]);
}

const EVENT_EXACT_PROPERTY_VALUES = new Map<string, ReadonlySet<string>>([
  ...eventValueEntries(
    [AnalyticsEvent.NotificationNewRevealed],
    "count_bucket",
    ANALYTICS_EXACT_COUNT_BUCKETS,
  ),
  ...eventValueEntries(
    [AnalyticsEvent.OnboardingStarted],
    "mode",
    new Set(["first_run", "replay"]),
  ),
  ...eventValueEntries(
    [
      AnalyticsEvent.ProviderProfileLinkStarted,
      AnalyticsEvent.ProviderProfileLinkSucceeded,
      AnalyticsEvent.ProviderProfileLinkFailed,
      AnalyticsEvent.ProviderProfileLinkCancelled,
    ],
    "mode",
    new Set(["create", "reauth"]),
  ),
  ...eventValueEntries(
    [
      AnalyticsEvent.TaskCreationStarted,
      AnalyticsEvent.TaskCreated,
      AnalyticsEvent.TaskCreationFailed,
    ],
    "mode",
    new Set(["chat", "terminal_agent"]),
  ),
  ...eventValueEntries(
    [AnalyticsEvent.ChatMessageSent],
    "mode",
    new Set(["epic", "regular"]),
  ),
  ...eventValueEntries(
    [AnalyticsEvent.HostSetupStarted, AnalyticsEvent.HostSetupSucceeded],
    "reason",
    new Set(["launch", "recovery", "reinstall", "update"]),
  ),
  ...eventValueEntries(
    [AnalyticsEvent.ApprovalDecided, AnalyticsEvent.FileEditApprovalDecided],
    "decision",
    new Set(["approved", "denied"]),
  ),
  ...eventValueEntries(
    [AnalyticsEvent.TabCloseBlocked],
    "decision",
    new Set(["cancel", "discard"]),
  ),
  ...eventValueEntries(
    [AnalyticsEvent.OnboardingNavigated],
    "direction",
    new Set(["back", "continue"]),
  ),
  ...eventValueEntries(
    [AnalyticsEvent.HistoryNavigationUsed],
    "direction",
    new Set(["back", "forward"]),
  ),
  ...eventValueEntries(
    [AnalyticsEvent.ChatStopped],
    "scope",
    new Set(["current", "with_children"]),
  ),
  ...eventValueEntries(
    [AnalyticsEvent.ChatBackgroundItemStopped],
    "scope",
    new Set(["all", "one"]),
  ),
  ...eventValueEntries(
    [AnalyticsEvent.DiffOpened],
    "scope",
    new Set(["all", "file"]),
  ),
  ...eventValueEntries(
    [
      AnalyticsEvent.NotificationActivationCompleted,
      AnalyticsEvent.NotificationPageLoaded,
    ],
    "section",
    new Set(["attention", "recent"]),
  ),
  ...eventValueEntries(
    [AnalyticsEvent.NotificationActivationCompleted],
    "surface",
    new Set(["center", "toast", "native"]),
  ),
  ...eventValueEntries(
    [
      AnalyticsEvent.NotificationActivationCompleted,
      AnalyticsEvent.NotificationPageLoaded,
    ],
    "outcome",
    new Set(["success", "failure"]),
  ),
  ...eventValueEntries(
    [
      AnalyticsEvent.AttachmentAdded,
      AnalyticsEvent.AttachmentRemoved,
      AnalyticsEvent.AttachmentRejected,
    ],
    "kind",
    new Set(["image"]),
  ),
  ...eventValueEntries(
    [
      AnalyticsEvent.ArtifactCreated,
      AnalyticsEvent.ArtifactOpened,
      AnalyticsEvent.ArtifactStatusChanged,
    ],
    "kind",
    new Set(["review", "spec", "story", "ticket"]),
  ),
  ...eventValueEntries(
    [
      AnalyticsEvent.TerminalOpened,
      AnalyticsEvent.TerminalRenamed,
      AnalyticsEvent.TerminalKilled,
    ],
    "kind",
    new Set(["agent", "shell"]),
  ),
  ...eventValueEntries(
    [
      AnalyticsEvent.TabCreated,
      AnalyticsEvent.TabDuplicated,
      AnalyticsEvent.TabSplit,
      AnalyticsEvent.TabMoved,
      AnalyticsEvent.TabClosed,
    ],
    "target",
    ANALYTICS_TARGETS,
  ),
  ...eventValueEntries(
    [
      AnalyticsEvent.ShareInviteSent,
      AnalyticsEvent.ShareRoleChanged,
      AnalyticsEvent.ShareAccessRevoked,
    ],
    "target",
    new Set(["person", "team"]),
  ),
  ...eventValueEntries(
    [AnalyticsEvent.WorktreeDeleted, AnalyticsEvent.ReportIssueHandedOff],
    "outcome",
    new Set(["failed", "succeeded"]),
  ),
]);

const BOOLEAN_PROPERTY_KEYS = new Set<string>([
  "cascade",
  "cleanup_worktrees",
  "customized",
  "enabled",
  "has_mention",
  "include_history",
  "restored_tabs",
  "revert_artifacts",
  "settings_changed",
]);

const COUNT_PROPERTY_KEYS = new Set<string>([
  "answer_count",
  "artifact_count",
  "failed_count",
  "file_count",
  "requested_count",
  "script_count",
  "succeeded_count",
  "workspace_count",
]);

function analyticsPropertyHasValidator(
  event: AnalyticsEvent,
  key: string,
): boolean {
  return (
    key === "blocker" ||
    key === "status" ||
    key === "result_count_bucket" ||
    key === "has_more" ||
    BOOLEAN_PROPERTY_KEYS.has(key) ||
    COUNT_PROPERTY_KEYS.has(key) ||
    EVENT_EXACT_PROPERTY_VALUES.has(`${event}:${key}`) ||
    EXACT_PROPERTY_VALUES[key] !== undefined
  );
}

function isAnalyticsStatus(value: unknown): boolean {
  return value === 0 || value === 1 || value === 2;
}

function isAnalyticsCount(value: unknown): boolean {
  if (!Number.isInteger(value)) return false;
  const count = Number(value);
  return count >= 0 && count <= 10_000;
}

function isAnalyticsPropertyValue(
  event: AnalyticsEvent,
  key: string,
  value: unknown,
): value is AnalyticsPropertyValue {
  if (key === "blocker") {
    if (value === null) {
      return (
        event === AnalyticsEvent.WorktreeDeleted ||
        event === AnalyticsEvent.ReportIssueHandedOff
      );
    }
    return typeof value === "string" && ANALYTICS_BLOCKERS.has(value);
  }
  if (key === "result_count_bucket") {
    if (value === null) return event === AnalyticsEvent.NotificationPageLoaded;
    return typeof value === "string" && ANALYTICS_COUNT_BUCKETS.has(value);
  }
  if (key === "has_more") {
    if (value === null) return event === AnalyticsEvent.NotificationPageLoaded;
    return typeof value === "boolean";
  }
  if (key === "status") return isAnalyticsStatus(value);
  if (BOOLEAN_PROPERTY_KEYS.has(key)) return typeof value === "boolean";
  if (COUNT_PROPERTY_KEYS.has(key)) return isAnalyticsCount(value);
  const allowed =
    EVENT_EXACT_PROPERTY_VALUES.get(`${event}:${key}`) ??
    EXACT_PROPERTY_VALUES[key];
  return (
    typeof value === "string" && allowed !== undefined && allowed.has(value)
  );
}

function analyticsPropertiesAreRelationallyValid(
  event: AnalyticsEvent,
  properties: Record<string, unknown>,
): boolean {
  if (
    event === AnalyticsEvent.WorktreeDeleted ||
    event === AnalyticsEvent.ReportIssueHandedOff
  ) {
    return (
      (properties.outcome === "succeeded" && properties.blocker === null) ||
      (properties.outcome === "failed" &&
        typeof properties.blocker === "string" &&
        ANALYTICS_BLOCKERS.has(properties.blocker))
    );
  }
  if (event === AnalyticsEvent.WorktreesBulkDeleted) {
    return (
      Number(properties.requested_count) ===
      Number(properties.succeeded_count) + Number(properties.failed_count)
    );
  }
  if (event === AnalyticsEvent.NotificationPageLoaded) {
    return (
      (properties.outcome === "success" &&
        typeof properties.result_count_bucket === "string" &&
        ANALYTICS_EXACT_COUNT_BUCKETS.has(properties.result_count_bucket) &&
        typeof properties.has_more === "boolean") ||
      (properties.outcome === "failure" &&
        properties.result_count_bucket === null &&
        properties.has_more === null)
    );
  }
  return true;
}

const NOTIFICATION_STRICT_EVENTS = new Set<AnalyticsEvent>([
  AnalyticsEvent.NotificationCenterOpened,
  AnalyticsEvent.NotificationFilterChanged,
  AnalyticsEvent.NotificationActivationCompleted,
  AnalyticsEvent.NotificationMarkedRead,
  AnalyticsEvent.NotificationsMarkedAllRead,
  AnalyticsEvent.NotificationPageLoaded,
  AnalyticsEvent.NotificationNewRevealed,
]);

export function sanitizeAnalyticsProperties(
  event: AnalyticsEvent,
  properties: object | null,
): Record<string, AnalyticsPropertyValue> | null {
  const record: Record<string, unknown> = { ...properties };
  const expectedKeys = eventPropertyKeys(event);
  if (expectedKeys === null) return null;
  // The notification event family rejects rather than silently strips: a
  // property outside its exact allowlist is a caller bug (e.g. an
  // accidentally attached feed/host identifier), not extra data to discard
  // quietly. Other events keep the historical strip-only behavior other call
  // sites already rely on (see "strips identifiers, paths, content, queries,
  // and raw errors at runtime").
  if (
    NOTIFICATION_STRICT_EVENTS.has(event) &&
    Object.keys(record).length !== expectedKeys.length
  ) {
    return null;
  }
  if (
    expectedKeys.some(
      (key) =>
        !(key in record) || !isAnalyticsPropertyValue(event, key, record[key]),
    )
  ) {
    return null;
  }
  if (!analyticsPropertiesAreRelationallyValid(event, record)) return null;
  return expectedKeys.reduce<Record<string, AnalyticsPropertyValue>>(
    (sanitized, key) => {
      const value = record[key];
      return isAnalyticsPropertyValue(event, key, value)
        ? { ...sanitized, [key]: value }
        : sanitized;
    },
    {},
  );
}

function isSafeIngestionToken(value: unknown): value is string {
  return typeof value === "string" && /^phc_[a-zA-Z0-9_-]{1,252}$/.test(value);
}

function isSafeOpaqueIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function safeIngestionProperties(
  properties: Record<string, unknown>,
  includeAnonymousId: boolean,
): Record<string, string> | null {
  if (
    !isSafeIngestionToken(properties.token) ||
    !isSafeOpaqueIdentity(properties.distinct_id)
  ) {
    return null;
  }
  if (includeAnonymousId) {
    if (!isSafeOpaqueIdentity(properties.$anon_distinct_id)) return null;
    return {
      token: properties.token,
      distinct_id: properties.distinct_id,
      $anon_distinct_id: properties.$anon_distinct_id,
    };
  }
  return { token: properties.token, distinct_id: properties.distinct_id };
}

function safeAppGlobals(
  properties: Record<string, unknown>,
): Record<string, AnalyticsPropertyValue> | null {
  const appVersion = properties.app_version;
  if (
    properties.app !== "gui-app" ||
    (appVersion !== null &&
      (typeof appVersion !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,63}$/.test(appVersion))) ||
    typeof properties.platform !== "string" ||
    !new Set(["linux", "macos", "other", "windows"]).has(properties.platform) ||
    typeof properties.release_channel !== "string" ||
    !new Set(["development", "other", "production"]).has(
      properties.release_channel,
    )
  ) {
    return null;
  }
  return {
    app: "gui-app",
    app_version: appVersion,
    platform: String(properties.platform),
    release_channel: String(properties.release_channel),
  };
}

/**
 * PostHog session/window ids are SDK-generated opaque UUIDs. Passing them
 * through keeps session-based analyses (paths, session funnels, duration)
 * working without exposing any user content.
 */
function safeSessionProperties(
  properties: Record<string, unknown>,
): Record<string, string> {
  const sessionId = properties.$session_id;
  const windowId = properties.$window_id;
  return {
    ...(isSafeOpaqueIdentity(sessionId) ? { $session_id: sessionId } : {}),
    ...(isSafeOpaqueIdentity(windowId) ? { $window_id: windowId } : {}),
  };
}

function captureResult(
  event: string,
  properties: Record<string, AnalyticsPropertyValue>,
  timestamp: CaptureResult["timestamp"],
): CaptureResult {
  const uuid: string = crypto.randomUUID();
  if (timestamp === undefined) return { uuid, event, properties };
  return { uuid, event, properties, timestamp };
}

/**
 * Person properties are limited to the user's email, deliberately sent so
 * PostHog dashboards can look a user up. Everything else the SDK stages in
 * `$set`/`$set_once` (referrer, campaign, URL data) is dropped.
 */
function safePersonProperties(
  setProperties: Record<string, unknown> | undefined,
): Record<string, string> | null {
  const email = setProperties === undefined ? undefined : setProperties.email;
  return typeof email === "string" && /^[^\s@]{1,64}@[^\s@]{1,254}$/.test(email)
    ? { email }
    : null;
}

/**
 * A repeat `identify()` for an already-identified distinct id makes the SDK
 * emit a `$set` event instead of `$identify`; the staged person properties
 * then live in the event's `properties.$set` rather than the result's
 * top-level `$set`. Read both so email refreshes survive either shape.
 */
function stagedPersonProperties(
  result: CaptureResult,
  rawProperties: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (result.$set !== undefined) return result.$set;
  const inProperties = rawProperties.$set;
  return inProperties !== null && typeof inProperties === "object"
    ? Object.fromEntries(Object.entries(inProperties))
    : undefined;
}

export function sanitizePostHogCaptureResult(
  result: CaptureResult | null,
): CaptureResult | null {
  if (result === null) return null;
  const rawProperties: Record<string, unknown> = { ...result.properties };
  if (result.event === "$identify") {
    const identity = safeIngestionProperties(rawProperties, true);
    if (identity === null) return null;
    const sanitized = captureResult("$identify", identity, result.timestamp);
    const personProperties = safePersonProperties(
      stagedPersonProperties(result, rawProperties),
    );
    return personProperties === null
      ? sanitized
      : { ...sanitized, $set: personProperties };
  }
  if (result.event === "$set") {
    const identity = safeIngestionProperties(rawProperties, false);
    const personProperties = safePersonProperties(
      stagedPersonProperties(result, rawProperties),
    );
    if (identity === null || personProperties === null) return null;
    return {
      ...captureResult("$set", identity, result.timestamp),
      $set: personProperties,
    };
  }
  if (!isAnalyticsEvent(result.event)) return null;
  const identity = safeIngestionProperties(rawProperties, false);
  const globals = safeAppGlobals(rawProperties);
  const session = safeSessionProperties(rawProperties);
  const eventProperties = sanitizeAnalyticsProperties(
    result.event,
    rawProperties,
  );
  if (identity === null || globals === null || eventProperties === null) {
    return null;
  }
  return captureResult(
    result.event,
    { ...identity, ...globals, ...session, ...eventProperties },
    result.timestamp,
  );
}

function analyticsErrorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.toLowerCase();
  }
  if (typeof error === "string") return error.toLowerCase();
  if (error === null || typeof error !== "object") return "";
  const record: Record<string, unknown> = { ...error };
  return [record.name, record.code, record.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

const ANALYTICS_BLOCKER_PATTERNS: ReadonlyArray<{
  readonly blocker: AnalyticsBlocker;
  readonly pattern: RegExp;
}> = [
  { blocker: "cancelled", pattern: /cancel|abort/ },
  { blocker: "rate_limit", pattern: /rate.?limit|too many requests|quota/ },
  { blocker: "authentication", pattern: /unauth|sign.?in|login|token|401/ },
  {
    blocker: "authorization",
    pattern: /forbidden|not allowed|access denied|403/,
  },
  {
    blocker: "permission",
    pattern: /permission|microphone access|eacces|eperm/,
  },
  { blocker: "timeout", pattern: /timeout|timed out/ },
  {
    blocker: "host_unavailable",
    pattern: /host.*unavailable|host.*unreachable/,
  },
  {
    blocker: "network",
    pattern:
      /offline|network|not connected|econn|socket|fetch failed|connection/,
  },
  {
    blocker: "provider_unavailable",
    pattern: /provider.*unavailable|provider.*missing/,
  },
  { blocker: "not_found", pattern: /not found|enoent|404/ },
  { blocker: "conflict", pattern: /conflict|already exists|409/ },
  { blocker: "invalid_input", pattern: /invalid|validation|bad request|400/ },
  { blocker: "migration", pattern: /migration|upgrade required/ },
  { blocker: "setup", pattern: /setup|bootstrap/ },
  { blocker: "unsupported", pattern: /unsupported|not supported/ },
];

const RPC_ERROR_BLOCKERS: Readonly<Record<string, AnalyticsBlocker>> = {
  DOWNGRADE_UNSUPPORTED: "host_incompatible",
  E_HOST_UNSUPPORTED: "unsupported",
  FORBIDDEN: "authorization",
  INCOMPATIBLE: "host_incompatible",
  PROVIDER_DISABLED: "provider_unavailable",
  RPC_ERROR: "host_unavailable",
  SENDER_TUI_UNSUPPORTED: "unsupported",
  TERMINAL_ID_TAKEN: "conflict",
  UNAUTHORIZED: "authentication",
  WORKSPACE_BINDING_REQUIRED: "invalid_input",
  WORKTREE_BUSY: "conflict",
  WORKTREE_MISSING: "not_found",
  WORKTREE_REBIND_BLOCKED: "conflict",
  WORKTREE_REMOVE_LAST_ENTRY: "conflict",
  WORKTREE_SETUP_CANCELLED: "cancelled",
  WORKTREE_SETUP_FAILED: "setup",
};

function typedAnalyticsBlocker(error: unknown): AnalyticsBlocker | null {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  const code = error.code;
  return typeof code === "string" ? (RPC_ERROR_BLOCKERS[code] ?? null) : null;
}

export function analyticsBlockerFromError(error: unknown): AnalyticsBlocker {
  const typedBlocker = typedAnalyticsBlocker(error);
  if (typedBlocker !== null) return typedBlocker;
  const text = analyticsErrorText(error);
  return (
    ANALYTICS_BLOCKER_PATTERNS.find(({ pattern }) => pattern.test(text))
      ?.blocker ?? "unknown"
  );
}

/**
 * Host-update analytics trio shared by every install/update surface
 * (the in-app banner and the system-tray listener): `host_update_started`
 * on mutate, `host_update_succeeded` on success, `host_update_failed` on
 * error - differing only by `source`.
 */
export function hostUpdateAnalyticsCallbacks(source: AnalyticsSource): {
  readonly onStarted: () => void;
  readonly onSucceeded: () => void;
  readonly onFailed: (error: unknown) => void;
} {
  return {
    onStarted: () => {
      Analytics.getInstance().track(AnalyticsEvent.HostUpdateStarted, {
        source,
      });
    },
    onSucceeded: () => {
      Analytics.getInstance().track(AnalyticsEvent.HostUpdateSucceeded, null);
    },
    onFailed: (error) => {
      Analytics.getInstance().track(AnalyticsEvent.HostUpdateFailed, {
        blocker: analyticsBlockerFromError(error),
      });
    },
  };
}

/** Fires `setting_changed` for the given Settings section/setting pair. */
export function trackSettingChanged(
  section: AnalyticsSettingsSection,
  setting: AnalyticsSetting,
): void {
  Analytics.getInstance().track(AnalyticsEvent.SettingChanged, {
    source: "direct_ui",
    section,
    setting,
  });
}

/**
 * Wraps a settings-store setter so every call tracks `setting_changed` for
 * the given section before writing through. Shared by the Appearance and
 * General settings panels so both stay on one tracking contract.
 */
export function trackedSettingSetter<Value>(
  section: AnalyticsSettingsSection,
  setting: AnalyticsSetting,
  setter: (value: Value) => void,
): (value: Value) => void {
  return (value) => {
    trackSettingChanged(section, setting);
    setter(value);
  };
}

function analyticsPlatform(): "linux" | "macos" | "other" | "windows" {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "other";
}

function analyticsReleaseChannel(): "development" | "other" | "production" {
  if (import.meta.env.MODE === "development") return "development";
  if (import.meta.env.MODE === "production") return "production";
  return "other";
}

export class Analytics {
  private static instance: Analytics | null = null;
  private enabled: boolean;
  private readonly key: string | undefined;
  private identifiedUserId: string | null = null;

  private constructor() {
    this.key = import.meta.env.VITE_POSTHOG_KEY;
    this.enabled = !!this.key && import.meta.env.MODE !== "test";

    if (!this.enabled || this.key === undefined) return;

    const key = this.key;
    if (this.guarded(() => posthog.init(key, POSTHOG_CONFIG)) === null) {
      // A storage/security failure at init permanently disables analytics for
      // this process; the app must never pay for telemetry.
      this.enabled = false;
      return;
    }
    this.registerGlobals();
  }

  /**
   * Telemetry is best-effort and many call sites run product-critical work
   * after a capture, so no SDK exception may escape this adapter.
   */
  private guarded<Result>(operation: () => Result): Result | null {
    if (!this.enabled) return null;
    try {
      return operation();
    } catch {
      return null;
    }
  }

  private registerGlobals(): void {
    this.guarded(() =>
      posthog.register({
        app: "gui-app",
        app_version: import.meta.env.VITE_APP_VERSION ?? null,
        platform: analyticsPlatform(),
        release_channel: analyticsReleaseChannel(),
      }),
    );
  }

  static getInstance(): Analytics {
    if (Analytics.instance === null) Analytics.instance = new Analytics();
    return Analytics.instance;
  }

  /**
   * The SDK persists identity across renderer restarts, so the in-memory id
   * alone cannot see a cross-account transition on a cold start. Anonymous
   * state is `distinct_id === $device_id` (the SDK's own proxy for it).
   */
  private persistedIdentifiedUserId(): string | null {
    const distinctId = this.guarded(() => posthog.get_distinct_id());
    if (typeof distinctId !== "string") return null;
    const deviceId = this.guarded((): string | null => {
      const value: unknown = posthog.get_property("$device_id");
      return typeof value === "string" ? value : null;
    });
    return distinctId === deviceId ? null : distinctId;
  }

  identify(userId: string, email: string | null): boolean {
    if (!isSafeOpaqueIdentity(userId)) {
      this.identifiedUserId = null;
      this.guarded(() => posthog.reset());
      this.registerGlobals();
      return false;
    }
    const knownUserId =
      this.identifiedUserId ?? this.persistedIdentifiedUserId();
    if (knownUserId !== null && knownUserId !== userId) {
      // Cross-account transition (including a cold start on another account's
      // persisted state): drop the previous identity and session before the
      // new identify so the two accounts' streams cannot blend.
      this.guarded(() => posthog.reset());
      this.registerGlobals();
    }
    this.guarded(() =>
      posthog.identify(userId, email === null ? undefined : { email }),
    );
    this.identifiedUserId = userId;
    return true;
  }

  reset(): void {
    this.identifiedUserId = null;
    this.guarded(() => posthog.reset());
    this.registerGlobals();
  }

  track<Event extends AnalyticsEvent>(
    event: Event,
    properties: AnalyticsEventProperties[Event],
  ): boolean {
    const safeProperties = sanitizeAnalyticsProperties(event, properties);
    if (safeProperties === null) return false;
    this.guarded(() => posthog.capture(event, safeProperties));
    return true;
  }
}
