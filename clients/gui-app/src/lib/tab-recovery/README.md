# Closed-tab recovery

`tab.reopen` (Cmd/Ctrl+Shift+T), the command palette, and both tab-strip
context menus share `reopenClosedTab`. History is per account and desktop
window and persists in IndexedDB. Application-window closes and landing
terminals never enter this history. Empty Start Pages and blank inner picker
tabs are excluded at capture and when loading older journals. Text and
image-only drafts remain recoverable; task tabs remain recoverable even when
their canvases are empty.

One eligible close creates one entry, including bulk closes. A task close
captures one task view and its canvas, not individual child closes. Moves,
submission of a new-task draft, and confirmed content deletions are excluded.
Confirmed deletions prune saved references; unavailability is not deletion.

Single recovery selects the restored view. Bulk recovery in the current task
preserves focus; bulk recovery in another task selects that task. Bulk header
recovery retains the current top-level selection. Exact view identities are
restored: another view of the same content does not count as already recovered.
A single recovery replaces the active empty standalone Start Page, so closing
and recovering the last task does not leave an extra placeholder. Text drafts,
image-only drafts, and deliberate split slots are preserved. Bulk header
recovery preserves its surviving selection, including a Start Page.

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
Closing a blank tab, including a blank-only Close All, leaves its pane intact.
Explicit Close Group removes the pane. Loading older canvases retires blank-only
tabs and duplicate picker tabs without removing their panes or changing splits.

The journal retains at most 50 closing actions with a 32 MiB approximate JSON
budget (the newest action is always kept). Old closed image-bearing drafts can
also expire under the existing landing-image byte budget. Recovery references
protect image bytes from collection, including persisted histories of inactive
accounts in the same window; inline pending-paste bytes are retained
and stored by hash before the draft reopens. Shutdown drains queued journal
writes; resetting local application state clears the journal too.

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
covers empty history, draft and task recovery, bulk recovery, collapsed splits,
reload persistence, and duplicate recovery. Set `CHOKIDAR_USEPOLLING=true` if
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
