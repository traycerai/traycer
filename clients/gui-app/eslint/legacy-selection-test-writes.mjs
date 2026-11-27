// Existing projection inputs outside the pool surface change. Keep exemptions
// specific to their consumers so new tests arrange evidence through the fixture.
export const legacySelectionTestWrites = [
  // Seeds the host for nested-focus interaction fixtures.
  "src/__tests__/nested-focus-interaction-fixtures.test.tsx",
  // Seeds the Tracy tab's host for the channel sidebar.
  "src/components/bots/__tests__/bot-channel-sidebar.test.tsx",
  // Drives the bot card's host and attachment transitions.
  "src/components/bots/__tests__/bot-channel-surface-card.test.tsx",
  // Seeds the bot search harness's tab host.
  "src/components/bots/__tests__/bot-search-surface-support.tsx",
  // Seeds the tab host for the bot surface harness.
  "src/components/bots/__tests__/bot-tab-surface-harness.tsx",
  // Seeds the threads view's window host.
  "src/components/bots/__tests__/bot-threads-view-harness.tsx",
  // Drives attachment and effective host in the Tracy shell harness.
  "src/components/bots/__tests__/tracy-surface-shell.test.tsx",
  // Seeds the answering peer for mention target queries.
  "src/components/bots/__tests__/use-bot-mention-targets-answering-peer.test.tsx",
  // Seeds the host for message-body thread actions.
  "src/components/chat/__tests__/chat-message-user-body.test.tsx",
  // Seeds the host for thread reference navigation.
  "src/components/chat/__tests__/thread-reference-chip.test.tsx",
  // Seeds the active host for tool segment actions.
  "src/components/chat/segments/__tests__/tool-segment.test.tsx",
  // Seeds the window host for available bot rows.
  "src/components/command-palette/__tests__/command-palette-bot-rows.test.tsx",
  // Seeds the separate app-serving host for thread submission.
  "src/components/comments/__tests__/comment-thread-card-submit.test.tsx",
  // Injects leases for individual bounded-loading arms.
  "src/components/epic-canvas/__tests__/bounded-loading-catalog.test.tsx",
  // Publishes the older-host shell's task-handoff sequence.
  "src/components/epic-canvas/__tests__/epic-shell-older-host.test.tsx",
  // Models transitions between live Git Diff hosts.
  "src/components/epic-canvas/git-diff/__tests__/git-diff-panel-body-live.test.tsx",
  // Seeds the mobile tile window's host.
  "src/components/epic-canvas/mobile/__tests__/mobile-tile-header-actions.test.tsx",
  // Injects leases for browser-session transport transitions.
  "src/components/epic-canvas/renderers/__tests__/browser-sessions-provider.test.tsx",
  // Seeds the runtime gate's reachable chat carrier.
  "src/components/epic-canvas/renderers/__tests__/chat-tile-runtime-gate.test.tsx",
  // Seeds and resets host state for published-copy rendering.
  "src/components/epic-canvas/renderers/__tests__/published-chat-tile.test.tsx",
  // Uses the named projection seam to exercise task surface isolation.
  "src/components/epic-tabs/__tests__/epic-surface-isolation.test.tsx",
  // Seeds the host used by the access-check notice.
  "src/components/home/__tests__/access-check-notice.test.tsx",
  // Seeds and clears the Home page host.
  "src/components/home/__tests__/home-page.test.tsx",
  // Seeds the access-check host for a landing draft.
  "src/components/home/__tests__/landing-draft-surface-access-check.test.tsx",
  // Seeds and clears the host for the team-owner action harness.
  "src/components/home/__tests__/use-landing-composer-actions-team-owner.test.tsx",
  // Seeds the host for bot creation.
  "src/components/home/bots/__tests__/create-bot-form.test.tsx",
  // Selects the host used to open the bot row.
  "src/components/home/bots/__tests__/home-bot-row.test.tsx",
  // Seeds Home bot-group host selection.
  "src/components/home/bots/__tests__/home-bots-group.test.tsx",
  // Injects the unattached bootstrap state for the unseeded draft.
  "src/components/home/composer/__tests__/landing-composer-unseeded-draft.test.tsx",
  // Seeds and clears the workspace-source host.
  "src/components/home/host-workspace-selector/__tests__/use-home-workspace-source-cap-eviction.test.ts",
  // Seeds the host for sandbox runtime state cards.
  "src/components/hosts/__tests__/sandbox-tile-state-frame.test.tsx",
  // Publishes host transitions to check mount continuity.
  "src/components/layout/__tests__/app-stays-mounted-across-host-switch.test.tsx",
  // Injects the gate's bootstrap, hold, and ready projections.
  "src/components/layout/__tests__/default-host-ready-gate.test.tsx",
  // Publishes host transitions to check app-shell continuity.
  "src/components/layout/__tests__/host-switch-keeps-app-mounted.test.tsx",
  // Seeds a local host for notification replay.
  "src/components/layout/__tests__/notification-focus-bridge.replay.test.tsx",
  // Projects host states to exercise claimed-computer narration.
  "src/components/layout/dialogs/__tests__/claimed-computer-narration.test.tsx",
  // Projects states for the window host modal.
  "src/components/layout/dialogs/__tests__/window-host-modal-host.test.tsx",
  // Projects discovery states for window narration.
  "src/components/layout/dialogs/__tests__/window-narration-discovery-wait.test.tsx",
  // Projects host changes into the mobile narrator.
  "src/components/layout/shell/__tests__/edge-swipe-window-narrator.test.tsx",
  // Seeds the host used by mobile Home navigation.
  "src/components/layout/shell/__tests__/mobile-nav-home.test.tsx",
  // Seeds the host used by the Tracy entry.
  "src/components/layout/tabs/__tests__/tracy-entry.test.tsx",
  // Injects host-scoped lease transitions for chat indicators.
  "src/components/notifications/__tests__/chat-indicator-host-scopes.test.tsx",
  // Drives host transitions in the Environment default-host source.
  "src/components/settings/environment/__tests__/environment-default-host-transition.test.tsx",
  // Seeds the serving peer for the Environment Skills route.
  "src/components/settings/environment/__tests__/environment-skills-pool.test.tsx",
  // Seeds the serving peer for Team Guide routing.
  "src/components/settings/environment/__tests__/team-guide-pool.test.tsx",
  // Sets the window's own host for team viewing.
  "src/components/settings/environment/__tests__/team-viewing-host-own-window.test.tsx",
  // Seeds window hosts for Members page routing.
  "src/components/settings/members/__tests__/members-page.test.tsx",
  // Seeds the window host for the Members view.
  "src/components/settings/members/__tests__/members-view.test.tsx",
  // Projects the deferred update slot's host state.
  "src/components/settings/panels/__tests__/host-update-required-slot-deferred.test.tsx",
  // Projects the update slot's host state.
  "src/components/settings/panels/__tests__/host-update-required-slot.test.tsx",
  // Arrived in the 27 Nov merge from main, where this test predates the guard.
  "src/components/settings/personal/__tests__/local-pick-computer-away.test.tsx",
  // Injects the lease used by the starting deadline.
  "src/hooks/agent/__tests__/use-host-reachability.starting-deadline.test.tsx",
  // Seeds the window host for peer-message navigation.
  "src/hooks/agent/__tests__/use-open-a2a-message-peer.test.tsx",
  // Projects the effective host for the subscription-count test.
  "src/hooks/bots/__tests__/bot-subscription-one-stream-per-host.test.tsx",
  // Seeds the window host for Tracy placement tests.
  "src/hooks/bots/__tests__/tracy-place-test-fixture.ts",
  // Seeds the answering peer for host environment bindings.
  "src/hooks/bots/__tests__/use-host-environment-bindings-query.test.tsx",
  // Projects the suite's existing engine output and resets it.
  "src/hooks/chats/__tests__/use-owner-sandbox-opens-live.test.tsx",
  // Seeds the host for workspace root mentions.
  "src/hooks/composer/__tests__/use-workspace-mention-roots.test.tsx",
  // Injects owner leases for batch Delete routing.
  "src/hooks/epic/__tests__/use-epic-batch-delete-owner-gone.test.tsx",
  // Injects owner leases for chat archive routing.
  "src/hooks/epic/__tests__/use-epic-chat-archive-routing.test.tsx",
  // Seeds and clears the effective host for create repair.
  "src/hooks/epic/__tests__/use-epic-create-refusal-repair-host.test.tsx",
  // Injects owner leases for missing-owner routing.
  "src/hooks/epic/__tests__/use-epic-owner-gone-routing.test.tsx",
  // Injects attachment and leases for Rename and Delete routing.
  "src/hooks/epic/__tests__/use-epic-rename-delete-routing.test.tsx",
  // Injects owner lease changes during record writes.
  "src/hooks/epic/__tests__/use-record-write-serving-host-id.test.tsx",
  // Projects the host for the GUI harness catalogue.
  "src/hooks/harnesses/__tests__/use-gui-harness-catalog.test.tsx",
  // Projects changes to test the composer placement freeze.
  "src/hooks/host/__tests__/composer-placement-freeze.test.tsx",
  // Projects effective host independently of the named draft.
  "src/hooks/host/__tests__/landing-draft-named-host-placement.test.tsx",
  // Injects loading projections to exercise the timing hook.
  "src/hooks/host/__tests__/use-bounded-host-load.test.tsx",
  // Projects selection inputs separately from the task client.
  "src/hooks/host/__tests__/use-epic-conversation-placement.test.tsx",
  // Projects a second answering host to test named resolution.
  "src/hooks/host/__tests__/use-host-client-for-host-id.test.ts",
  // Injects lease values for subscription selection.
  "src/hooks/host/__tests__/use-host-lease-value-selection.test.tsx",
  // Supplies answering-peer transitions to the host query hook.
  "src/hooks/host/__tests__/use-host-query-answering-peer.test.tsx",
  // Projects the app host alongside a fixed tab host.
  "src/hooks/host/__tests__/use-tab-host-client.test.tsx",
  // Seeds the live host for notification activation.
  "src/hooks/notifications/__tests__/use-notification-activation-live-host.test.tsx",
  // Seeds the host used by notification activation.
  "src/hooks/notifications/__tests__/use-notification-activation.test.tsx",
  // Supplies host peer states to organization queries.
  "src/hooks/organization/__tests__/organization-serving-peer.test.tsx",
  // Injects leases for simulator setup routing.
  "src/hooks/simulator/__tests__/use-start-simulator-setup-agent.test.tsx",
  // Seeds and clears the window host for tab navigation.
  "src/lib/__tests__/tab-navigation.test.ts",
  // Seeds the host used by Tracy channel navigation.
  "src/lib/__tests__/tracy-channel-selection.test.tsx",
  // Seeds the window host for Tracy placement pushes.
  "src/lib/__tests__/tracy-place-push.test.tsx",
  // Seeds the window host for bot palette commands.
  "src/lib/commands/__tests__/bots.source.test.tsx",
  // Projects the host at the version floor.
  "src/lib/host/__tests__/older-host-floor-gate.test.ts",
  // Injects explicit peers to test the serving decision projection.
  "src/lib/host/__tests__/serving-decision.test.ts",
  // Seeds the host projected to a stream runtime.
  "src/lib/host/__tests__/stream-runtime.test.tsx",
  // Projects explicit host states to test window client resolution.
  "src/lib/host/__tests__/window-host-client-resolution.test.tsx",
  // Injects narration input snapshots.
  "src/lib/host/__tests__/window-narration.test.ts",
  // Seeds effective hosts for the bot fallback router.
  "src/lib/notifications/__tests__/bot-chat-open-fallback.test.ts",
  // Seeds a host while bot notification navigation is pending.
  "src/lib/notifications/__tests__/bot-notification-navigation-lifetime.test.tsx",
  // Sets the effective host independently of the notification origin.
  "src/lib/notifications/__tests__/bot-notification-routing.test.ts",
  // Projects individual leases for session registry tests.
  "src/lib/registries/__tests__/chat-session-registry.test.tsx",
  // Seeds the window host for mobile tab-origin tests.
  "src/lib/tab-navigation/__tests__/mobile-tab-origin.test.tsx",
  // Seeds the host used by rendered Traycer references.
  "src/markdown/__tests__/traycer-reference-components.test.tsx",
  // Seeds an effective host to test the access coordinator.
  "src/providers/__tests__/epic-access-coordinator.test.tsx",
  // Uses the legacy named controller projection test seam.
  "src/providers/__tests__/epic-session-provider.test.tsx",
  // Projects host changes for harness catalogue prefetch.
  "src/providers/__tests__/harness-catalog-prefetcher.test.tsx",
  // Projects host swaps for compatibility routing.
  "src/providers/__tests__/host-compatibility-provider.test.tsx",
  // Seeds the host while checking pool auth in the notification feed.
  "src/providers/__tests__/notifications-cloud-feed-pool-auth.test.tsx",
  // Sets the window host independently of route recency and task host.
  "src/routes/__tests__/epic-tab-route-recency-wait.test.tsx",
  // Projects the answering peer for the History route.
  "src/routes/__tests__/history-answering-peer-integration.test.tsx",
  // Seeds host placement for the landing draft store.
  "src/stores/home/__tests__/landing-draft-store.test.ts",
  // Seeds and clears host state around tab transactions.
  "src/stores/tabs/__tests__/transaction-coordinator.test.ts",
];
