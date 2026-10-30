# Formal model of the chat transcript's scrolling

`ChatScroll.tla` models one chat tile: bottom-follow while a reply streams,
explicit navigation (the turn minimap, the phone's Messages list, the pill),
reader input on a desktop and on a phone, and the saved reading position
across hide/show and remount. TLC explores every interleaving of those events
within small budgets and checks what a reader would notice.

## Current scope and CI status

`SHIPPED` in `gen-configs.py` models OSS main at `4706d7b5c`, including #3071 at `ef13d502f`.
The generated set contains 176 exploration configs. The initial CI run selects
26 bounded configs explicitly in `expected.py`; it does not claim the final
full generated matrix has completed. It includes passing shipped configurations
and failing controls whose invariant sets must remain reproducible.

#3079's `idlehold` keeps a departed reader held when the end meets them,
exactly or by clamp, at idle as well as mid-turn. A maintenance hold re-bases
`depAt` under `deprebase`; `depAhead` remains the turn-end guard, and is no
longer an independent maintenance hold. The idle clamp+regrow scenario is
now in CI. `EndCameIdle` is the owner's accepted idle geometry/pill price;
raw controls retain the 13-state exact-meet and 17-state clamp witnesses.
`noidlehold` preserves the previous idle-follow rule for comparison.

#3081's announced pad clamp carries the ledger, departure and press reference
by its actual delta before any observer can see regrowth. `PadCycle` represents
an atomic reset, clamp and reopen. Fixed following/press cases hold;
`drag_pad_fixed_nopadannounce` keeps the prior 13-state unmoved-press witness.

The landed `momhybrid` / `tailblock` rules use announced-write travel and
a lift-time content end tracked by the trailing block. Pending work stays
separate: the contact-reference and owed-departure rules. The model currently seeds a
changed-to-free mode directly in `LatchSetIntent`, a stronger abstraction
than main's incomplete navigation/restore publications. That coverage will
be split into explicit publication and owed state with the pending fix;
these bounded checks are not evidence that main already handles those paths.

`ChatScroll_phone_above_tail_fixed` remains an exploration-only, known
19-state `I_IntentHeld` witness on #3071: an unrendered lift-time last row
has no captured tail block, so later growth above its final paragraph is
missed by the row fallback. A lazy-capture fix-forward is pending; this is a
production defect, not a residue. The positive config will join CI after
that fix lands. CI includes the fixed nested-wheel input-consuming no-op
and the row-only before-fix controls. The `nopadannounce` control also keeps
the known 18-state Mode/Pill symptoms of the unannounced pad clamp.

## What is modelled

| Spec                                                                                                                                                                                                                                                                                                            | Production (`src/`)                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LatchSetIntent`, `ObserveLiveGeometry`, `FollowEndIfPermitted`, `ReconcileStrictBottom`, `TryReattach`, `NoteReaderGesture`, `ClearTouch`, `CompletePointerPreflight`, `StartEndCorrection`, `CorrFrame`                                                                                                       | `components/chat/chat-timeline-follow-latch.ts`                                                                                                                                      |
| `Grow`, `AppendRow`, `PrependRow`, `Measure`, `StructSettle`, `ResizeObserved` (the maintain calls), `TurnEnd`                                                                                                                                                                                                  | `components/chat/chat-timeline.tsx`                                                                                                                                                  |
| `OnIntentChange`, `SetTimelineMode`, `SetFollowingEndFromPosition`, `ResolveSuppressedEndLanding`, `HandleReaderGesture`, `IssueFree`, `NavigateToMessage`, `ScrollToEndNav`, `NavSettle`, `RestoreIssue`, `RestoreSettle`, `MountAbort`, `Capture`, `Persist`, `Hide`, `Show`, `HydrationEffect`, `MountState` | `components/chat/chat-messages.tsx` (`ChatMessagesInner`)                                                                                                                            |
| `RestoreState`, `RestoreForMount`                                                                                                                                                                                                                                                                               | `stores/chats/chat-tab-state-cache.ts`                                                                                                                                               |
| `LibCall`, `LibRun`, `LibReady`, `LibReadyTimeout`, `LibFinish`, `SmoothStep`, `Resolve`                                                                                                                                                                                                                        | `@legendapp/list` 3.3.4 with `patches/@legendapp%2Flist@3.3.4.patch`: `createImperativeHandle`, `scrollTo`, `doScrollTo`, `finishScrollTo`                                           |
| `AverageJump`, `ReEstimate`, `HoldsRow`, `HoldsTop`, `ScrollPass`, `SizePass`, `DataPass`, `SettledPass`                                                                                                                                                                                                        | the same patch: `getItemSize` (its stale-estimate escape), `calculateItemsInView` (`holdCachedEstimatesAbove`), `recalculateSettledScroll`                                           |
| `Deferring`, `CommitPending`, `ListSaw`, `Adjust`                                                                                                                                                                                                                                                               | the same patch: `ScrollAdjustHandler.commitPendingAdjust`, `cancelPendingScroll`, `startImperativeScroll`                                                                            |
| `PadOpen`, `PadReset`                                                                                                                                                                                                                                                                                           | the same patch: `ScrollAdjustHandler`'s one-frame `paddingBottom`                                                                                                                    |
| `BootSettle`, `Relayout`, `InitPass`                                                                                                                                                                                                                                                                            | the same patch: `finishInitialScroll` and its `recalculateSettledScroll`, the kept end target, `handleBootstrapInitialScrollLayoutChange` and `schedulePreservedEndAnchorCorrection` |
| `Wheel`, `NestedWheel`, `UnscrolledWheel`                                                                                                                                                                                                                                                                       | `components/chat/chat-timeline-follow-latch.ts` (`handleWheel`)                                                                                                                      |
| `Write`, `DeliverScroll`, `DeliverScrollEnd`, `NestedScrollEnd`, `NavFallback`, `RestoreFrame`, `WheelScroll`                                                                                                                                                                                                   | the browser: coalesced `scroll`, `scrollend`, timers, animation frames, a wheel's smooth scroll                                                                                      |

Each event handler, timer, frame callback, promise continuation and React
commit is one atomic step, because JavaScript runs one task at a time. A
wheel is two: its handler, then its scroll, any number of steps later (Chrome's
smooth scroll first reports frames after the handler; the model sets no
bound). The handler always runs first: a scroll landing before its handler
is not an order Chrome showed (0 of about 830 runner runs), so the model has
no switch for it.

Geometry is in whole units. The list lays rows out by its believed sizes
(`sz`, the estimate `EST` until a row is measured), so scroll offsets and row
tops use those; `real` is what the next measurement reads. The 1px epsilons
are below one unit, so "at the strict bottom" and "landed" are exact here.

Left out: find, cross-tile scroll requests (`landScrollRequestRow`), turns
split into parts, the windowed line's placeholders and voids, keyboard
scrolling (its latch path is the wheel's, less the wheel's maintenance call),
frames inside sandboxed pages, and most of the list's initial-scroll
bootstrap (`initialScrollAtEnd`, `initialScrollIndex`): the first-paint scroll
to a reopened chat's saved row, which holds back the list's scroll reports
until it finishes, and the passes that run under it with MVCP suppressed. The
mount places the view in one step. What is left of the bootstrap is the end
target the list keeps after its initial scroll to the end (`InitialEnd`):
that scroll's settled re-layout (`BootSettle`), which the shipped hold
releases at, and a viewport resize (`Relayout`) that corrects back to a kept
target. The model takes the release's refresh as what re-finishes the
initial scroll and clears the target, and leaves out the target's 2s fallback
clear. A row here
grows at its end, so a measurement keeps the row under the viewport's top
edge in place; the patched list does the same, and also compensates growth
inside that row above the edge, which the model leaves out.

The list re-estimating unmeasured rows is in the model as one jump of the
estimate (`AverageJump`, to `REST`), after which whichever pass lays out a
stale row next replaces it. The list's own idea of the content size
(`pendingTotalSize`, which the browser trace of P6b's clamp suggests can
disagree with `scrollHeight`) is not: here the content is always the sum of
the believed sizes, so a commit clamps to the end only when a row below the
reader has measured smaller. Nothing here renders, so a frame painted beyond
the rows the list has mounted (a blank frame) cannot be seen.

## Fixes

`Fixes` switches the client's fixes on. `gen-configs.py` writes every config
twice: `<name>` is the code before them (`Fixes = {}`), `<name>_fixed` the set
the client ships (`{"nav", "toward", "restore", "pill", "cancel", "paint", "supersede", "reach", "arrive", "live", "hold-init", "fling", "evidence", "nested", "fallen", "depart", "keep", "padend", "turnguard", "ledger", "ledgermaint", "translate", "followguard", "liftledger", "obsarm", "momstill", "freeland", "freelanddep", "armcarry", "restspend", "deprebase", "heldgap", "pressland", "pressstep", "padannounce", "idlehold", "momhybrid", "tailblock"}`).
Some configs also run with one of them taken out (`<name>_fixed_no<fix>`;
`_fixed_nohold` takes out the estimate hold), with a rejected rule added
(`<name>_fixed_with<rule>`), and the estimate configs with `"hold-init"`
swapped for each rule it beat (`<name>_fixed_<rule>`).

| Fix             | Production                                                                                                                                                                                                                                                                                                                                                                                                               | What it removes                                                                                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"nav"`         | `issueFreeTimelineNavigation` settles on the list's own promise, counts a landing the browser clamps as landed, and owns the view until its last command has run; `completeOwnedFreeNavigation` lets the landing decide follow                                                                                                                                                                                           | A pick in the last screenful holds follow off through every retry, then leaves the reader free while the reply streams on below                                                                                                                                                                                                |
| `"toward"`      | `noteReaderGesture`: a toward-end gesture while following arms no departure; `handleWheel` then runs maintenance                                                                                                                                                                                                                                                                                                         | A wheel down while following, reported just after the tail grew, detaches the reader at the end of the stream                                                                                                                                                                                                                  |
| `"restore"`     | `restorePersistedTimelineLocation` places the saved row by index and yields only to input that publishes a position; `resolveSuppressedEndLanding` stops a restore only on proof or for a partial snapshot; the mount restore's frozen target ends with its loop; the latch publishes a free reader's moved touch while a restore holds                                                                                  | A reopen near the tail, a click or a first touch during the restore, or a saved row deep in a long reply leaves the reader away from their position with nothing saved after; where a native pan withholds `touchmove` (not iOS 27), a free reader's touch scrolls never release it                                            |
| `"pill"`        | `scrollToEnd`'s loop validates while the reader still follows and hands the remaining distance to maintenance                                                                                                                                                                                                                                                                                                            | A pill click while a reply streams runs out of retries and drops the reader to free with the pill showing                                                                                                                                                                                                                      |
| `"cancel"`      | `handleTimelineReaderGesture` retires the command the list still holds for a restore or navigation it ends, with the target and anchor lock it set up (`cancelPendingScroll`, added by the patch)                                                                                                                                                                                                                        | A wheel as a reopened chat's saved rows arrive is undone when the restore's queued command lands after it                                                                                                                                                                                                                      |
| `"paint"`       | a follow correction sets the end itself before issuing the list's command; the latch also follows the list's content-height write                                                                                                                                                                                                                                                                                        | Each streamed chunk, and a sent prompt, shows short of the end for a frame (not visible at rest: the model checks it changes nothing there)                                                                                                                                                                                    |
| `"supersede"`   | `supersedePendingEndCorrection` cancels the list's held end command and writes nothing                                                                                                                                                                                                                                                                                                                                   | A touch on a follow correction the list still holds is pulled back: the correction's offset write, deferred by the list while it settles, lands later at the stale offset                                                                                                                                                      |
| `"reach"`       | `tryReattachReader` moves the end it waits for by however far the list has since moved the last row                                                                                                                                                                                                                                                                                                                      | A reader scrolling toward the end while rows above them are remeasured counts as arriving before they get there, and is pulled to the tail                                                                                                                                                                                     |
| `"arrive"`      | `reconcileStrictBottom` and `followEndIfPermitted` keep the reader's own request for the end through a strict-bottom landing a settling transcript may not grant, marked as reached; the first maintenance after the settle follows it                                                                                                                                                                                   | A detached reader who wheels to the end while a new row settles stays detached as the tail grows on (in Chrome under load, 3 of 20 runs even with every other fix)                                                                                                                                                             |
| `"live"`        | the list patch: `commitPendingAdjust`'s no-target branch starts from the scroll node's offset (`getCurrentScrollOffset()`), not the list's `state.scroll`                                                                                                                                                                                                                                                                | A wheel during an animated pick is undone: the cancel commits the adjust MVCP held back from the offset the list last saw, which lags the scroll node by every scroll whose report is still pending (P6b)                                                                                                                      |
| `"hold-init"`   | the list patch (#3019 round 2): in every pass that anchors nothing, on a list that maintains position, each unmeasured row whose top as that pass lays it out is above the bottom of the view keeps its cached estimate; estimates refresh in a pass that anchors, and in the settled re-layout of the initial scroll to the end with the live offset at the end too                                                     | Once a type's average jumps, a pass that anchors nothing (the wheel's own scroll report, a data change MVCP does not anchor, the settled re-layout of a scroll at the end) re-estimates the unmeasured rows above the reader and throws them that far up (CI: 110 turns, about 78k px)                                         |
| `"fling"`       | `clearTouch` notes the end the lift leaves; momentum that reaches the end the last scroll report or maintenance saw, net of the list moving the last row since, follows again                                                                                                                                                                                                                                            | A fling back to a streaming reply's end stops detached with the pill showing, when a chunk moves the end on before the fling's report for that frame                                                                                                                                                                           |
| `"evidence"`    | `noteReaderGesture` records where the gesture began; a strict-bottom report releases a movable gesture's arm only when it shows that gesture's own movement (offset up, distance from the end up), never by timing                                                                                                                                                                                                       | A wheel up while following, whose smooth scroll lands frames after its handler, is pulled back to the end: a strict-bottom report queued before it (or the frame timer that released an unmoved arm) frees its arm first, and its own scroll then reads as layout's                                                            |
| `"nested"`      | `handleWheel`: a wheel a nested scroller takes is not a transcript gesture                                                                                                                                                                                                                                                                                                                                               | Under `"evidence"`, a wheel over a code block or table that scrolls it arms a departure no scroll of the transcript's will release, and follow stops while the reply streams on                                                                                                                                                |
| `"fallen"`      | (#3031, the latch) while the turn streams, a free reader at a strict bottom at or under the offset their departure was published at is the end come to them: they stay free, re-based there; once the turn has finished with them at the strict bottom, they follow. A strict bottom above that offset, and their own arrival (a gesture toward the end, which forgets the offset, a finger, a landing), follows at once | A reader who wheels up just off the end is pulled back to following when the end comes to them: the list's one-frame end pad resets and clamps them to the real end below where they departed, maintenance re-follows, and their wheel's own scroll is corrected to the end (M2)                                               |
| `"depart"`      | (#3022) while an away-from-end wheel's arm waits for a scroll, growth it keeps from being corrected is that reader's departure: free, with the pill, and nothing written                                                                                                                                                                                                                                                 | A wheel the transcript never scrolls (a descendant cancelled it, or Chrome latched it to a nested scroller at its edge), or whose scroll reports at the strict bottom the end has just come up to, leaves its arm waiting: follow stays on with nothing correcting and no pill while the reply streams on (R3, P8's end state) |
| `"keep"`        | (#3022) the list patch's `cancelPendingScroll` keeps the runner later `scrollToEnd` commands wait on (`runPendingScrollToEnd`)                                                                                                                                                                                                                                                                                           | A wheel that retires a held end correction leaves every later end command unrun: the pill then never completes, following, off the end, with nothing correcting (P8)                                                                                                                                                           |
| `"padend"`      | (#3031) while the list's end pad is open, an end write goes to the content's own end, not into the pad                                                                                                                                                                                                                                                                                                                   | A follow correction made while the pad is open lands in it, below the last row (a blank frame), and the pad's reset then clamps the reader                                                                                                                                                                                     |
| `"turnguard"`   | (#3031) the turn's end does nothing while a blocking gesture arm (not a touch's) still waits: following the reader would retire it                                                                                                                                                                                                                                                                                       | A reader the end came to wheels up at the strict bottom as the turn ends; the turn's end follows them and retires the wheel's arm, and the wheel's scroll, landing after, is corrected back to the end                                                                                                                         |
| `"ledger"`      | (#3035) the latch keeps the offset it expects the view at (`expectedScrollTopRef`): every announced write moves it, a reader's gesture clears it until the next report, and each report re-bases it. A following reader with no arm and no owned navigation whose report is above it has moved unannounced, and departs there (`publishUnannouncedDeparture`)                                                            | A finger that lands on a fling with no touch event (a silent contact) and pans away from a following reader is corrected back to the tail (R2)                                                                                                                                                                                 |
| `"ledgermaint"` | (#3035) maintenance reads the ledger too: a view moved off it with nothing announced is that reader's departure, before maintenance follows                                                                                                                                                                                                                                                                              | A held reader's second wheel up, before the first one's report: that report spends the arm both wheels share, and the turn's end then follows them with the second wheel's scroll still to land (W1)                                                                                                                           |
| `"translate"`   | (#3035) every announced write moves the offset a departure was published at by as much as it moves the view                                                                                                                                                                                                                                                                                                              | An anchored shift moves the view under a held reader, and the raw offset then reads them as returned, so they are followed again, or holds them with the pill at an end they reached (D1)                                                                                                                                      |
| `"followguard"` | (#3035) a follow transition (a strict-bottom maintenance, the turn's end) leaves a free reader's blocking gesture arm alone unless it is a touch's or toward the end                                                                                                                                                                                                                                                     | A remounted reader on the strict bottom wheels up; a maintenance there follows them, retires the wheel's arm, and the wheel's scroll is corrected back to the end (W4)                                                                                                                                                         |
| `"liftledger"`  | (#3035) at an announced contact's lift, the ledger is the view: everything up to the lift was the reader's                                                                                                                                                                                                                                                                                                               | A following reader drags off the end and back, lifts with a fling, and a finger then lands silently on the fling: the ledger the drag cleared is still empty, so the silent pan away reads as nothing and is corrected to the tail (R2)                                                                                        |
| `"obsarm"`      | (#3035's follow-up) an observation that sees the view on the end re-bases a finger's step there, as a report at that clamp would                                                                                                                                                                                                                                                                                         | A clamp a content change forces (a row measured smaller) lands under a resting finger before its scroll event; the finger's next step is measured from before the clamp and reads as a departure (T1)                                                                                                                          |
| `"momstill"`    | (#3053) momentum re-records the observed end and row reference while carrying the lift offset by known row shifts; arrival requires positive travel since that lift and a known target, with neither suppression active                                                                                                                                                                                                  | A reader who lifted without a fling is held where they departed; a row below them measured smaller brings the end up to them, and when it grows again the next observation reads their own spot as the momentum arriving and follows them                                                                                      |
| `"freeland"`    | (#3048) a free reader's report retires a blocking away-from-end gesture arm once that gesture's scroll has landed (the shared `gestureScrollLanded` predicate below)                                                                                                                                                                                                                                                     | A free reader wheels up and the scroll lands; the arm waits for good, so when the end later comes to them they stay free at the strict bottom with the pill, at rest (M2)                                                                                                                                                      |
| `"freelanddep"` | (#3048) when a free reader's report retires a landed arm, it records their departure there                                                                                                                                                                                                                                                                                                                               | A free reader with no departure whose wheel lands is retired, then a clamp reaches them before the wheel's later frames: they are followed mid-turn, and the next growth's correction swallows the rest of the wheel                                                                                                           |
| `"armcarry"`    | (#3048) every announced write carries a waiting gesture arm's offset (`noteScrollerMoved`), as it does the ledger and the departure; its distance from the end stays                                                                                                                                                                                                                                                     | An anchored write between a free reader's wheel and its scroll leaves the landing above the stale offset, so the landing is never seen and the arm waits for good (row 23's strand)                                                                                                                                            |
| `"restspend"`   | (#3048) the turn's end spends a waiting gesture arm a report has followed (the ledger is set), then reconciles any free reader at the strict bottom                                                                                                                                                                                                                                                                      | A wheel whose only report reads the strict bottom (it lands as the end pad releases) holds the reader free at the end for good                                                                                                                                                                                                 |
| `"deprebase"`   | (#3062's rebase variant) a moved report off the strict bottom re-bases the held departure in either direction; a strict-bottom report compares against the preceding offset so an actual arrival follows                                                                                                                                                                                                                 | Forgetting a departure, or keeping its older offset after a toward report short of the end, lets maintenance follow when the end later meets the reader mid-turn, and growth pulls them                                                                                                                                        |
| `"pressland"`   | (#3064) a scrollbar press departs, at a report or at pointerup (`completePointerPreflight`), only once its own scroll has landed (`gestureScrollLanded`)                                                                                                                                                                                                                                                                 | A following reader presses the scrollbar without moving; the end moves during the press, and they are left free with the pill though they never moved                                                                                                                                                                          |
| `"pressstep"`   | (#3064) report and maintenance observations re-base a press at toward-end travel, or at an end that drops below its carried reference; landing is measured from that geometry                                                                                                                                                                                                                                            | A reader presses, the end grows away, they drag to the end and report, then drag back to exactly the press offset: the old offset hides their departure and pointerup corrects them to the tail                                                                                                                                |
| `"heldgap"`     | (#3062) maintenance follows an idle reader whose departure was reported; an awaiting departure stays held through maintenance and the turn's end, even after its arm is consumed                                                                                                                                                                                                                                         | An idle end meeting strands a reported reader; releasing an awaiting departure at the turn's end lets its wheel be corrected when it finally scrolls                                                                                                                                                                           |

One more rule lost, to Codex's review of #3031: clearing a blocking gesture
arm at the turn's end (`"turnclear"`, `turn_wheel_fixed_withturnclear`). A
wheel up at the strict bottom whose scroll lands after the turn ends then has
no arm, and its scroll is corrected back to the end. The shipped turn's end
keeps an arm no report has followed; `"restspend"` spends one that has
reported. An awaiting departure also survives after its arm is consumed.

`"idlehold"` (#3079) replaces that idle follow with a hold at or below
the recorded departure on both paths, rebasing a maintenance hold. The
turn-end pending-report guard remains `"heldgap"`. If their wheel continues, its next report publishes a new departure
through the ledger (`publishUnannouncedDeparture`), before any correction.
A growth publication awaits its gesture's report only while the ledger is
null; free readers' gestures clear that ledger too. A maintenance or
correction-frame read that publishes unannounced movement always awaits
its still-owed report. Every report clears that awaiting flag. The turn's
end keeps an awaiting departure too: its growth publication may already
have consumed the gesture arm, but its scroll is still to come.
`idle_absorbed_fixed_withalwaysawait` retains the rejected ungated growth
publication after an absorbed report, to check its idle strand.

The departure-report comparison rejected two rules. Nulling the held
position on a toward report short of the end (`n`) fails `drag_pad` in a
17-state trace. Keeping its older value (`k`) also fails, in an 18-state
trace: maintenance mistakes the newer position for an arrival once the end
comes down to it. Rebasing that off-bottom report (`r`) holds the reader
there; the strict-bottom report still decides against the preceding offset,
so a reader who actually reaches the end follows. An arrival report
nulls the held offset even while a restore suppresses following, so lifting
that suppression cannot re-hold them at an end they already reached.

A gesture has landed (`gestureScrollLanded`, which `"freeland"`,
`"pressland"` and the strict-bottom release share) when the view is up from
where it began, that offset carried by announced writes (`"armcarry"`), and,
on the strict bottom, where a clamp lowers the offset with the end, farther
from the end too. Offsets are non-negative integers; elastic Safari
overscroll and its spring-back are below this model's dynamics. The code
compares clamped resting offsets so neither is a gesture landing.

`"pressstep"` re-bases at both scroll reports and maintenance reads, before
strict-bottom reconciliation. A view past the press's carried reference
starts the next step there. If the end drops below that reference, the new
reference is the end and no lower. Browser clamps are not announced writes;
only the movement an actual write makes carries the reference. A later
away step is measured from this geometry. A toward-end drag that stops
short still asks for the tail, and an unmoved press never departs by itself.

Some of the code the fixes run on is in the model without a switch, because
the code has no other form: a reader's own scroll away from the end retires
the list's kept initial end target; a finger's step is measured net of the
list moving the rows with the view (`rowAtStep`, `edgeAtStep`), and a
following reader's step toward the end never departs and re-bases the next
(#3031). `"deprebase"`, `"heldgap"` and `"restspend"` switch the report,
maintenance and turn-end departure rules described above.

Five rules lost to `"hold-init"` on the browser's evidence. Each is a switch,
in its place. The three that key the hold on the row's previous position
(`positions[index]`) hold nothing in a data pass, which empties `positions`
first (`resetLayoutCachesForDataChange`):

| Rule             | What it holds                                                                                                                                | What the browser showed                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"hold-all"`     | as `"hold-init"`, with no release (2da05c119)                                                                                                | B6: the initial scroll's end target outlived its finish, and a later width change pulled a detached reader to the tail. C4: the estimates the load left stale refreshed later in an anchored settled pass (+6276px), which the latch read as the reader leaving the end                                                                                                                                                                                      |
| `"hold-mvcp"`    | every cached estimate, in a pass with `doMVCP: false` (c5ab59c54)                                                                            | `chat-follow-latch-touch`: the first append after a swipe, a data pass MVCP does not anchor, refreshed the rows above and threw the reader 162px                                                                                                                                                                                                                                                                                                             |
| `"hold-release"` | as `"hold-init"`, but released in the settled re-layout of any end request the list judges finished at the end (aff940ac5, shipped in #3014) | the runners: the latch released a wheel's arm before its smooth scroll reported and corrected it to the end, and the settled re-layout of that correction's `scrollToEnd`, judging the end from `state.scroll`, grew the content about 78k px unanchored. The model has no trace of its own for this rule: with the wheel's handler first, it holds in every config, and the runners' return to the end is `I_IntentHeld` under the rule before `"evidence"` |
| `"hold-end"`     | as `"hold-init"`, but released in any pass the list judges at the end                                                                        | P6b: the cancel's freeze stopped at the end, and its settled re-layout re-estimated the rows above unanchored (content 33210 → 103019px)                                                                                                                                                                                                                                                                                                                     |
| `"hold-boot"`    | as `"hold-init"`, but released in the initial scroll's settled re-layout at the end the list judges from its own offset                      | `chat-follow-latch-touch` broke again; the spec read raw `scrollTop`, which an anchored refresh moves, and passes 320/320 reading the row                                                                                                                                                                                                                                                                                                                    |

Four more fixes came from the browser tests. The first is now in the model
(`"evidence"`, `"nested"`); the others are in timing it leaves out:

| Production                                                                                                                                                                                                                                                                      | Found by                                                   | What it removes                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `noteReaderGesture` records where the gesture began; a strict-bottom report releases a movable gesture's arm only when it shows that gesture's own movement (offset up, distance from the end up), never by timing; a wheel a nested scroller takes is not a transcript gesture | the Chrome wheel proof runs                                | A wheel up while following a stream is undone: its smooth scroll first reports frames after its handler, a strict-bottom report before then (one an earlier write queued, or the timer that released an unmoved arm) frees its arm, and its own report is corrected back to the end. Modelled as `"evidence"` and `"nested"` |
| `publishArmedDeparture` records the reader's departure; maintenance keeps one whose own scroll report is still owed                                                                                                                                                             | the Chrome pill test (wheels up while a paragraph streams) | A wheel up while following is pulled back to the tail: its first report comes from the latch's own write, which the list clamps short of a temporary end pad, so the reader detaches; the pad then drops, and maintenance re-follows them at the new end before the wheel's own scroll reports                               |
| The list patch: `startImperativeScroll` commits the scroll adjust that the command it replaces deferred while animating                                                                                                                                                         | the Chrome navigation matrix                               | The pill pressed right after a new turn lands short of the end, with the pill still showing                                                                                                                                                                                                                                  |
| The list patch: `cancelPendingScroll` also finishes the list's first-paint scroll if it is in flight when the reader takes over, at the reader's position. One not yet issued is left to place the saved row                                                                    | an iOS 27 Simulator                                        | Without it, `"cancel"` ended that scroll unfinished: the list issued it again over the reader and held back its scroll reports, so a pan during a reopen was never saved and hide/show went back to the restored row                                                                                                         |

`"padannounce"` (#3081) makes the pad restore's browser clamp an announced
list move. `PadReset` carries departure and press reference from pre-reset
geometry. `PadCycle` does the same before its atomic reopen; without the fix,
it preserves the unannounced ledger and references for the before witness.
`Cycles` budgets these atomic tasks. When paired with `Drags`, the dedicated
cycle scenario restricts input to a stationary press so it isolates that
producer regression from independent drag movement.

## Platform switches

| Constant             | Desktop (Electron, Chrome)                                                                                                                                       | Phone (iOS WebKit in Capacitor)                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `HasWheel`           | `TRUE`                                                                                                                                                           | `FALSE`                                                   |
| `TouchInput`         | `FALSE`                                                                                                                                                          | `TRUE`                                                    |
| `TouchMoveDelivered` | —                                                                                                                                                                | `TRUE`: `touchmove` keeps arriving through the native pan |
| `HasScrollEnd`       | `TRUE`                                                                                                                                                           | `FALSE`                                                   |
| `DeferUnderFinger`   | `FALSE`                                                                                                                                                          | `FALSE`: a scrollTop write under a finger applies at once |
| `Foreground`         | `TRUE` (`FALSE` in `nav_follow_bg`: an occluded window stops frames, timers still run; and in `release_wheel`, a renderer starved of frames on a loaded machine) | `TRUE`                                                    |

Three more switches belong to the list rather than the platform:
`DataAnchored` is `TRUE` for the chat timeline (its MVCP data channel anchors
a key-sequence change) and `FALSE` in `touch_end`, whose fixture's list
anchors no data change (`{data: false}`); `DeferAdjust` (MVCP holding its
adjust back under an animated command, and the list's own `state.scroll`) is
on in `p6b` and `release_wheel`; `REST` is the estimate once the average has
jumped. `WheelDirs` limits the ways a wheel may turn and `WheelsApart`
makes each wheel wait for the scroll report of the one before. `NestedWheels` budgets wheels over a nested scroller,
`UnscrolledWheels` wheels the transcript never scrolls though the latch
takes them for its own, `Pads` the list's end pad, `TurnEnds` the streaming
turn finishing, `Relayouts` a viewport resize. `InitialEnd` mounts at the
tail through the list's initial scroll to the end.

The ghost intent follows what the reader asked for, not what the latch has
heard. No input of the reader's comes while a wheel's scroll is still to
land (the model takes the scroll as the next thing they see), so that scroll
sets the intent: the tail if it reaches the end the wheel headed for (net of
the list moving the last row since), else where it lands. A wheel the
transcript never scrolls, turned up, asks to stay where the reader is, and
turned down while following asks for the tail; a following reader's finger
or scrollbar drag moved toward the end asks for the tail; a finger's lift keeps the intent its
moves set, a press on the scrollbar asks for nothing, and a remount takes a
wheel's scroll still to land with it (the reader asked for what the tile
showed). A
browser clamp (a row below them measured smaller, the end pad's reset)
moves their position with it, from the strict bottom too, since nothing can
keep it. Arrival is judged against the end as laid out when the latch can
see it, at a report or a read (the owner's ruling): a landing on the strict
bottom that a row's growth moves the end on from before any report or read
sees it is no arrival, and the reader asked for no more than where they
are; a request for the end the latch sees met (`"arrive"` marking it
reached) is the tail. The same holds for a finger: a drag onto the end that
an append in the same frame moves past is no arrival anyone can observe
(below).

A matching `NestedScrollEnd` proves an unscrolled wheel went to a nested
scroller: the transcript reported no scroll, and the nested scroller did.
With no increase in distance from the end while that input was in flight,
the ghost restores
its prior intent unless a newer gesture superseded it. If the end moved away,
its provisional away intent stays at the reader's position: the transcript
never moves under an in-flight reader gesture. Without that matching event, AbsorbedWheel remains.

A silent pan's movement is reported before the page can act on it
(`SilentFrame`): a scroll the compositor applies reaches the main thread at
the start of a rendering frame, whose steps run the scroll steps (the
`scroll` event) before the animation frame callbacks, and a task between
frames does not see the new offset yet (HTML, "update the rendering"). So
while a finger on a fling, with no touch event, has a move unreported, only
its report or a further move of that finger steps.

Orders the browser produces only inside one frame are left out, each a
stated constraint on the model and a residue of the code with its price:

- An unscrolled wheel whose own report never comes is AbsorbedWheel even
  after a growth publication consumes its arm. The unconstrained
  `idle_absorbed` 13-state trace stays held when an idle shrink later meets
  it; the latch cannot distinguish it from a wheel still in flight without
  a timer. `ReportBeforeGrowth` constrains that dedicated config to its
  absorbed-report branch, so it isolates the report-since-gesture gate.
- A finger or a scrollbar drag reverses only once its last move has
  reported (`FingerMove`, `DragMove`): a pan or a drag reports every frame,
  and the browser applies the frame's net movement (T2). The price: when a
  frame's net movement was toward the end, the lift catches up from there; a
  drag away and back to the end inside one frame reads as no movement.
- No library or app write lands while a scrollbar drag's movement is
  unreported (`DragFrame`), even after its pointer arm has been consumed.
  The price is T2's in-flight-write residue: the 19-state `drag_idle_fixed`
  trace drags away, reports, returns and follows, then an end command
  overwrites a new drag before its report.
- The end does not decrease onto or below an unreported scrollbar drag's
  offset (`DragFrame`: a pad reset or a shrinking row). Decreases that stay
  above the view remain in scope. This is the clamp+append residue: the
  15-state `drag_pad_fixed` trace's pad reset clamps away a drag before its
  report; the 17-state equality boundary meets it exactly without a write.
  Both read as an unmoved press at the end, so later growth follows.
- A row is not appended between a finger's or a scrollbar drag's movement
  and its report (`AppendRow`). Where it is, a departed reader's drag onto
  the end and the append share a frame, and the report reads the new end. The price: that
  reader stays free with the pill, one unseen row short, one tap from
  following.

Every key-sequence change anchors (`DataAnchored = TRUE` for the timeline):
`prepareMVCP` reads the anchor before `resetLayoutCachesForDataChange`
empties `positions`, and its no-anchor return (no positioned target, nothing
in view with a position, no scroll target's size to compensate) needs an
empty view, which the model's mount has already placed. Only the
position-keyed rules, which read `positions` after the reset, see it empty.

C4, the anchored refresh a following latch read as a departure, is not in
the model as its own failure: an anchored pass here moves the offset by the
change above the anchor, and the next report of a following reader is
corrected to the end; what made the latch take it for the reader leaving is
not modelled.

The turn streams from the start: ordinary rows grow and arrive while it does.
`IdleTailShrink` and `IdleTailRegrow` also change content after `TurnEnd`: it shrinks the last
row so its later `Measure` meets an idle reader exactly, with no offset
change and therefore no scroll event. `idle_gap_fixed` and `noheldgap` both retain that reading position.
`IdleClamp` takes the shrink one unit lower, then `IdleTailRegrow` permits
regrowth after measurement; reports may interleave before the regrowth.
It ends (`TurnEnd`) only at rest, so the last chunk is measured and settled
by then; a turn that ends mid-flight is left out. Then a free reader at the
strict bottom is at the tail. While it streams, a free reader the end comes
to (a row below them measured smaller, the pad's reset) stays where they
were: the owner's rule. The end pad opens at the environment's choice, mid
turn: what makes an adjust overshoot the content is below the model's
sizes.

The phone values were measured in an iOS 27.0 Simulator: 166 to 197
`touchmove` events per pan, at most 34 ms apart, and every write made under
the finger (the list's anchoring `scrollBy` and a restore's `scrollTo`) read
back at once. Momentum after the lift reports scrolls coalesced (some painted
positions get no `scroll` event), which the model's single pending scroll
report already covers. The spec keeps the opposite values as switches: they
were the model's first assumption about the native pan, and iOS 27 does not
behave that way.

Only the phone configurations and bounds explicitly selected in
`expected.py` are part of this CI claim. The independent `liftEnd` ghost
records the content a native fling headed for, including its lift-time end
inset and the live viewport conversion. Tail extension below that content
leaves its target still; content above its final block moves it.
`FlingStep` uses this physical contract independently of production momentum.
A seen `TouchStart` takes intent from current geometry.

`momhybrid` (#3071) records the lift offset and content end once. Every
announced write carries the offset by actual movement; observations only
judge it. The first report after a flagged lift mismatch re-bases the travel
baseline and clears its guard. Browser writes never replay unannounced after
lift: a touch-overridden assignment has no deferred-replay actor. Pending
list commands still use their announced writes and carried targets.

`tailblock` tracks one physical trailing block per row. Capture records
whether it was rendered (`InWindow` is the model's mounted-window abstraction).
Its head check preserves equality and a nonempty captured prefix, rejecting
an empty captured head once text appears. Remount or head invalidity falls
back to the row shift; a missing recorded row means known zero, while a
recorded row whose position cannot be recovered declines arrival. The actual
DOM walk to the deepest boxed descendant is source-inspected rather than
represented as a DOM tree. Stable contiguous row identity omits the source's
same-count re-key fallback mechanics.

`AboveTailGrow` resolves content above the final paragraph without moving the
row's top. `phone_above_tail_fixed_notailblock` retains the row-only early
arrival witness; `phone_read_fixed_nomomhybrid_notailblock` keeps the old
re-recorded target's lost streaming arrival. `Viewports`, `TailRemounts` and
`AppWrites` are finite extra probe budgets, off in ordinary configs. Current
contact/viewport defects remain separate pre-fix probes until their producer
and latch rule lands; they are not new residue exceptions.

`NoOpPicks = FALSE` limits picks to rows whose landing moves the view, which
separates the streaming form of a minimap failure from its no-op form.

The `send*` configs put a send at the tail: the prompt's row, then the
reply's row, each a key-sequence commit the list settles under its anchor
lock, then the reply's tokens; `send_wheel` adds a wheel while it settles,
`send_pick` a pick. `nav_follow_click` clicks a card before a pick lands.

Six configs carry the estimate jump (`Jumps = 1`). `teleport` wheels up off a
streaming end; `teleport_pill` adds the pill; `touch_end` swipes off the end
on a phone, then a new row and tokens arrive, with the touch fixture's
`{data: false}`; `stream_f2` brings a new turn after the jump, then a wheel up
and the reply's tokens; `release_wheel` wheels off the end as a follow
correction settles, in a window starved of frames. `p6b` wheels during an
animated pick while MVCP holds its adjust back. `nested_wheel` wheels over a
nested scroller while a reply streams; `unscrolled_wheel` wheels where the
transcript never scrolls (a descendant cancelled the wheel, or Chrome latched
its sequence to a nested scroller at its edge: one step here). `pad_wheel`
wheels up inside the list's end pad, then the turn ends. `turn_wheel` wheels
up at the end of a streamed reply, its scroll landing after the turn ends;
`turn_held` does the same for a reader the end came up to; `turn_spent`
has that reader's second wheel come before the first one's scroll report
(W1), and `held_down` has a reader the end came up to wheel down, which
scrolls nothing, before the row in view grows (W2). `boot_wheel` wheels
around the initial scroll to the end, then the viewport resizes (B6).
`phone_read_turn` is `phone_read` with the turn's end. `pad_land` checks a
free reader's landed wheel, the end pad's reset and the turn's end. The
`drag_pad` and `drag_idle` configs exercise scrollbar departure, repeated
reports farther away, return drags and end movement. `idle_gap` adds the idle exact-meeting shrink; `idle_clamp` adds a moving
clamp and regrowth. Both hold the reading position under `idlehold`;
`withrawidle` exposes the accepted Mode/Pill price without its exception.
`idle_absorbed` also supplies an absorbed bottom report before the growth
publication and idle shrink. Its `ReportBeforeGrowth` constraint requires
that report before the last row's growth measurement; `withalwaysawait`
omits the report-since-gesture gate. The `nopressland` variants reproduce a press departing without a move,
and `nopressstep` reproduces the reported return drag hidden by its original
press offset.

## Checks

| Invariant               | What the reader sees when it fails                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `I_IntentHeld`          | At rest, the transcript is not where they put it: not at the tail they asked for, not at the row they scrolled to, not at the row they picked |
| `I_SavingLive`          | At rest with the whole transcript loaded, the position is not being saved, so the next reopen goes back to an old one                         |
| `I_SavedIsView`         | Hiding or leaving the chat saved something other than what was on screen                                                                      |
| `I_ModeMatchesGeometry` | Follow is on away from the tail (the next token pulls the view down), or off at the tail (new content does not follow)                        |
| `I_PillHonest`          | The jump-to-latest pill shows at the tail, or is missing away from it                                                                         |
| `I_NoJump`              | The transcript jumps: the line at the top of the view moves with no scroll, pick or follow of theirs                                          |

`I_NoJump` is a step property kept as a flag, like `I_SavedIsView`: the step
that moves the row under the viewport's top edge on screen, while the reader
is not following (the latch keeps them at the tail and nothing has armed a
departure) and no navigation owns the view, sets it. Two steps can: a pass
that replaces estimates above that row without anchoring, and a held adjust
committed from an offset other than the live one.

`I_ModeMatchesGeometry` and `I_PillHonest` allow three states the owner
accepted (`EndCameToFree`), all free at the strict bottom with the pill:
while the turn streams, a reader the end came to who did not ask for the
tail; turn or no turn, a reader whose wheel there the strict bottom
absorbed, its arm still waiting (`AbsorbedWheel`: a blocking wheel arm
whose scroll never moved the view, no wheel scroll pending), until their
next input; and, while the turn streams,
a reader whose silent contact (a finger on a fling, with no touch event)
went away and came back to where they departed with no report seeing it
(`SilentReturn`). That is the R2 residue `"translate"` exposes: at every
observation it is the end come up to a reader who held still, held with the
pill until the turn rests, `"fallen"`'s price. The turn's end then follows
them (`phone_read_turn`). Nothing else at rest allows either.

"At rest" (`Quiescent`) means nothing is in flight: no navigation, correction,
list command, scroll event, pending effect, finger, fling, wheel still to
scroll, end pad, or unmeasured row
on screen.

## Running

TLC needs Java 11+ and the pinned `tla2tools.jar` (gitignored):

```bash
brew install openjdk@17     # or apt-get install openjdk-17-jre-headless
gh release download v1.7.4 -R tlaplus/tlaplus -p tla2tools.jar -D clients/gui-app/formal/tools

clients/gui-app/formal/gen-configs.py          # writes every ChatScroll_<name>.cfg
clients/gui-app/formal/check.sh ChatScroll_nav_follow
clients/gui-app/formal/run-all.sh ChatScroll_nav_follow   # every invariant, one trace each
clients/gui-app/formal/trace.py clients/gui-app/formal/results/ChatScroll_nav_follow.I_IntentHeld.out
clients/gui-app/formal/regress.py ChatScroll_nav_follow    # against expected.py, to its depth
```

The jar's SHA-256 is
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`; the
workflow checks it. `JAVA` names another runtime (an unpacked Temurin 17, say).

`check.sh` runs one config with 2 workers and a 3 GB heap (`TLC_WORKERS`,
`JAVA_XMX`). `run-all.sh` checks all of a config's invariants breadth-first,
saves the first violation's trace, drops that invariant and repeats;
`TLC_TIMEOUT` (default 600s) caps each pass. Edit `gen-configs.py`, not the
`.cfg` files. `results/` and `states/` are gitignored.

`regress.py <Config>` is the regression `formal-regressions.yml` runs, one
job per selected config. `regress.py --list` lists the explicit selection in
`expected.py`, not every exploration config. Each selected behavior is
explored breadth-first to its recorded state-depth bound
(`ChatScrollBounded.tla`). The runner saves each first counterexample,
removes that invariant and checks the rest. It succeeds only when the set of
failing invariants equals the recorded set, so hiding a known failure is
also an error. Trace lengths are evidence; worker scheduling can change the
first witness, so length itself is not an assertion.

The initial bounds were measured locally with four TLC workers; the CI job
has a 20-minute timeout. This is bounded checking, not an unbounded proof.
`TLC_WORKERS` (default 4) and `JAVA_XMX` (default 6g) size the run. Newly
generated exploration configs do not enter CI until their bounds and
expectations have been measured and added explicitly.

Team PRs into main skip the workflow under the repository's normal gate.
A merge to main runs the selected jobs when model or mapped source paths
changed, comparing against this workflow's last green push. The workflow
pins TLC v1.7.4 by checksum, uploads traces, and aggregates the jobs into
`formal regressions`; `trunk-red` retries a failed merge run once.

`trace.py` prints one line per step: the scroll offset over the maximum,
each row as `r<id>@<top>:<size>` (`~n` is the size its next measurement
reads), the controller's mode, the latch's permission and arm, and anything
in flight: `est=` the list's estimate for an unmeasured row once its
type's average has jumped, `pend` the adjust MVCP holds back under an animated
command (and `ls`, the offset the list last saw), and `JUMPED` the step that
broke `I_NoJump`.
