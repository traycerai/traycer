# Formal model of the chat transcript's scrolling

`ChatScroll.tla` models one chat tile: bottom-follow while a reply streams,
explicit navigation (the turn minimap, the phone's Messages list, the pill),
reader input on a desktop and on a phone, and the saved reading position
across hide/show and remount. TLC explores every interleaving of those events
within small budgets and checks what a reader would notice.

## What is modelled

| Spec                                                                                                                                                                                                                                                                                                            | Production (`src/`)                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `LatchSetIntent`, `ObserveLiveGeometry`, `FollowEndIfPermitted`, `ReconcileStrictBottom`, `TryReattach`, `NoteReaderGesture`, `ClearTouch`, `CompletePointerPreflight`, `StartEndCorrection`, `CorrFrame`                                                                                                       | `components/chat/chat-timeline-follow-latch.ts`                                                                                            |
| `Grow`, `AppendRow`, `PrependRow`, `Measure`, `StructSettle`, `ResizeObserved` (the maintain calls)                                                                                                                                                                                                             | `components/chat/chat-timeline.tsx`                                                                                                        |
| `OnIntentChange`, `SetTimelineMode`, `SetFollowingEndFromPosition`, `ResolveSuppressedEndLanding`, `HandleReaderGesture`, `IssueFree`, `NavigateToMessage`, `ScrollToEndNav`, `NavSettle`, `RestoreIssue`, `RestoreSettle`, `MountAbort`, `Capture`, `Persist`, `Hide`, `Show`, `HydrationEffect`, `MountState` | `components/chat/chat-messages.tsx` (`ChatMessagesInner`)                                                                                  |
| `RestoreState`, `RestoreForMount`                                                                                                                                                                                                                                                                               | `stores/chats/chat-tab-state-cache.ts`                                                                                                     |
| `LibCall`, `LibRun`, `LibReady`, `LibReadyTimeout`, `LibFinish`, `SmoothStep`, `Resolve`                                                                                                                                                                                                                        | `@legendapp/list` 3.3.4 with `patches/@legendapp%2Flist@3.3.4.patch`: `createImperativeHandle`, `scrollTo`, `doScrollTo`, `finishScrollTo` |
| `Write`, `DeliverScroll`, `DeliverScrollEnd`, `NavFallback`, `RestoreFrame`                                                                                                                                                                                                                                     | the browser: coalesced `scroll`, `scrollend`, timers, animation frames                                                                     |

Each event handler, timer, frame callback, promise continuation and React
commit is one atomic step, because JavaScript runs one task at a time.

Geometry is in whole units. The list lays rows out by its believed sizes
(`sz`, the estimate `EST` until a row is measured), so scroll offsets and row
tops use those; `real` is what the next measurement reads. The 1px epsilons
are below one unit, so "at the strict bottom" and "landed" are exact here.

Left out: find, cross-tile scroll requests (`landScrollRequestRow`), turns
split into parts, the windowed line's placeholders and voids, keyboard
scrolling (its latch path is the wheel's, less the wheel's maintenance call),
frames inside sandboxed pages, the list's own first-paint scroll to a
reopened chat's saved row (`initialScrollIndex`), which holds back the list's
scroll reports until it finishes, and the list re-estimating unmeasured rows
above the viewport, which resizes only its content element (here every size
change is a measurement the maintain calls see). A row here grows at its
end, so a measurement keeps the row under the viewport's top edge in place;
the patched list does the same, and also compensates growth inside that row
above the edge, which the model leaves out.

## Fixes

`Fixes` switches the client's fixes on. `gen-configs.py` writes every config
twice: `<name>` is the code before them (`Fixes = {}`), `<name>_fixed` the set
the client ships (`{"nav", "toward", "restore", "pill", "cancel", "paint", "reach", "arrive"}`).

| Fix           | Production                                                                                                                                                                                                                                                                                                                              | What it removes                                                                                                                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"nav"`       | `issueFreeTimelineNavigation` settles on the list's own promise, counts a landing the browser clamps as landed, and owns the view until its last command has run; `completeOwnedFreeNavigation` lets the landing decide follow                                                                                                          | A pick in the last screenful holds follow off through every retry, then leaves the reader free while the reply streams on below                                                                                                                                                     |
| `"toward"`    | `noteReaderGesture`: a toward-end gesture while following arms no departure; `handleWheel` then runs maintenance                                                                                                                                                                                                                        | A wheel down while following, reported just after the tail grew, detaches the reader at the end of the stream                                                                                                                                                                       |
| `"restore"`   | `restorePersistedTimelineLocation` places the saved row by index and yields only to input that publishes a position; `resolveSuppressedEndLanding` stops a restore only on proof or for a partial snapshot; the mount restore's frozen target ends with its loop; the latch publishes a free reader's moved touch while a restore holds | A reopen near the tail, a click or a first touch during the restore, or a saved row deep in a long reply leaves the reader away from their position with nothing saved after; where a native pan withholds `touchmove` (not iOS 27), a free reader's touch scrolls never release it |
| `"pill"`      | `scrollToEnd`'s loop validates while the reader still follows and hands the remaining distance to maintenance                                                                                                                                                                                                                           | A pill click while a reply streams runs out of retries and drops the reader to free with the pill showing                                                                                                                                                                           |
| `"cancel"`    | `handleTimelineReaderGesture` retires the command the list still holds for a restore or navigation it ends, with the target and anchor lock it set up (`cancelPendingScroll`, added by the patch)                                                                                                                                       | A wheel as a reopened chat's saved rows arrive is undone when the restore's queued command lands after it                                                                                                                                                                           |
| `"paint"`     | a follow correction sets the end itself before issuing the list's command; the latch also follows the list's content-height write                                                                                                                                                                                                       | Each streamed chunk, and a sent prompt, shows short of the end for a frame (not visible at rest: the model checks it changes nothing there)                                                                                                                                         |
| `"reach"`     | `tryReattachReader` moves the end it waits for by however far the list has since moved the last row                                                                                                                                                                                                                                     | A reader scrolling toward the end while rows above them are remeasured counts as arriving before they get there, and is pulled to the tail                                                                                                                                          |
| `"arrive"`    | `reconcileStrictBottom` and `followEndIfPermitted` keep the reader's own request for the end through a strict-bottom landing a settling transcript may not grant, marked as reached; the first maintenance after the settle follows it                                                                                                  | A detached reader who wheels to the end while a new row settles stays detached as the tail grows on (in Chrome under load, 3 of 20 runs even with every other fix)                                                                                                                  |
| `"supersede"` | none: the model's only (`"cancel"` also retires that write when a restore or navigation is in flight)                                                                                                                                                                                                                                   | `supersedePendingEndCorrection`'s offset write, deferred by the list, lands stale. TLC finds it; Chrome does not reproduce it                                                                                                                                                       |

Four more fixes came from the browser tests, in timing the model leaves out:

| Production                                                                                                                                                                                                                                                            | Found by                                                                                                                                 | What it removes                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `noteReaderGesture` and `reconcileStrictBottom`: a strict-bottom scroll report delivered in a gesture's own frame, before its first animation frame, no longer releases the gesture's arm; a gesture that has not moved by the end of the next frame is released then | the Chrome phone and stream matrices (a wheel in the model scrolls in the same step as its event; in a browser it scrolls a frame later) | A wheel up while following a stream, arriving just after an end write, is undone: the report that write queued releases the wheel's arm, and the wheel's own report is corrected back to the end                                                                                               |
| `publishArmedDeparture` records the offset a reader's departure was published at, and maintenance does not re-follow that reader at the strict bottom until a report at another offset, a toward-end gesture, or a re-follow                                          | the Chrome pill test (wheels up while a paragraph streams)                                                                               | A wheel up while following is pulled back to the tail: its first report comes from the latch's own write, which the list clamps short of a temporary end pad, so the reader detaches; the pad then drops, and maintenance re-follows them at the new end before the wheel's own scroll reports |
| The list patch: `startImperativeScroll` commits the scroll adjust that the command it replaces deferred while animating                                                                                                                                               | the Chrome navigation matrix                                                                                                             | The pill pressed right after a new turn lands short of the end, with the pill still showing                                                                                                                                                                                                    |
| The list patch: `cancelPendingScroll` also finishes the list's first-paint scroll if it is in flight when the reader takes over, at the reader's position. One not yet issued is left to place the saved row                                                          | an iOS 27 Simulator                                                                                                                      | Without it, `"cancel"` ended that scroll unfinished: the list issued it again over the reader and held back its scroll reports, so a pan during a reopen was never saved and hide/show went back to the restored row                                                                           |

## Platform switches

| Constant             | Desktop (Electron, Chrome)                                                             | Phone (iOS WebKit in Capacitor)                           |
| -------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `HasWheel`           | `TRUE`                                                                                 | `FALSE`                                                   |
| `TouchInput`         | `FALSE`                                                                                | `TRUE`                                                    |
| `TouchMoveDelivered` | —                                                                                      | `TRUE`: `touchmove` keeps arriving through the native pan |
| `HasScrollEnd`       | `TRUE`                                                                                 | `FALSE`                                                   |
| `DeferUnderFinger`   | `FALSE`                                                                                | `FALSE`: a scrollTop write under a finger applies at once |
| `Foreground`         | `TRUE` (`FALSE` in `nav_follow_bg`: an occluded window stops frames, timers still run) |

The phone values were measured in an iOS 27.0 Simulator: 166 to 197
`touchmove` events per pan, at most 34 ms apart, and every write made under
the finger (the list's anchoring `scrollBy` and a restore's `scrollTo`) read
back at once. Momentum after the lift reports scrolls coalesced (some painted
positions get no `scroll` event), which the model's single pending scroll
report already covers. The spec keeps the opposite values as switches: they
were the model's first assumption about the native pan, and iOS 27 does not
behave that way.

With these values, `phone_pick_fixed` and `phone_restore_fixed` hold up to the
600s bound. `phone_read_fixed` still breaks `I_IntentHeld`, with the same trace
as before the fixes. The reader drags away from a streaming reply and flings
back. The fling reaches the end, the reply's next chunk grows the last row
before the scroll report for that frame, and the fling stops there. The only
report is short of the new end, so the reader stays detached with the pill
showing. In an iOS 27 Simulator, 15 attempts aimed at that ordering (a chunk
every 16 to 33 ms) never produced it: each fling that reached the end went on
to report the live end and followed again. It is recorded here, not fixed.

`NoOpPicks = FALSE` limits picks to rows whose landing moves the view, which
separates the streaming form of a minimap failure from its no-op form.

The `send*` configs put a send at the tail: the prompt's row, then the
reply's row, each a key-sequence commit the list settles under its anchor
lock, then the reply's tokens; `send_wheel` adds a wheel while it settles,
`send_pick` a pick. `nav_follow_click` clicks a card before a pick lands.

## Checks

| Invariant               | What the reader sees when it fails                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `I_IntentHeld`          | At rest, the transcript is not where they put it: not at the tail they asked for, not at the row they scrolled to, not at the row they picked |
| `I_SavingLive`          | At rest with the whole transcript loaded, the position is not being saved, so the next reopen goes back to an old one                         |
| `I_SavedIsView`         | Hiding or leaving the chat saved something other than what was on screen                                                                      |
| `I_ModeMatchesGeometry` | Follow is on away from the tail (the next token pulls the view down), or off at the tail (new content does not follow)                        |
| `I_PillHonest`          | The jump-to-latest pill shows at the tail, or is missing away from it                                                                         |

"At rest" (`Quiescent`) means nothing is in flight: no navigation, correction,
list command, scroll event, pending effect, finger, fling, or unmeasured row
on screen.

## Running

TLC needs Java 11+ and the pinned `tla2tools.jar` (gitignored):

```bash
brew install openjdk@17     # or apt-get install openjdk-17-jre-headless
gh release download v1.7.4 -R tlaplus/tlaplus -p tla2tools.jar -D clients/gui-app/formal/tools

clients/gui-app/formal/gen-configs.py          # writes every ChatScroll_<name>.cfg
clients/gui-app/formal/check.sh ChatScroll_nav_follow
clients/gui-app/formal/run-all.sh ChatScroll_nav_follow   # every invariant, one trace each
clients/gui-app/formal/trace.py results/ChatScroll_nav_follow.I_IntentHeld.out
```

`check.sh` runs one config with 2 workers and a 3 GB heap (`TLC_WORKERS`,
`JAVA_XMX`). `run-all.sh` checks all of a config's invariants breadth-first,
saves the first violation's shortest trace, drops that invariant and repeats;
`TLC_TIMEOUT` (default 600s) caps each pass. Edit `gen-configs.py`, not the
`.cfg` files. `results/` and `states/` are gitignored.

`trace.py` prints one line per step: the scroll offset over the maximum,
each row as `r<id>@<top>:<size>` (`~n` is the size its next measurement
reads), the controller's mode, the latch's permission and arm, and anything
in flight.
