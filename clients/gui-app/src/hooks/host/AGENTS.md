# Host addressing and placement

Read this when changing host addressing, pins, composer placement, host-scoped stores, or which client a composer RPC uses.

`hostId` is canonical.
"device" is UI copy only - no parallel `deviceId` field.

## Two scopes

- **Tab / tile** - bound to a `hostId` for life (`<TabHostProvider>` → `useTabHostId()` / `useTabHostClient()`).
- **App-wide** - `useEffectiveHostId()` / `useHostClient()`.
  `useEffectiveHostId()` is the selection authority's DERIVED host.
  Settings ▸ Activate is the only UI gesture that changes it.
  Surface pickers write a per-surface pin (`useSurfaceHostPin`); a surface with no pin resolves to `useEffectiveHostId()`.

Do not mix the two.
`useAddressableHostId()` is the current binding's host, not a tab binding.

Cross-host continuation is **clone-not-migrate**.
Reachability is checked at tab-open only.

## Pins

A pin is a preference, not a binding.
`resolvedHostId` is the pin while that host can serve and `effective` while it cannot, so a surface whose pinned host dies AUTO-FOLLOWS and returns when the host is usable again.
Death does not clear the pin; only deliberate deregistration does.
Death is `lease.status === "dead"`, not `!isUsableForSelection` (`restarting-expected` is a hold).
Read `honoredSelection`, never `selection`, when resolving a client - the raw pin still names the dead host.

## Composer placement

The composer is PLACEMENT.
Its resolved host decides where a created epic / chat lives for life, so its picker writes that pin and never the app-wide selection.
A create that resolves its host separately from the chip is the bug this structure exists to prevent.

`null` override means "this surface owns its placement":

- Landing composer: WINDOW-keyed pin ?? `effective` (`useComposerPlacement`).
- In-Epic new-conversation modal: per-EPIC pin ?? Epic session host ?? `effective` (`useEpicConversationPlacement`).
  The per-Epic pin is that Epic's last created chat's host.

Read the header of `use-composer-placement.ts` before changing creates, submit, or composer RPCs.
Submit uses a frozen requester (`submitTarget`), not the live `target` client - the live client can rebind mid-chain.

Every host RPC around a composer (mentions, slash commands, harness / model catalog, pack retry) resolves through that host's client (`…ForClient` / `runTargetHostId` → `useHostClientForHostId`).
Default-host wrappers (`useProvidersList()`, `useGuiHarness*Query()`) are for app-wide surfaces only.

**"Default host" means the SURFACE's host.**
Inside Settings that is the SCOPED one.
Resolve a binding through `lib/host/binding-host-client.ts`.
Never inline `hostClient.createRequesterForHostId(...)` beside a separately-read host id.

## Host-scoped memory

`composer-run-settings-store`, `composer-harness-memory-store`, `workspace-folders-store`, and `worktree-intent-memory-store` bucket by `hostId`.
Anything keyed by a bare **local path** belongs in this set: the same string names a different directory on two machines.
Do not treat a key as "already host-bound" because its id happens to imply one host.
Invalidations are scoped too: a worktree sweep takes that `hostId` and touches only that host's slots.
`worktreeStagingKeyString` puts the host segment first and percent-encodes it.

## Dictation exception

`useDictationAvailability` / `useVoiceDictation` stay on the app-wide host even inside a host-pinned composer.
They describe the person at the keyboard (`speech.dictate`, `speech.ensureModel`), not the run.
Scope a NEW composer RPC to the target host unless it is about the human's input devices.
