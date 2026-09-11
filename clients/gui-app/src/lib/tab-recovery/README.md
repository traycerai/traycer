# Closed-tab recovery

`tab.reopen` (Cmd/Ctrl+Shift+T), the command palette, and both tab-strip
context menus share `reopenClosedTab`. History is per account and desktop
window and persists in IndexedDB. Application-window closes and landing
terminals never enter this history. Empty Start Pages and blank inner picker
tabs are excluded at capture and when loading older journals. Text and
image-only drafts remain recoverable; task tabs remain recoverable even when
their canvases are empty.

One eligible close creates one entry, including bulk closes. Group close waits
for an active tab’s unsynced-edits confirmation before closing any member;
cancelling leaves the group intact, and unrelated closes are separate actions. A task close
captures one task view and its canvas, not individual child closes. Moves,
submission of a new-task draft, and confirmed content deletions are excluded.
Confirmed deletions prune saved references; unavailability is not deletion.
Record-backed tiles closed during creation use the existing preserved pending-create
payload for liveness, so an authoritative snapshot that has not received the new
record yet does not erase recovery. Explicit deletion still takes precedence.
Host-confirmed deletion also prunes an evicted local mirror; an unknown local
delete request does not remove recovery history.
Initial history reads retry at most twice (after 100 ms and 300 ms), reopening
a failed database connection and checking the account generation before each
attempt. Exhausted reads leave persistence disabled for that bucket until a
successful hydration. Retrying configuration merges pending closes and applies
pending deletions without overwriting the unread journal.

Single recovery selects the restored view. Bulk recovery in the current task
preserves focus; bulk recovery in another task selects that task. Bulk header
recovery retains the current top-level selection. Exact view identities are
restored: another view of the same content does not count as already recovered.
A single recovery replaces the active empty standalone Start Page, so closing
and recovering the last task does not leave an extra placeholder. Text drafts,
image-only drafts, and deliberate split slots are preserved. Bulk header
recovery preserves its surviving selection, including a Start Page.

`header-layout.ts` captures each closed header tab's split, customization, and
named-group metadata. Bulk capture reads the original layout once, so both
sides of a split share one strip position. Recovery restores the original split
pairing and ratio when its members are available as standalone tabs with
compatible group membership. A surviving partner keeps its current position;
a partner in a new split, a changed group, or a structurally locked view is left
alone, and the closed tab returns standalone. An empty Start Page that is a
remembered split partner is retained. Only eligible recovery items are opened;
split metadata never resurrects a missing or permanently deleted partner.

Recovered tabs regain their color/icon and group membership. A removed group's
name, color and collapsed state are restored; an existing group's newer state
wins. The normal single/bulk navigation rules still decide selection. Older
journal entries without placement metadata retain standalone recovery, and
invalid optional placement metadata does not discard recoverable content.

`restore-canvas.ts` reconstructs the smallest recognizable changed region of
an ID-addressed split tree. It ignores tab edits and size changes when checking
structure, preserves surviving pane contents and unrelated sizes, and falls
back to the owning task's active pane when the original region was moved or
restructured. Explicitly closing an empty non-root pane records its layout;
recovery reconstructs that pane only while its structural anchor is recognizable.
An unreconstructable empty pane is skipped, without an active-pane fallback.
Restored content tabs are permanent, not previews. Before reconstruction, recovery
releases a focused pane opener so cmdk cannot autofocus a remounted empty
sibling and reclaim the active pane. Bulk recovery restores a surviving
opener's keyboard focus after the render unless the user has moved focus.

The initial empty-task fallback creates an empty pane showing the picker, not a
blank tab. New Tab gestures focus the existing picker in an empty pane; in a
populated pane they reuse its blank tab (even if inactive) or create one.
Explicit New Tab focus is delivered by the active picker when its input mounts,
without frame retries. Requests are scoped to the task tab and pane, and user
interaction cancels a pending request.
Closing a blank tab, including a blank-only Close All, leaves its pane intact.
Explicit Close Group removes the pane. Loading older canvases retires blank-only
tabs and duplicate picker tabs without removing their panes or changing splits.

Draft recovery stores the saved draft ID, owner host, and header placement.
The saved-draft store owns content and image retention; reopening a closed row
uses its current content. An already-open row is skipped. A missing adopted
mirror is read from its owner host; transient host/image failures retain the
recovery action, while permanent draft deletion prunes it. Bulk recovery keeps
the surviving draft selection. History's Drafts list and Cmd/Ctrl+Shift+T reuse
the same saved rows.

Old snapshot journals are read for compatibility only. If no saved draft exists,
the legacy snapshot is imported once as a closed saved draft, including pending
paste bytes. It never overwrites a newer saved row. Legacy image contents from
all accounts in the window count toward the existing image budget and remain GC
roots until imported or expired; new reference-only entries own no images. Inline
legacy images reserve capacity as a batch before storage writes. Admission never
evicts recovery entries: a rejected paste or restore leaves history intact.

The journal retains at most 50 closing actions with a 32 MiB approximate JSON
budget (the newest action is always kept). Pruning retains unchanged entry
objects so the cached size of unrelated history is reused. Shutdown drains
queued journal writes; resetting local application state clears the journal too.

Browser startup waits for the account-scoped canvas to hydrate before resolving
saved tab routes or reconciling the strip. The initial empty anonymous canvas
must not remove or reorder the account's saved tabs. Signed-out startup and
failed local storage access also settle the hydration gate.

## Regression checks

From `clients/gui-app/`:

```sh
bun run vitest run src/lib/tab-recovery/__tests__ src/stores/epics/canvas/__tests__/actions.test.ts src/stores/epics/canvas/__tests__/migrate-canvas.test.ts src/stores/tabs/__tests__/tab-recovery-coordinator.test.ts src/providers/__tests__/windows-bridge-provider.test.tsx src/lib/composer/__tests__/landing-image-gc.test.ts src/lib/persist/__tests__/wipe.test.ts
bun scripts/tab-recovery-browser-regression.mjs
```

The browser regression launches a disposable Chrome profile and Vite fixture.
It uses real tab stores, coordinator, split restoration, navigation, TabStrip,
and IndexedDB; authentication and host services are in-memory fixtures. It
covers empty history, draft and task recovery, bulk recovery, collapsed inner
splits, top-level split recovery across reload, named-group recovery, reload
persistence, and duplicate recovery. Set `CHOKIDAR_USEPOLLING=true` if
the machine has exhausted native file watchers.

For live authenticated browser validation, also exercise keyboard and both
context menus, command-palette recovery, navigation from landing/another task,
preserved bulk focus (including an active pane opener), nested splits,
changed-split fallback, duplicate task views, typed and
image-only draft preservation, the 50-action limit after 55 UI closes, and
landing-terminal exclusion. Restart the full browser process to exercise
persisted history and retained image bytes.

Confirmed deletion pruning, partial recovery failures, account/window isolation,
image retention, and stale asynchronous recovery are covered by focused tests.
These checks do not simulate native Electron window ownership, OS quit delivery,
or a real multi-host disconnect. Check published content on an offline host
separately from a live host disconnect.

Host-backed image recovery reads bytes first, reserves their actual total size
as one batch, then verifies hashes and stores them before reopening. Missing
or stale size metadata is replaced with measured sizes for future accounting.
Capacity failure preserves the saved drafts and the recovery entry. Direct
canvas-store closes capture their position from the full header strip, including
drafts and split items.

Reconstruction aligns surviving child IDs with their original branches before
recursing, because closing a sibling shifts array positions. It never replaces
a live sibling with the removed pane. Host draft list absence remains retryable;
only a matching tombstone proves deletion. Tile deletions use scoped recovery
pruners and record liveness, not the legacy global bare-ID deletion set.

Confirmed deletion callbacks suppress close recording, and successful terminal-agent
deletion prunes recovery using its task, type, host and content ID. Buffered closes
and deletion prunes remain keyed to their original account/window while hydration
is unavailable; switching back merges them with that bucket's unread journal.
