----------------------------- MODULE ChatScroll -----------------------------
(***************************************************************************)
(* One chat transcript tile: its scroll position, bottom-follow, explicit  *)
(* navigation (the turn minimap and the phone's Messages list, the pill)   *)
(* and its saved reading position across hide/show and remount.           *)
(*                                                                         *)
(* Production (gui-app/src):                                               *)
(*   components/chat/chat-timeline-follow-latch.ts   the follow latch      *)
(*   components/chat/chat-timeline.tsx               its maintain calls    *)
(*   components/chat/chat-messages.tsx   ChatMessagesInner: modes, the     *)
(*       navigation and restore loops, persistence gates, visibility       *)
(*   stores/chats/chat-tab-state-cache.ts            the saved state       *)
(*   @legendapp/list 3.3.4 + patch   imperative scroll commands, MVCP      *)
(* Each operator names the function it stands for.                         *)
(*                                                                         *)
(* JavaScript runs one task at a time, so every event handler, timer,      *)
(* animation frame, promise continuation and React commit is one atomic    *)
(* step. The environment (reader, browser, list library, agent stream)     *)
(* picks which pending event runs next; budgets bound the reader and the   *)
(* stream so the state space is finite.                                    *)
(*                                                                         *)
(* Geometry is in whole units (a unit is about one short row). The rows    *)
(* present are the ids lo..hi of 1..R. The list positions rows by its      *)
(* BELIEVED sizes `sz` (EST until a row is measured) and the DOM is laid   *)
(* out from those, so scrollTop, scrollHeight and row tops all use `sz`;   *)
(* `real` is what a measurement would read. The 1px strict-bottom and      *)
(* landing epsilons are below one unit, so both are exact here.            *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, Sequences, TLC

CONSTANTS
    R,                  \* rows in the whole transcript, ids 1..R
    VH,                 \* the scroll node's clientHeight while laid out
    EST,                \* the list's estimate for a row it has not measured
    Heights,            \* "mixed" | "flat": the rows' real heights
    MaxH,               \* the stream grows the last row up to this height
    NAVOFF,             \* CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX, in units
    \* Platform
    HasWheel,           \* desktop: wheel and scrollbar drag
    TouchInput,         \* phone: finger pan, lift, momentum
    TouchMoveDelivered, \* FALSE: a native pan withholds touchmove (not iOS 27)
    HasScrollEnd,       \* FALSE: no `scrollend` event (WebKit)
    DeferUnderFinger,   \* TRUE: a scrollTop write while a finger is down lands
                        \*   after the lift (not iOS 27: it applies at once)
    HideKinds,          \* subset of {"intact", "collapse"}: a retained in-pane
                        \*   chat is visibility:hidden (geometry intact); a
                        \*   top-level pane is display:none (scrollTop reset)
    StartLo,            \* first row present at mount; > 1 is a partial
                        \*   snapshot whose older rows arrive later
    StartMode,          \* "fresh" | "saved-free" | "saved-tail"
    NoOpPicks,          \* FALSE: a minimap or Messages-list pick always names a
                        \*   row whose landing moves the view
    Foreground,         \* TRUE: the renderer produces frames, so a queued scroll
                        \*   event is delivered (next frame) before any timer of
                        \*   100ms or more fires. FALSE: an occluded or background
                        \*   window, where frames stop and timers still run.
    Fixes,              \* subset of {"nav", "toward", "restore", "pill", "cancel",
                        \*   "paint", "supersede", "arrive", "reach", "live",
                        \*   "fling", "evidence", "nested", "fallen", "depart", "keep",
                        \*   "padend", "turnguard"; "turnclear" is rejected},
                        \*   with at most one estimate-hold rule ("hold-init",
                        \*   "hold-all", "hold-mvcp", "hold-release", "hold-end",
                        \*   "hold-boot"): the fixes
                        \*   modelled ({} is the code before them, see README.md)
    REST,               \* the list's estimate for an unmeasured row once its
                        \*   type's average has jumped (more than 2x away from EST)
    DataAnchored,       \* TRUE: MVCP anchors a key-sequence change (the chat
                        \*   timeline's data channel). FALSE: it anchors none
                        \*   ({data: false}, the touch fixture)
    InitialEnd,         \* TRUE: a mount at the tail scrolls there with the
                        \*   list's initial scroll (initialScrollAtEnd), whose
                        \*   end target the list keeps once it has finished
    DeferAdjust,        \* TRUE: MVCP holds its adjust back while an animated
                        \*   command runs, and the list tracks its own
                        \*   `state.scroll` (the offset it last saw)
    \* Budgets
    Grows, Appends, Prepends, Wheels, Drags, Clicks, Touches, Flings, IdleShrinks,
    Minimaps, PhonePicks, Pills, Hides, Remounts, Jumps,
    NestedWheels,       \* wheels over a nested scroller that takes them
    UnscrolledWheels,   \* wheels noted as the transcript's that never scroll it
    IdleClamp,
    Cycles,             \* atomic pad reset/clamp/reopen task
    Pads,               \* the list's one-frame end pad
    TurnEnds,           \* the streaming turn finishing
    Relayouts,          \* a viewport width or height change
    WheelDirs,          \* the ways a wheel may turn
    WheelsApart,        \* each wheel waits for the scroll report before it
    AboveTailGrows, TailRemounts, Viewports, AppWrites, TailHead,
    ReportBeforeGrowth  \* the absorbed-report scenario reports before measured growth

NONE == "none"
Rows == 1..R

RealInit ==
    IF Heights = "mixed"
    THEN [i \in Rows |-> IF i % 3 = 1 THEN 1 ELSE IF i % 3 = 2 THEN 3 ELSE 2]
    ELSE [i \in Rows |-> 2]

Max(a, b) == IF a > b THEN a ELSE b
Min(a, b) == IF a < b THEN a ELSE b
Abs(a) == IF a < 0 THEN -a ELSE a

(***************************************************************************)
(* Records. Each variant shares one field set.                             *)
(***************************************************************************)
\* `wheel`: a gesture armed by a wheel (`departsOnGrowth`). A gesture's `at`
\* and `dist` are its offset and distance from the end where it began
\* (`geometryAtGesture`); `scrolled` (GHOST) says the wheel's own scroll
\* moved the view.
NoArm == [src |-> "none", dir |-> "indeterminate", blocks |-> FALSE, at |-> 0, dist |-> 0,
          wheel |-> FALSE, nested |-> FALSE, scrolled |-> FALSE]
OwnedArm == [src |-> "owned", dir |-> "indeterminate", blocks |-> TRUE, at |-> 0, dist |-> 0,
             wheel |-> FALSE, nested |-> FALSE, scrolled |-> FALSE]
TouchArm(at) == [src |-> "touch", dir |-> "indeterminate", blocks |-> TRUE, at |-> at,
                 dist |-> 0, wheel |-> FALSE, nested |-> FALSE, scrolled |-> FALSE]
NoCorr == [on |-> FALSE, gen |-> 0, rgen |-> 0, att |-> 0, stage |-> "none"]
NoCand == [on |-> FALSE, rgen |-> 0, target |-> 0, arr |-> FALSE, last |-> 0, lastPos |-> 0, blockTop |-> 0, blockGen |-> 0, blockOn |-> FALSE, rowOn |-> FALSE, blockHead |-> "", unreadRowSize |-> -1]
NoMom == [on |-> FALSE, target |-> 0, last |-> 0, lastPos |-> 0, from |-> 0, base |-> 0, blockTop |-> 0, blockGen |-> 0, blockOn |-> FALSE, rowOn |-> FALSE, blockHead |-> "", unreadRowSize |-> -1]
NoLiftEnd == [on |-> FALSE, target |-> 0, last |-> 0, lastPos |-> 0]
NoHeadedEnd == [on |-> FALSE, rgen |-> 0, target |-> 0, last |-> 0, lastPos |-> 0]
NoCmd == [k |-> "none", tok |-> 0, anim |-> FALSE, ph |-> "none", row |-> 0, off |-> 0]
NoFz == [on |-> FALSE, target |-> 0, h |-> 0, v |-> 0, rowPos |-> 0, ver |-> 0, row |-> 0]
NoNav == [k |-> "none", pol |-> NONE, gen |-> 0, ret |-> 0, ph |-> "none",
          row |-> 0, off |-> 0, tok |-> 0, fz |-> NoFz]
NoSnap == [on |-> FALSE, mode |-> "follow", anchor |-> 0, idx |-> 0, off |-> 0]
Snap(mode, anchor, idx, off) ==
    [on |-> TRUE, mode |-> mode, anchor |-> anchor, idx |-> idx, off |-> off]
TailSnap == Snap("follow", 0, 0, 0)
NoPend == [on |-> FALSE, row |-> 0, off |-> 0]
NoGeo == [on |-> FALSE, s |-> 0]
NoView == [on |-> FALSE, s |-> 0, h |-> 0, v |-> 0]
Intent(k, row, off) == [k |-> k, row |-> row, off |-> off]

VARIABLES
    w,          \* the tile, its list, its scroll node, and the two stores
                \*   that outlive a mount (`store`, `reg`)
    intent,     \* GHOST: where the reader last put the transcript
    flags,      \* GHOST: violations an action detected when it ran
    budget,     \* remaining environment events
    last,       \* GHOST: the last action, for reading traces
    led         \* Fixed ("ledger"): where the view would be had only the
                \*   list's and the app's writes and the browser's clamps
                \*   moved it since the last scroll report; -1 from a reader
                \*   gesture until the next report, and before the first

    \* (silent) GHOST: a finger landed on a fling with no touch event, and no
    \*   report has since seen the reader away from where they departed
VARIABLE silent, liftEnd, nestedInput, missedFollow

vars == <<w, intent, flags, budget, last, led, silent, liftEnd, nestedInput, missedFollow>>

(***************************************************************************)
(* Geometry over the list's believed sizes.                                *)
(***************************************************************************)
RECURSIVE SumSz(_, _, _)
SumSz(f, a, b) == IF a > b THEN 0 ELSE f[a] + SumSz(f, a + 1, b)

Pos(x, i) == SumSz(x.sz, x.lo, i - 1)
H(x) == SumSz(x.sz, x.lo, x.hi)
\* `pad`: the list's ScrollAdjust paddingBottom, held for one frame.
MaxS(x) == Max(0, H(x) + x.pad - x.V)
Clamp(x, t) == Max(0, Min(t, MaxS(x)))
Measurable(x) == x.V > 0
AtBottom(x) == Measurable(x) /\ x.s >= MaxS(x)
Present(x, i) == i >= x.lo /\ i <= x.hi
\* The row under the reading line (viewportAnchorRowKey).
AnchorRow(x) ==
    CHOOSE i \in x.lo..x.hi : Pos(x, i) <= x.s /\ (i = x.hi \/ Pos(x, i + 1) > x.s)
\* The rows the list has mounted: the viewport plus a unit of buffer.
InWindow(x, i) == Pos(x, i) < x.s + x.V + 1 /\ Pos(x, i) + x.sz[i] > x.s - 1
View(x) ==
    IF AtBottom(x) THEN [tail |-> TRUE, row |-> 0, off |-> 0]
    ELSE [tail |-> FALSE, row |-> AnchorRow(x), off |-> Pos(x, AnchorRow(x)) - x.s]

\* The list's own `state.scroll`: the offset of its last scroll event or of
\* its own last write (doScrollTo, an MVCP adjust). It lags the scroll node
\* while a scroll report is pending.
ListSaw(x, t) == IF DeferAdjust THEN [x EXCEPT !.ls = t] ELSE x

\* Fixed ("translate"): the offset a reader's departure was published at
\* moves with every write the list or the app makes to the view, by as much,
\* so an anchored adjust cannot make a held reader look returned.
Tr(x, t) == IF "translate" \in Fixes /\ x.depAt # -1 THEN x.depAt + t - Clamp(x, x.s) ELSE x.depAt

\* Physical content: the trailing block may have content before it inside
\* its row. The oracle follows this position even after a DOM remount.
TailBlockTop(x, i) == Pos(x, i) + x.tailOff[i]
EndOffset(x, contentEnd, shift) == Max(0, contentEnd + shift - x.V)
\* Production's tail-block form falls back to the recorded row if the
\* block identity changed. Stable contiguous row identity is the abstraction.
TailHeadHolds(current, captured) ==
    current = captured \/ (Len(captured) > 0 /\ Len(current) >= Len(captured)
                           /\ SubSeq(current, 1, Len(captured)) = captured)
EndShift(x, ref) ==
    IF ~Present(x, ref.last) THEN [known |-> FALSE, shift |-> 0]
    ELSE IF "tailblock" \in Fixes /\ ref.blockOn
            /\ x.tailGen[ref.last] = ref.blockGen
            /\ TailHeadHolds(x.tailHead[ref.last], ref.blockHead)
         THEN [known |-> TRUE, shift |-> TailBlockTop(x, ref.last) - ref.blockTop]
    ELSE IF "unreadsize" \in Fixes /\ ~ref.blockOn
            /\ (IF ~ref.rowOn \/ x.hi # ref.last THEN -1
                 ELSE IF ref.last \in x.known THEN x.sz[ref.last] ELSE -2) # ref.unreadRowSize
         THEN [known |-> FALSE, shift |-> 0]
    ELSE IF ~ref.rowOn THEN [known |-> TRUE, shift |-> 0]
    ELSE IF x.rowKnown[ref.last]
         THEN [known |-> TRUE, shift |-> Pos(x, ref.last) - ref.lastPos]
    ELSE [known |-> FALSE, shift |-> 0]

\* A finger's step is measured net of the list moving the rows with the view
\* (`rowAtStep`, `edgeAtStep`): where a compensation the list makes moves the
\* view, a resting finger has not moved.
\* Fixed ("armcarry"): so does every announced write a waiting gesture's
\* offset (`noteScrollerMoved`): its distance from the end stays.
Carry(x, t) ==
    IF "armcarry" \in Fixes /\ x.armed.src = "gesture"
    THEN LET from == IF "pressstep" \in Fixes /\ x.armed.dir = "indeterminate"
                     THEN Clamp(x, x.s) ELSE x.s
         IN [x.armed EXCEPT !.at = @ + t - from]
    ELSE x.armed
TrArm(x, t) == IF x.armed.src = "touch" THEN [x.armed EXCEPT !.at = @ + t - x.s] ELSE Carry(x, t)

\* "momhybrid": announced movement changes the travel baseline. Its target
\* is separately the lift-time end content, tracked by that content's row.
\* The live resting offset excludes a browser clamp before the write.
TrMom(x, t) ==
    IF "momhybrid" \in Fixes /\ x.mom.on
    THEN [x.mom EXCEPT !.base = @ + t - Clamp(x, x.s)] ELSE x.mom

\* #3085: remembered geometry is translated knowledge, not a snap to live.
ViewAt(x) == [on |-> TRUE, s |-> x.s, h |-> H(x) + x.pad, v |-> x.V]
ViewAfterMove(x, t, range) ==
    IF "viewcarry" \notin Fixes \/ ~x.lastView.on \/ t = x.s THEN x.lastView
    ELSE LET d == t - (IF range THEN x.s ELSE Clamp(x, x.s))
         IN [x.lastView EXCEPT !.s = @ + d,
                 !.h = IF range THEN @ - (MaxS(x) - t) ELSE @ + d]
RangeArm(x, t) == IF "viewcarry" \in Fixes THEN TrArm(x, t) ELSE Carry(x, t)
ViewRead(x) ==
    IF "viewcarry" \notin Fixes \/ ~x.mounted \/ ~Measurable(x) THEN x
    ELSE LET ref == x.lastView
             predicted == Min(ref.s, Max(0, ref.h - x.V))
             absorbs == ref.on /\ x.V > ref.v /\ predicted < ref.s /\ x.s = predicted
             d == IF absorbs THEN predicted - ref.s ELSE 0
             a == IF absorbs THEN RangeArm(x, x.s + d) ELSE x.armed
         IN [x EXCEPT !.lastView = ViewAt(x), !.viewCredit = @ + d,
                      !.armed = a,
                      !.depAt = IF absorbs /\ @ # -1 THEN @ + d ELSE @,
                      !.mom.base = IF absorbs /\ x.mom.on THEN @ + d ELSE @]

\* A scroll the list makes (an MVCP adjust): it cancels a native smooth
\* scroll, and the browser reports it.
Adjust(x, t) ==
    IF t = x.s THEN x
    ELSE ListSaw([x EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1, !.send = HasScrollEnd,
                           !.depAt = Tr(x, t), !.armed = TrArm(x, t), !.mom = TrMom(x, t), !.lastView = ViewAfterMove(x, t, FALSE)], t)

(***************************************************************************)
(* Estimates. A row the list has never measured is laid out at a cached    *)
(* estimate. Once its type's average has jumped (a just-cold turn mounting *)
(* at its remembered height), the patched getItemSize replaces a cached    *)
(* estimate the average proves stale, in whatever pass lays that row out   *)
(* next. A pass that anchors (MVCP's size channel; its data channel where  *)
(* on; a settled re-layout away from the end) moves the offset by the      *)
(* change above the first visible row. One that anchors nothing (a scroll- *)
(* driven pass, `doMVCP: false`; a data pass MVCP does not anchor; the     *)
(* settled re-layout of a scroll that finished at the end) moves nothing.  *)
(***************************************************************************)
Stale(x, i) == Present(x, i) /\ i \notin x.known /\ x.sz[i] # x.est

\* Where the list believes the view is, and whether that is the end
\* (recalculateSettledScroll's `finishedAtEnd`, the hold's view bottom).
ListS(x) == IF DeferAdjust THEN x.ls ELSE x.s
ListAtEnd(x) == Measurable(x) /\ ListS(x) >= MaxS(x)

\* A pass: `mvcp` is doMVCP (rule "hold-all" tests it), `anchored` is a
\* defined checkMVCP, `endReq` the settled re-layout of a scroll that asked
\* for the end (scrollToEnd).
ScrollPass == [kind |-> "scroll", mvcp |-> FALSE, anchored |-> FALSE, endReq |-> FALSE]
SizePass == [kind |-> "size", mvcp |-> TRUE, anchored |-> TRUE, endReq |-> FALSE]
DataPass == [kind |-> "data", mvcp |-> TRUE, anchored |-> DataAnchored, endReq |-> FALSE]
SettledPass(x, endReq) ==
    [kind |-> "settled", mvcp |-> ~ListAtEnd(x), anchored |-> ~ListAtEnd(x), endReq |-> endReq]
\* The settled re-layout of the initial scroll to the end (finishInitialScroll).
InitPass(x) ==
    [kind |-> "init", mvcp |-> ~ListAtEnd(x), anchored |-> ~ListAtEnd(x), endReq |-> TRUE]

\* Whether the pass keeps the cached estimate of an unmeasured row at `top`.
\* "hold-init" (shipped, #3019 round 2): every pass that anchors nothing keeps
\* each row whose top, as that pass lays it out, is above the bottom of the
\* view; estimates refresh in a pass that anchors, and in one that does not:
\* the settled re-layout of the initial scroll to the end, with the live
\* offset at the end too (`refreshEstimatesAtEnd`). Held from the top down,
\* that top is the row's position before the pass. The rules it beat:
\*   "hold-all" is "hold-init" with no release at all (2da05c119);
\*   "hold-mvcp" (c5ab59c54) keeps every row, but only in a pass with
\*     `doMVCP: false`;
\*   "hold-release" (aff940ac5) is "hold-all" released in the settled
\*     re-layout of an end request that the list judges finished at the end;
\*   "hold-end" is released in any pass the list judges at the end;
\*   "hold-boot" is released only in the initial scroll's settled re-layout
\*     at the end, judged from the list's own offset.
\* Those three read the row's previous position (`positions[index]`), which
\* a data change empties first (resetLayoutCachesForDataChange): in a data
\* pass they hold nothing.
HoldsTop(x, p, top) ==
    LET aboveBottom == top < ListS(x) + x.V
        known == aboveBottom /\ p.kind # "data"
    IN CASE "hold-init" \in Fixes ->
                ~p.anchored /\ aboveBottom /\ ~(p.kind = "init" /\ ListAtEnd(x) /\ AtBottom(x))
         [] "hold-all" \in Fixes -> ~p.anchored /\ aboveBottom
         [] "hold-mvcp" \in Fixes -> ~p.mvcp
         [] "hold-release" \in Fixes -> ~p.anchored /\ known /\ ~(p.endReq /\ ListAtEnd(x))
         [] "hold-end" \in Fixes -> ~p.anchored /\ known /\ ~ListAtEnd(x)
         [] "hold-boot" \in Fixes -> ~p.anchored /\ known /\ ~(p.kind = "init" /\ ListAtEnd(x))
         [] OTHER -> FALSE
HoldsRow(x, p, i) == HoldsTop(x, p, Pos(x, i))

\* The reader is following: the latch keeps them at the tail and nothing has
\* armed a departure.
Following(x) == x.perm /\ x.armed.src = "none"

\* A navigation or restore no reader input has superseded owns the view.
NavOwnsView(x) == x.nav.k # "none" /\ x.nav.gen = x.navGen

\* GHOST: the transcript jumped. From x to x2, with no reader input, no
\* navigation owning the view and the reader not following, the row under the
\* viewport's top edge moved on screen.
Jumped(x, x2) ==
    /\ x.mounted /\ x.visible /\ Measurable(x) /\ Measurable(x2)
    /\ ~Following(x) /\ ~NavOwnsView(x)
    /\ LET a == AnchorRow(x)
       IN Present(x2, a) /\ Pos(x2, a) - x2.s # Pos(x, a) - x.s

\* MVCP holds its adjust back while an animated command runs.
Deferring(x) == DeferAdjust /\ x.cmd.k # "none" /\ x.cmd.anim /\ x.cmd.ph = "fly"

\* One pass laying out the rows: it replaces each stale estimate it does not
\* hold, and anchors or not.
ReEstimate(x, p) ==
    LET re == {i \in x.lo..x.hi : Stale(x, i) /\ ~HoldsRow(x, p, i)}
        a == AnchorRow(x)
        dAbove == [i \in Rows |-> IF i \in re /\ i < a THEN x.est - x.sz[i] ELSE 0]
        shift == SumSz(dAbove, x.lo, x.hi)
        x1 == [x EXCEPT !.sz = [i \in Rows |-> IF i \in re THEN x.est ELSE x.sz[i]]]
        x2 == IF ~p.anchored THEN Adjust(x1, Clamp(x1, x.s))
              ELSE IF Deferring(x) THEN [x1 EXCEPT !.pend = @ + shift]
              ELSE Adjust(x1, Clamp(x1, x.s + shift))
    IN IF Jumps = 0 \/ re = {} THEN x
       ELSE [x2 EXCEPT !.jump = @ \/ Jumped(x, x2)]

\* commitPendingAdjust with no target: the cancel of an animated command
\* (cancelPendingScroll), or a new command replacing it (startImperative-
\* Scroll). It writes the held adjust as an absolute offset from the list's
\* `state.scroll`; fixed ("live"), from the scroll node's live offset. From a
\* lagging `state.scroll` the write undoes every scroll the list has not seen.
CommitPending(x) ==
    IF x.pend = 0 THEN x
    ELSE LET base == IF "live" \in Fixes THEN x.s ELSE x.ls
             t == Clamp(x, base + x.pend)
             x1 == [Adjust(x, t) EXCEPT !.pend = 0]
             \* Where the held adjust puts the view from where it is.
             right == Clamp(x, x.s + x.pend)
         IN [x1 EXCEPT !.jump = @ \/ Jumped([x1 EXCEPT !.s = right], x1)]

(***************************************************************************)
(* The scroll node. A programmatic write cancels a native smooth scroll    *)
(* and ends in `scrollend`. A contact may override a write, never replay it.*)
(***************************************************************************)
Write(x, t) ==
    IF DeferUnderFinger /\ x.finger
    THEN [x EXCEPT !.touchWriteMayLand = @ \/ (x.armed.src = "touch" /\ t # x.s)]
    ELSE IF t = x.s THEN [x EXCEPT !.smooth = -1]
    ELSE [x EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1, !.send = HasScrollEnd,
                   !.depAt = Tr(x, t), !.armed = Carry(x, t), !.mom = TrMom(x, t), !.lastView = ViewAfterMove(x, t, FALSE)]

(***************************************************************************)
(* Promises. A LegendList command's promise is named by its token. It      *)
(* resolves when the command finishes or a newer imperative call settles   *)
(* it (startImperativeScroll). The continuations that only clear a ref run *)
(* at resolution: the latch's clearPendingScroll, and the restore loop's   *)
(* awaitChatTimelineScrollPromiseSettle leaving "await".                   *)
(***************************************************************************)
\* Fixed, the free loop waits on its command's promise as the restore loop
\* does (awaitChatTimelineScrollPromiseSettle), not on `scrollend`.
\* A trailing free navigation completes when its last command's promise
\* settles, and a reader gesture reconciles at the bottom (both defined with
\* the latch below).
RECURSIVE CompleteOwnedFree(_), ReconcileStrictBottom(_, _, _), ReconcileAt(_, _, _, _)

PromiseSettled(x) == x.nav.k = "restore" \/ (x.nav.k = "free" /\ "nav" \in Fixes)

Resolve(x, tok) ==
    IF tok = 0 THEN x
    ELSE LET x1 == IF x.pendEnd = tok THEN [x EXCEPT !.pendEnd = 0] ELSE x
         IN IF PromiseSettled(x1) /\ x1.nav.ph = "await" /\ x1.nav.tok = tok
            THEN [x1 EXCEPT !.nav.ph = "q1"]
            ELSE IF x1.nav.ph = "trail" /\ x1.nav.tok = tok
            \* finishTrailing: a reader input since has superseded it.
            THEN IF x1.nav.gen = x1.navGen THEN CompleteOwnedFree([x1 EXCEPT !.nav = NoNav])
                 ELSE [x1 EXCEPT !.nav = NoNav]
            ELSE x1

(***************************************************************************)
(* LegendList's imperative handle (createImperativeHandle, scrollTo,       *)
(* doScrollTo). scrollToOffset / scrollToIndex run in the same task unless *)
(* the list is settling after a data change (runWhenReady: two still       *)
(* frames, or 800ms); scrollToEnd runs at the next commit. The target is   *)
(* computed when the command RUNS, from the believed sizes then, and an    *)
(* animated scroll is never retargeted in flight.                          *)
(***************************************************************************)
LibTarget(x) ==
    CASE x.cmd.k = "end"    -> MaxS(x)
      [] x.cmd.k = "offset" -> Clamp(x, x.cmd.off)
      [] OTHER              -> Clamp(x, Pos(x, x.cmd.row) - x.cmd.off)

LibRun(x) ==
    LET t == LibTarget(x) IN
    IF x.cmd.anim /\ t # x.s
    THEN [x EXCEPT !.cmd.ph = "fly", !.smooth = t]
    ELSE [ListSaw(Write(x, t), t) EXCEPT !.cmd.ph = "fin"]

\* startImperativeScroll first commits the adjust the command it replaces
\* held back while animating (the list patch).
LibCall(x, kind, row, off, anim) ==
    LET t == x.tok + 1
        x0 == IF x.cmd.k # "none" THEN CommitPending(x) ELSE x
        x1 == Resolve([x0 EXCEPT !.tok = t], x.cmd.tok)
        x2 == [x1 EXCEPT !.cmd = [k |-> kind, tok |-> t, anim |-> anim,
                                  ph |-> "wait", row |-> row, off |-> off]]
    IN IF kind # "end" /\ ~x2.settling /\ Measurable(x2) THEN LibRun(x2) ELSE x2

(***************************************************************************)
(* The follow latch (useChatTimelineFollowLatch).                          *)
(***************************************************************************)
CancelCorr(x) == [x EXCEPT !.corr = NoCorr]

\* isFollowCorrectionSuppressed: the saved restore has not validated, or a
\* clamped saved anchor waits for hydration.
CorrSuppressed(x) == x.gate \/ x.pendHyd # 0

\* isReattachSuppressed: a key-sequence commit whose layout has not settled.
ReattachSuppressed(x) == x.structUnsettled

CanMove(x, dir) ==
    CASE dir = "indeterminate" -> TRUE
      [] dir = "away-from-end" -> x.s > 0
      [] OTHER                 -> MaxS(x) - x.s > 0

\* A scrollToEnd runs only through the list's runner.
Runs(x) == x.cmd.k # "end" \/ x.runner

DepartsOnGrowth(a) ==
    a.src = "gesture" /\ a.blocks /\ a.wheel /\ a.dir = "away-from-end"

ArmBlocks(a) ==
    IF a.src = "none" THEN FALSE ELSE IF a.src = "gesture" THEN a.blocks ELSE TRUE

\* supersedePendingEndCorrection. Before the fix it issues scrollToOffset at
\* the offset read in the gesture's handler; the list defers that command
\* while it settles and later writes the stale offset. Fixed, it cancels the
\* queued command and writes nothing. A pending end correction is always the
\* list's current command: any newer call resolves it.
\* The list patch's cancelPendingScroll: it retires the command the list holds
\* (settling its promise) and commits a held adjust. Before the fix ("keep")
\* it also drops the runner every later scrollToEnd waits on
\* (`runPendingScrollToEnd`), so the next end command is never run (P8).
CancelPendingScroll(x) ==
    IF x.cmd.k = "none" THEN x
    ELSE LET x1 == [Resolve([x EXCEPT !.tok = @ + 1], x.cmd.tok) EXCEPT !.cmd = NoCmd]
         IN [x1 EXCEPT !.runner = @ /\ "keep" \in Fixes]

SupersedeEnd(x, offset) ==
    IF x.pendEnd = 0 THEN x
    ELSE IF "supersede" \in Fixes
    THEN CancelPendingScroll([x EXCEPT !.pendEnd = 0])
    ELSE LibCall([x EXCEPT !.pendEnd = 0], "offset", 0, offset, FALSE)

ClearHydration(x) == [x EXCEPT !.pendHyd = 0, !.reg = NoSnap]

\* isDemonstrablyPastIssuedFreeRestoreTarget against the frozen issue.
PastFrozen(x, fz) ==
    /\ fz.on
    /\ fz.ver = x.rowsVer
    /\ fz.h = H(x)
    /\ fz.v = x.V
    /\ Present(x, fz.row)
    /\ fz.rowPos = Pos(x, fz.row)
    /\ x.s > fz.target

\* resolveSuppressedEndLanding -> [w, r]
\* Fixed ("restore"): with every row loaded, a strict bottom the frozen target
\* does not prove the reader past is the restore's own landing on estimates;
\* the restore keeps converging and releases the gate itself.
ResolveSuppressedEndLanding(x) ==
    IF ~x.pendMeas.on \/ ~x.resolveEnd.on THEN [w |-> x, r |-> FALSE]
    ELSE LET fz == x.resolveEnd
             past == PastFrozen(x, fz)
         IN IF "restore" \in Fixes /\ ~past /\ x.pendHyd = 0 THEN [w |-> x, r |-> FALSE]
            ELSE LET x1 == [x EXCEPT !.nav = NoNav, !.resolveEnd = NoFz]
                     x2 == IF past THEN [ClearHydration(x1) EXCEPT !.gate = FALSE] ELSE x1
                 IN [w |-> [x2 EXCEPT !.pendMeas = NoPend], r |-> past]

\* Cancelling the loop in flight to start another (activeNavigationSettle-
\* CleanupRef). Fixed ("restore"): the mount restore's frozen end-landing
\* target goes with its loop.
EndLoop(x) ==
    LET ownsTarget == "restore" \in Fixes /\ x.nav.k = "restore" /\ x.nav.pol = "mount"
    IN [x EXCEPT !.nav = NoNav,
                 !.resolveEnd = IF ownsTarget THEN NoFz ELSE @,
                 !.pendMeas = IF ownsTarget THEN NoPend ELSE @]

(***************************************************************************)
(* The latch's setFollowIntent and the controller's mode mirror call each  *)
(* other: setFollowIntent -> onFollowIntentChange -> setTimelineMode ->    *)
(* setFollowIntent. The recursion ends because each level first writes     *)
(* the permission it then compares.                                        *)
(***************************************************************************)
\* #3086: settled detaches eagerly take an owed position; reads wait for restore.
TakeOwed(x) ==
    IF "oweddep" \in Fixes /\ x.depOwed /\ Measurable(x) /\ ~AtBottom(x)
    THEN [x EXCEPT !.depAt = x.s, !.depOwed = FALSE] ELSE x
OweAtView(x) ==
    IF "oweddep" \in Fixes /\ ~x.perm THEN TakeOwed([x EXCEPT !.depOwed = TRUE]) ELSE x
NoteOwed(x) == IF CorrSuppressed(x) THEN x ELSE TakeOwed(x)
PublishAt(x) ==
    IF "oweddep" \in Fixes /\ "fallen" \in Fixes
    THEN [x EXCEPT !.depAt = x.s, !.depMoved = FALSE] ELSE x

RECURSIVE LatchSetIntent(_, _), OnIntentChange(_, _), SetTimelineMode(_, _, _),
          SetFollowingEndFromPosition(_)

\* setFollowIntent. `depAt` is the offset the reader left the tail at.
LatchSetIntent(x, b) ==
    LET x1 == IF ~b THEN CancelCorr(x) ELSE x IN
    IF x1.perm = b THEN x1
    ELSE OnIntentChange([x1 EXCEPT !.armed = IF x1.armed.src = "touch" THEN @ ELSE NoArm,
                                   !.perm = b,
                                   !.depAt = IF b \/ "fallen" \notin Fixes THEN -1
                                            ELSE IF "oweddep" \in Fixes THEN @ ELSE x1.s,
                                   !.depOwed = IF b THEN FALSE ELSE @,
                                   !.depMoved = FALSE, !.depAhead = FALSE, !.depWheel = FALSE], b)

\* onFollowIntentChange
OnIntentChange(x, b) ==
    IF x.atEnd = b /\ ((x.mode = "follow") = b) THEN x
    ELSE IF b THEN SetFollowingEndFromPosition(x)
    ELSE [SetTimelineMode(x, "free", TRUE) EXCEPT !.pill = TRUE]

\* setTimelineMode
SetTimelineMode(x, next, release) ==
    LET x1 == OweAtView(LatchSetIntent(x, next = "follow"))
        x2 == [x1 EXCEPT !.mode = next, !.atEnd = (next = "follow")]
    IN IF next = "follow"
       THEN [x2 EXCEPT !.gate = IF release THEN FALSE ELSE @,
                       !.pendMeas = IF x2.pendHyd = 0 THEN NoPend ELSE @,
                       !.pill = FALSE]
       ELSE x2

\* setFollowingEndFromTimelinePosition
SetFollowingEndFromPosition(x) ==
    LET x1 == IF x.pendHyd # 0 THEN ResolveSuppressedEndLanding(x).w ELSE x IN
    IF x1.pendHyd # 0 THEN [SetTimelineMode(x1, "free", FALSE) EXCEPT !.pill = TRUE]
    ELSE SetTimelineMode(x1, "follow", TRUE)

(***************************************************************************)
(* End corrections (startEndCorrection: one issue now, then reissues after *)
(* two frames, five attempts).                                             *)
(***************************************************************************)
CorrCurrent(x) == x.corr.on /\ x.corr.gen = x.cgen /\ x.perm /\ x.rgen = x.corr.rgen

\* Fixed ("paint"): the correction sets the end itself first, before the frame
\* paints, then issues the list's command, which lands where the view already
\* is once the list runs it.
CorrIssue(x) ==
    IF ~CorrCurrent(x) THEN x
    ELSE IF x.corr.att >= 5 THEN CancelCorr(x)
    \* Fixed ("padend"): while the list pads its end for a frame, that write
    \* goes to the list's own end, not into the pad.
    ELSE LET x0 == IF "paint" \in Fixes
                   THEN Write(x, IF "padend" \in Fixes THEN Max(0, H(x) - x.V) ELSE MaxS(x))
                   ELSE x
             x1 == LibCall([x0 EXCEPT !.corr.att = @ + 1], "end", 0, 0, FALSE)
         IN [x1 EXCEPT !.pendEnd = x1.tok, !.corr.stage = "f1"]

NewCorr(x) ==
    LET g == x.cgen + 1
    IN [x EXCEPT !.cgen = g, !.corr = [on |-> TRUE, gen |-> g, rgen |-> x.rgen,
                                       att |-> 0, stage |-> "none"]]

StartEndCorrection(x) == CorrIssue(NewCorr(x))

(***************************************************************************)
(* The controller's reader-gesture handler (handleTimelineReaderGesture).  *)
(***************************************************************************)
\* Fixed ("restore"): a restore loop yields to a published reader position and
\* to the loop that replaces it, never to a bare pointer preflight. A click
\* says nothing about where the reader wants to be, and the restore is the
\* only release of its gate.
HandleReaderGesture(x, freeze, publishes, answers) ==
    LET hadAnim == x.animOp
        retires == publishes /\ ("restoreanswer" \notin Fixes \/ answers)
        keepsRestore == "restore" \in Fixes /\ ~retires /\ x.nav.k = "restore"
        x1 == [x EXCEPT !.animOp = FALSE, !.navGen = IF keepsRestore THEN @ ELSE @ + 1,
                        !.pendMeas = IF retires \/ (x.pendHyd = 0 /\ "restore" \notin Fixes)
                                     THEN NoPend ELSE @]
        x2 == IF retires THEN [ClearHydration(x1) EXCEPT !.gate = FALSE] ELSE x1
        \* Fixed ("cancel"): the restore or navigation this input ends may
        \* still have a command queued in the list, its own or the latch's
        \* supersede write just before this handler; it is retired, unrun.
        \* The cancel also commits the adjust an animated command held back,
        \* before the freeze below reads the offset.
        cancels == "cancel" \in Fixes /\ publishes /\ x2.nav.k # "none"
        x3 == IF cancels /\ x2.cmd.k # "none" /\ x2.cmd.ph = "wait"
              THEN CancelPendingScroll(x2)
              ELSE IF cancels /\ x2.cmd.k # "none"
              THEN [CommitPending(x2) EXCEPT !.runner = @ /\ "keep" \in Fixes]
              ELSE IF cancels THEN CommitPending(x2)
              ELSE x2
    IN IF freeze /\ hadAnim THEN LibCall(x3, "offset", 0, x3.s, FALSE) ELSE x3

\* noteReaderGesture
NoteReaderGesture(x, dir, freeze, publishes) ==
    \* A gesture toward the end forgets where the reader departed: a strict
    \* bottom they reach after it is theirs, which "fallen" no longer holds.
    LET x1 == CancelCorr([x EXCEPT !.rgen = @ + 1, !.mom = NoMom,
                                   !.depAt = IF dir = "toward-end" THEN -1 ELSE @,
                                   !.depOwed = IF dir = "toward-end" THEN FALSE ELSE @])
        meas == Measurable(x1)
        blocks == ~meas \/ CanMove(x1, dir)
        \* Fixed ("toward"): a following reader moving toward the end cannot
        \* be leaving it, whatever the geometry did before its report arrives:
        \* it arms no departure (and replaces one armed before it), and leaves
        \* a queued end command to land.
        cont == "toward" \in Fixes /\ x1.perm /\ dir = "toward-end"
                /\ x1.armed.src # "touch"
        arm == IF x1.armed.src = "touch" THEN x1.armed
               ELSE IF publishes /\ ~cont
                    THEN [src |-> "gesture", dir |-> dir, blocks |-> blocks, at |-> x1.s,
                          dist |-> MaxS(x1) - x1.s, wheel |-> FALSE, nested |-> FALSE, scrolled |-> FALSE]
                    ELSE NoArm
        cand == IF dir = "toward-end" /\ arm.src # "touch" /\ meas
                THEN [on |-> TRUE, rgen |-> x1.rgen, target |-> IF "momhybrid" \in Fixes THEN H(x1) + x1.pad ELSE MaxS(x1), arr |-> FALSE,
                      last |-> x1.hi, lastPos |-> Pos(x1, x1.hi),
                      blockTop |-> TailBlockTop(x1, x1.hi), blockGen |-> x1.tailGen[x1.hi],
                      blockOn |-> InWindow(x1, x1.hi), rowOn |-> x1.rowKnown[x1.hi],
                      blockHead |-> x1.tailHead[x1.hi],
                      unreadRowSize |-> IF InWindow(x1, x1.hi) \/ ~x1.rowKnown[x1.hi] THEN -1 ELSE IF x1.hi \in x1.known THEN x1.sz[x1.hi] ELSE -2]
                ELSE NoCand
        headed == IF dir = "toward-end" /\ arm.src # "touch" /\ meas
                  THEN [on |-> TRUE, rgen |-> x1.rgen, target |-> H(x1) + x1.pad,
                        last |-> x1.hi, lastPos |-> TailBlockTop(x1, x1.hi)] ELSE NoHeadedEnd
        x2 == [x1 EXCEPT !.armed = arm, !.cand = cand, !.headedEnd = headed]
        x3 == IF publishes /\ blocks /\ meas /\ ~cont THEN SupersedeEnd(x2, x2.s) ELSE x2
    IN HandleReaderGesture(x3, freeze, publishes, blocks)

(***************************************************************************)
(* reconcileStrictBottom, tryReattachReader, publishArmedDeparture,        *)
(* observeLiveGeometry (every scroll report), followEndIfPermitted (every  *)
(* maintain trigger).                                                      *)
(***************************************************************************)
\* A free navigation in flight that no reader input has superseded.
OwnsNav(x) == x.nav.k = "free" /\ x.nav.gen = x.navGen

\* Fixed ("arrive"): a strict bottom the list holds off reattaching, reached
\* under the reader's own request for the end, keeps that request, marked
\* as reached.
Arrived(x) ==
    IF "arrive" \in Fixes /\ x.cand.on /\ x.cand.rgen = x.rgen
    THEN [x.cand EXCEPT !.arr = TRUE] ELSE NoCand

ReconcileStrictBottom(x, native, top) == ReconcileAt(x, native, top, FALSE)

\* Fixed ("followguard"): a follow the latch starts itself leaves a free
\* reader free while a blocking gesture arm of theirs not headed for the end
\* still waits for its scroll: following them would retire it.
FollowGuarded(x) ==
    /\ "followguard" \in Fixes /\ ~x.perm
    /\ x.armed.src = "gesture" /\ x.armed.blocks /\ x.armed.dir # "toward-end"

\* The row form re-recorded the end and step at each observation. Hybrid
\* keeps the lift's target content and announced-write travel baseline.
\* An unknown content shift declines arrival; observations never re-base.
MomAt(x) == [on |-> TRUE,
             target |-> IF "momhybrid" \in Fixes THEN H(x) + x.pad ELSE MaxS(x),
             last |-> x.hi, lastPos |-> Pos(x, x.hi), from |-> x.s, base |-> x.s,
             blockTop |-> TailBlockTop(x, x.hi), blockGen |-> x.tailGen[x.hi],
             blockOn |-> InWindow(x, x.hi), rowOn |-> x.rowKnown[x.hi],
             blockHead |-> x.tailHead[x.hi],
             unreadRowSize |-> IF InWindow(x, x.hi) \/ ~x.rowKnown[x.hi] THEN -1 ELSE IF x.hi \in x.known THEN x.sz[x.hi] ELSE -2]
MomArrived(x) ==
    LET m == x.mom
        shift == EndShift(x, m)
        target == IF "momhybrid" \in Fixes
                  THEN EndOffset(x, m.target, shift.shift) ELSE m.target + shift.shift
        base == IF "momhybrid" \in Fixes THEN m.base ELSE m.from + shift.shift
    IN /\ m.on /\ ~CorrSuppressed(x) /\ ~ReattachSuppressed(x)
       /\ shift.known /\ ("momhybrid" \in Fixes => ~x.liftLanding)
       /\ x.s >= target
       /\ "momstill" \in Fixes => x.s > base
MomNoted(x) ==
    IF "unreadsize" \in Fixes /\ x.mom.on /\ ~CorrSuppressed(x)
       /\ ~ReattachSuppressed(x) /\ ~x.liftLanding /\ ~EndShift(x, x.mom).known
    THEN [x EXCEPT !.mom = NoMom]
    ELSE IF ~x.mom.on \/ "momhybrid" \in Fixes \/ CorrSuppressed(x) \/ ReattachSuppressed(x)
    THEN x
    ELSE LET m == x.mom
             observed == EndShift(x, m)
             base == IF observed.known THEN m.from + observed.shift ELSE x.s
         IN [x EXCEPT !.mom = [MomAt(x) EXCEPT !.from = base]]
MomFollow(x) == StartEndCorrection(LatchSetIntent([x EXCEPT !.mom = NoMom], TRUE))

\* `landing`: an owned navigation's completed landing, the reader's own and
\* never a recovering list's clamp.
ReconcileAt(x, native, top, landing) ==
    LET x1 == [CancelCorr(x) EXCEPT !.cand = NoCand]
        ad == x1.armed
        touchArrival == ad.src = "touch" /\ native
        x2 == IF touchArrival THEN [x1 EXCEPT !.armed = TouchArm(top)] ELSE x1
    \* Fixed ("nav"): while a free navigation owns the view - its arm may
    \* already be spent on a report that arrived late - its completion
    \* reconciles the geometry it lands on.
    IN IF "nav" \in Fixes /\ ~landing /\ (ad.src = "owned" \/ OwnsNav(x)) THEN x2
       ELSE IF ~touchArrival /\ ~landing /\ ~x2.perm /\ ReattachSuppressed(x2)
            THEN [x2 EXCEPT !.cand = Arrived(x)]
       \* Fixed ("fallen"): while the turn streams, a strict bottom at or under
       \* the offset a reader left the tail at is the end come up to them: they
       \* stay free, re-based there. Above it, they went there and follow.
       ELSE IF /\ "fallen" \in Fixes /\ (x.turn \/ "idlehold" \in Fixes) /\ ~x2.perm /\ ~landing
               /\ x2.depAt # -1 /\ x2.s <= x2.depAt
            THEN [x2 EXCEPT !.depAt = x2.s]
       \* A gesture that cannot move releases its arm here. Before the fix
       \* ("evidence") so does a movable one, on any scroll report, though
       \* that report may come before the gesture's own scroll (a smooth
       \* wheel scroll lands frames after its handler). Fixed, the report
       \* must show the gesture's own movement: up from where it began,
       \* farther from the end, within the strict bottom's epsilon. That is
       \* less than the model's unit, so here no strict-bottom report does.
       ELSE LET x3 == IF ad.src = "gesture" /\ (~ad.blocks \/ (native /\ "evidence" \notin Fixes))
                      THEN [x2 EXCEPT !.armed = NoArm] ELSE x2
                supp == CorrSuppressed(x3)
                res == IF supp THEN ResolveSuppressedEndLanding(x3) ELSE [w |-> x3, r |-> FALSE]
            IN IF FollowGuarded(x3) /\ ~landing THEN x3
               ELSE OweAtView(LatchSetIntent(res.w, ~supp \/ res.r))

\* Fixed ("reach"): the end the gesture headed for is the content that ended
\* the transcript then, so it moves down with every row that grows above that
\* last row. The list compensates such growth by moving the offset, which
\* alone cannot reach it now.
TryReattach(x) ==
    LET c == x.cand
        observed == EndShift(x, c)
        shift == IF "reach" \in Fixes THEN observed.shift ELSE 0
        target == IF "momhybrid" \in Fixes
                  THEN EndOffset(x, c.target, shift) ELSE c.target + shift
        reached == c.on /\ c.rgen = x.rgen /\ x.s >= target
                   /\ ("reach" \in Fixes => observed.known)
    IN IF "unreadsize" \in Fixes /\ c.on /\ c.rgen = x.rgen /\ ~observed.known
       THEN [w |-> [x EXCEPT !.cand = NoCand], r |-> FALSE]
       ELSE IF ~reached \/ CorrSuppressed(x) THEN [w |-> x, r |-> FALSE]
       ELSE [w |-> StartEndCorrection(LatchSetIntent([x EXCEPT !.cand = NoCand], TRUE)),
             r |-> TRUE]

ReadCandidate(x) ==
    LET c == x.cand
        shift == EndShift(x, c)
        met == c.on /\ c.rgen = x.rgen /\ shift.known
               /\ x.s >= (IF "momhybrid" \in Fixes
                          THEN EndOffset(x, c.target, shift.shift)
                          ELSE c.target + shift.shift)
    IN IF "viewcarry" \notin Fixes THEN [w |-> x, r |-> FALSE]
       ELSE IF "unreadsize" \in Fixes /\ c.on /\ c.rgen = x.rgen /\ ~shift.known
            THEN [w |-> [x EXCEPT !.cand = NoCand], r |-> FALSE]
       ELSE IF ~met THEN [w |-> x, r |-> FALSE]
       ELSE IF ~x.perm /\ ReattachSuppressed(x)
            THEN [w |-> [x EXCEPT !.cand = Arrived(x)], r |-> FALSE]
       ELSE TryReattach(x)

\* GHOST: the content endpoint headed for, independent of either production
\* target representation and independent of DOM block identity/fallback.
\* A production candidate becoming unreadable never retires this oracle.
ReachedHeadedEnd(x) ==
    LET c == x.headedEnd
        shift == IF Present(x, c.last) THEN TailBlockTop(x, c.last) - c.lastPos ELSE 0
    IN c.on /\ c.rgen = x.rgen /\ x.s >= EndOffset(x, c.target, shift)

PublishArmedDeparture(x, a) ==
    CASE a.src = "touch" ->
            IF x.s = a.at THEN [w |-> x, r |-> FALSE]
            \* A following reader's finger is decided a step at a time: a step
            \* toward the end never departs, and the next is measured from here.
            ELSE IF x.perm /\ x.s > a.at THEN [w |-> [x EXCEPT !.armed = TouchArm(x.s)], r |-> FALSE]
            ELSE [w |-> HandleReaderGesture(PublishAt(SupersedeEnd(x, x.s)), TRUE, TRUE, TRUE), r |-> TRUE]
      [] a.src = "gesture" -> [w |-> PublishAt(SupersedeEnd(x, x.s)), r |-> TRUE]
      [] OTHER -> [w |-> x, r |-> TRUE]

\* Fixed ("ledger"): every write of the list's and the app's is announced as
\* it lands, so a following reader's report above where those writes and
\* the browser's clamps leave the view is the reader's own movement, with no
\* arm and no owned navigation to say so: their departure, published as a
\* delivered touchmove would be.
ReadLedger(x) ==
    IF led = -1 \/ x.rgen # w.rgen THEN -1
    ELSE led + x.viewCredit - w.viewCredit
Unexplained(x) ==
    /\ "ledger" \in Fixes /\ x.perm /\ x.armed.src = "none" /\ ~OwnsNav(x)
    /\ ReadLedger(x) # -1 /\ w.s < Min(ReadLedger(x), MaxS(x))

\* noteReportAfterDeparture: a moved report used to forget the departure.
\* Fixed ("deprebase"): a report off the strict bottom carries the reader's
\* held position either way. The end later coming to that position is not
\* their arrival. A strict-bottom report is still judged against the prior
\* departure: at or under it mid-turn, the end came to them; above it, they
\* arrived, and the hold ends before strict-bottom reconciliation follows.
ReportAfterDeparture(x) ==
    IF x.depAt = -1 THEN NoteOwed(x)
    ELSE IF ((x.turn \/ "idlehold" \in Fixes) /\ AtBottom(x) /\ x.s <= x.depAt) THEN x
    \* An arrival forgets the held position even when reattach is suppressed.
    ELSE IF "deprebase" \in Fixes /\ AtBottom(x)
         THEN [x EXCEPT !.depAt = -1, !.depMoved = FALSE]
    ELSE IF "deprebase" \in Fixes /\ x.s # x.depAt
         THEN [x EXCEPT !.depAt = x.s, !.depMoved = TRUE, !.depAhead = FALSE]
    ELSE IF x.s # x.depAt THEN [x EXCEPT !.depAt = -1, !.depMoved = FALSE]
    ELSE x

\* gestureScrollLanded: the view is up from where the gesture began (its
\* offset carried by announced writes, "armcarry"), and, on the strict
\* bottom, where a clamp lowers the offset with the end, farther from the
\* end. Off the end a clamp never lands the view.
GestureLanded(x) ==
    /\ x.armed.src = "gesture" /\ x.s < x.armed.at
    /\ ~AtBottom(x) \/ MaxS(x) - x.s > x.armed.dist
\* Fixed ("pressland"): a pointer press that has not moved the view (the
\* end moved under it) is no departure.
PressUnlanded(x) ==
    /\ "pressland" \in Fixes /\ x.armed.src = "gesture" /\ x.armed.dir = "indeterminate"
    /\ ~GestureLanded(x)

\* Fixed ("pressstep"): both report and maintenance observations measure
\* a press one step at a time. Toward-end travel re-bases at the view;
\* if the end drops under the carried reference, it re-bases at that end
\* and no lower. The later step away is judged from this geometry.
NotePressView(x) ==
    IF "pressstep" \notin Fixes \/ x.armed.src # "gesture"
       \/ x.armed.dir # "indeterminate" THEN x
    ELSE IF x.s > x.armed.at
         THEN [x EXCEPT !.armed.at = x.s, !.armed.dist = MaxS(x) - x.s]
    ELSE IF x.armed.at > MaxS(x)
         THEN [x EXCEPT !.armed.at = MaxS(x), !.armed.dist = 0]
    ELSE x

\* A maintenance or correction read sees movement whose scroll report is
\* still owed. Its publication waits for that report, unlike a report's own.
PublishReadDeparture(x) ==
    [LatchSetIntent(HandleReaderGesture(PublishAt(SupersedeEnd(x, x.s)), TRUE, TRUE, TRUE), FALSE)
     EXCEPT !.depAhead = TRUE, !.depWheel = FALSE]

ReportAfterLiftLanding(x) ==
    IF ~x.liftLanding THEN x
    ELSE [x EXCEPT !.liftLanding = FALSE,
                   !.depAt = IF @ # -1 THEN x.s ELSE @,
                   !.mom.base = IF "momhybrid" \in Fixes /\ x.mom.on THEN x.s ELSE @]

ObserveLiveGeometry(x0) ==
    LET reported == ReportAfterLiftLanding([ViewRead(x0) EXCEPT !.depAhead = FALSE, !.depWheel = FALSE]) IN
    IF ~reported.mounted \/ ~Measurable(reported) THEN reported
    \* #3062's report returns before press/momentum reconciliation when the
    \* streaming end met the held reader. The report still ends its await.
    ELSE IF /\ "deprebase" \in Fixes /\ "fallen" \in Fixes
            /\ (reported.turn \/ "idlehold" \in Fixes) /\ ~reported.perm /\ reported.depAt # -1
            /\ AtBottom(reported) /\ reported.s <= reported.depAt
         THEN [CancelCorr(reported) EXCEPT !.depAt = reported.s]
    ELSE LET arrived == MomArrived(reported)
             x == NotePressView(ReportAfterDeparture(MomNoted(reported))) IN
    IF AtBottom(x) THEN ReconcileStrictBottom(x, TRUE, x.s)
    \* Ahead of a correction in flight: its writes only move toward the end.
    ELSE IF Unexplained(x)
         THEN LatchSetIntent(HandleReaderGesture(PublishAt(SupersedeEnd(x, x.s)), TRUE, TRUE, TRUE), FALSE)
    ELSE IF x.corr.on /\ x.corr.rgen = x.rgen THEN x
    ELSE LET ra == TryReattach(x)
             after == ra.w IN
         IF ra.r THEN after
         ELSE IF arrived /\ ~after.perm /\ ~CorrSuppressed(after) THEN MomFollow(after)
         \* Fixed ("restore"): a free reader's finger that moved the view is the
         \* reader's position too; published once, while a restore still holds
         \* the saved coordinate (iOS delivers no touchmove to publish it).
         ELSE IF ~after.perm
         THEN IF /\ "restore" \in Fixes /\ after.armed.src = "touch"
                 /\ after.s # after.armed.at /\ CorrSuppressed(after)
              THEN PublishArmedDeparture(after, after.armed).w
              \* Fixed ("freeland"): a free reader's report that shows their
              \* gesture's scroll landed retires its arm, so a later arrival
              \* at the strict bottom is theirs to follow from.
              ELSE IF /\ "freeland" \in Fixes /\ after.armed.blocks
                      /\ after.armed.dir = "away-from-end" /\ GestureLanded(after)
                   \* Fixed ("freelanddep"): that report is the reader
                   \* departing again, from where it landed.
                   THEN [after EXCEPT !.armed = NoArm,
                                  !.depAt = IF "freelanddep" \in Fixes THEN after.s ELSE @,
                                  !.depMoved = IF "freelanddep" \in Fixes THEN FALSE ELSE @,
                                  !.depAhead = IF "freelanddep" \in Fixes THEN FALSE ELSE @]
              ELSE after
         ELSE IF PressUnlanded(after) THEN after
         ELSE IF after.armed.src # "none"
              THEN LET pd == PublishArmedDeparture(after, after.armed) IN
                   IF ~pd.r THEN pd.w
                   ELSE LatchSetIntent(IF after.armed.src # "touch"
                                       THEN [pd.w EXCEPT !.armed = NoArm] ELSE pd.w,
                                       FALSE)
         ELSE IF CorrSuppressed(after) THEN after ELSE StartEndCorrection(after)

\* Fixed ("obsarm"): an observation that sees the view on the end re-bases a
\* finger's step there, as a report at that clamp would: the clamp lands in
\* the frame before its scroll event is dispatched.
ObsArm(x) ==
    IF "obsarm" \in Fixes /\ x.armed.src = "touch" /\ AtBottom(x)
    THEN [x EXCEPT !.armed = TouchArm(x.s)] ELSE x

FollowEndIfPermitted(x0) ==
    IF ~x0.mounted \/ ~Measurable(x0) THEN x0
    ELSE LET read == ViewRead(x0)
             arrived == MomArrived(read)
             x == NotePressView(ObsArm(MomNoted(read)))
             rc == ReadCandidate(NoteOwed(x))
             y == rc.w IN
    IF AtBottom(x)
         THEN IF CorrSuppressed(x) THEN CancelCorr(x)
              \* reconcileMaintenanceAtStrictBottom: maintenance is never the
              \* reader's evidence, so a departed free reader stays held here,
              \* turn or no turn, until a report or the turn's end decides. A
              \* departure their own report re-based ("deprebase") is held only
              \* as a report holds it (`endMetHeldReaderMidTurn`, ReconcileAt).
              \* Fixed ("heldgap"): only a departure published ahead of its
              \* gesture's report (`armDepartsOnGrowth`) is held so.
              ELSE IF /\ ~x.perm /\ x.depAt # -1
                      /\ IF "idlehold" \in Fixes THEN x.s <= x.depAt
                         ELSE IF "heldgap" \in Fixes THEN x.depAhead \/ (x.turn /\ x.s <= x.depAt) ELSE ~x.depMoved
                   THEN IF "deprebase" \in Fixes /\ "idlehold" \in Fixes
                        THEN [CancelCorr(x) EXCEPT !.depAt = x.s] ELSE CancelCorr(x)
              ELSE IF ~x.perm /\ ReattachSuppressed(x)
                   THEN [CancelCorr(x) EXCEPT !.cand = Arrived(x)]
              ELSE ReconcileStrictBottom(x, FALSE, x.s)
    ELSE IF "ledgermaint" \in Fixes /\ Unexplained(x) THEN PublishReadDeparture(x)
    ELSE IF rc.r THEN y
    \* Fixed ("arrive"): the suppression has lifted, and the reader reached
    \* the end they asked for while it held: they follow from here.
    ELSE IF /\ ~y.perm /\ y.cand.arr /\ y.cand.rgen = y.rgen
            /\ ~CorrSuppressed(y) /\ ~ReattachSuppressed(y)
         THEN StartEndCorrection(LatchSetIntent([y EXCEPT !.cand = NoCand], TRUE))
    ELSE IF arrived /\ ~y.perm /\ ~CorrSuppressed(y) THEN MomFollow(y)
    \* Fixed ("depart"): growth that an away-from-end wheel's arm keeps from
    \* being corrected is that reader's departure, with no write.
    ELSE IF "depart" \in Fixes /\ y.perm /\ DepartsOnGrowth(y.armed)
         THEN [LatchSetIntent(PublishAt(y), FALSE) EXCEPT
                    !.depAhead = "alwaysawait" \in Fixes \/ led = -1 \/ y.rgen # w.rgen,
                    !.depWheel = y.armed.nested]
    ELSE IF ~y.perm \/ CorrSuppressed(y) \/ ArmBlocks(y.armed) THEN y
    ELSE StartEndCorrection(y)

\* beginOwnedEndNavigation / beginOwnedFreeNavigation and their completions
BeginOwnedEnd(x) == NewCorr(LatchSetIntent([x EXCEPT !.armed = NoArm, !.mom = NoMom, !.headedEnd = NoHeadedEnd], TRUE))
BeginOwnedFree(x) == [CancelCorr(x) EXCEPT !.cand = NoCand, !.mom = NoMom, !.headedEnd = NoHeadedEnd, !.armed = OwnedArm]
\* Fixed ("nav"): the landing decides. At the strict bottom (the row sat in
\* the last screenful) the reader follows again, whatever suppresses a
\* reattach; anywhere else they stay where it put them, though no report
\* published the departure (a landing that needed no scroll, the tail grown
\* while the arm held it off). A reader input that abandons the navigation
\* supersedes it (`navGen`), so this never runs for it and follow stays as
\* the input left it.
CompleteOwnedFree(x) ==
    IF "nav" \notin Fixes
    THEN IF x.armed.src = "owned" THEN [x EXCEPT !.armed = NoArm] ELSE x
    \* Fixed: the navigation's own first report may have consumed its arm
    \* (an animated jump publishes the departure); only a finger still on
    \* the transcript keeps the landing from deciding.
    ELSE IF x.armed.src = "touch" THEN x
    ELSE LET x1 == [x EXCEPT !.armed = NoArm] IN
         IF AtBottom(x1) THEN ReconcileAt(x1, FALSE, x1.s, TRUE)
         ELSE OweAtView(LatchSetIntent(x1, FALSE))
CompleteOwnedEnd(x, landed) == OweAtView(LatchSetIntent(CancelCorr(x), landed))

\* The touch lift (clearTouch).
ClearTouch(x) ==
    IF x.armed.src # "touch" THEN FollowEndIfPermitted(x)
    ELSE LET a == x.armed
             x1 == IF x.perm /\ Measurable(x) /\ ~AtBottom(x) /\ x.s # a.at
                   THEN ObserveLiveGeometry(x) ELSE x
             x2 == FollowEndIfPermitted([x1 EXCEPT !.armed = NoArm])
         \* Fixed ("fling"): momentum may carry the reader on from here.
         IN IF "fling" \in Fixes /\ Measurable(x2)
               /\ ~CorrSuppressed(x2) /\ ~ReattachSuppressed(x2) THEN [x2 EXCEPT !.mom = MomAt(x2)] ELSE [x2 EXCEPT !.mom = NoMom]

\* completePointerPreflight (pointerup / pointercancel on the scroll node)
CompletePointerPreflight(x) ==
    IF x.armed.src = "gesture" /\ x.armed.dir = "indeterminate"
    THEN IF Measurable(x) /\ ~AtBottom(x) /\ ~PressUnlanded(x) THEN ObserveLiveGeometry(x)
         ELSE IF PressUnlanded(x) THEN FollowEndIfPermitted([x EXCEPT !.armed = NoArm])
         ELSE [x EXCEPT !.armed = NoArm]
    ELSE x

(***************************************************************************)
(* The controller (ChatMessagesInner).                                     *)
(***************************************************************************)
\* captureLiveChatTabScrollSnapshot (the caller has checked measurability)
Capture(x) ==
    IF x.gate THEN NoSnap
    ELSE IF x.mode = "follow" THEN Snap("follow", 0, 0, 0)
    ELSE LET a == AnchorRow(x) IN Snap("free", a, a - x.lo, Pos(x, a) - x.s)

\* persistCurrentScroll: pointerdown (live) and unmount (live or closing)
Persist(x, closing) ==
    IF x.gate
    THEN IF closing /\ x.raw.on THEN [x EXCEPT !.store = x.raw] ELSE x
    ELSE LET snap == IF Measurable(x) THEN Capture(x) ELSE x.mirror
         IN IF snap.on THEN [x EXCEPT !.store = snap] ELSE x

ReconcileInvalidLanding(x) == [SetTimelineMode(x, "free", TRUE) EXCEPT !.pill = TRUE]
AcceptExhausted(x) == [x EXCEPT !.gate = FALSE, !.pendMeas = NoPend]

\* handleTranscriptPointerDown: the target is the scroll node itself only for
\* the scrollbar.
TranscriptPointerDown(x, onScrollbar) ==
    NoteReaderGesture(Persist(x, FALSE), "indeterminate", TRUE, onScrollbar)

\* issueFreeTimelineNavigation
IssueFree(x, row, anim) ==
    LET x1 == EndLoop(x)
        gen == x1.navGen
        x2 == [BeginOwnedFree(x1) EXCEPT !.animOp = anim]
        x3 == LibCall(x2, "index", row, NAVOFF, anim)
    IN [x3 EXCEPT !.nav = [k |-> "free", pol |-> NONE, gen |-> gen, ret |-> 3,
                           ph |-> "await", row |-> row, off |-> NAVOFF, tok |-> x3.tok,
                           fz |-> NoFz]]

\* navigateToMessage (minimap rail, phone Messages list): releaseForExplicit-
\* Navigation, then the free navigation, animated.
NavigateToMessage(x, row) ==
    LET x1 == NoteReaderGesture(ClearHydration(x), "indeterminate", FALSE, FALSE)
    IN IF Present(x1, row) THEN IssueFree(x1, row, TRUE) ELSE x1

\* scrollToEnd (the pill)
ScrollToEndNav(x, anim) ==
    LET x1 == ClearHydration(EndLoop(x))
        x2 == SetTimelineMode(x1, "follow", TRUE)
        gen == x2.navGen
        x3 == BeginOwnedEnd([x2 EXCEPT !.animOp = anim])
        x4 == LibCall(x3, "end", 0, 0, anim)
    IN [x4 EXCEPT !.nav = [k |-> "end", pol |-> NONE, gen |-> gen, ret |-> 3,
                           ph |-> "await", row |-> 0, off |-> 0, tok |-> x4.tok,
                           fz |-> NoFz]]

LandedAt(x, row, off) == Present(x, row) /\ Pos(x, row) - x.s = off

\* The free loop's validate. Before the fix it is the exact landing alone, so
\* a target past the end (a turn in the last screenful) or before the start
\* never validates and the loop retries with its arm blocking follow. Fixed,
\* a landing the scroll range clamps counts.
NavLanded(x, row, off) ==
    \/ LandedAt(x, row, off)
    \/ /\ "nav" \in Fixes /\ Present(x, row)
       /\ \/ AtBottom(x) /\ Pos(x, row) - off >= MaxS(x)
          \/ x.s = 0 /\ Pos(x, row) - off <= 0

\* settleChatTimelineNavigation's onSettle for the free and end loops
\* (`scrollend` or the 750ms fallback; fixed, the free loop's promise and two
\* frames, or its 2600ms fallback, which validates as a miss: `timedOut`).
NavSettle(x, timedOut) ==
    LET n == x.nav
        x0 == [x EXCEPT !.nav = NoNav]
    IN IF x.navGen # n.gen THEN x0
       ELSE IF n.k = "free"
       THEN IF ~timedOut /\ NavLanded(x, n.row, n.off)
            THEN [CompleteOwnedFree([x0 EXCEPT !.animOp = FALSE]) EXCEPT !.gate = FALSE]
            ELSE IF n.ret = 0
            THEN IF "nav" \in Fixes /\ x.cmd.tok = n.tok
                 \* Fixed: the last command is still queued (no frames in a
                 \* background window), so ownership lasts until it has run.
                 THEN AcceptExhausted([x EXCEPT !.animOp = FALSE, !.nav.ph = "trail"])
                 ELSE AcceptExhausted(CompleteOwnedFree([x0 EXCEPT !.animOp = FALSE]))
            ELSE LET x1 == LibCall([x0 EXCEPT !.animOp = FALSE], "index", n.row, n.off, FALSE)
                 IN [x1 EXCEPT !.nav = [n EXCEPT !.ret = @ - 1, !.ph = "await", !.tok = x1.tok]]
       \* Fixed ("pill"): while the reader still follows, the latch's own
       \* corrections chase a tail that outgrew the landing; the loop hands
       \* the rest of the distance to maintenance instead of retrying it.
       ELSE IF AtBottom(x) \/ ("pill" \in Fixes /\ x.mode = "follow")
            THEN LET x1 == CompleteOwnedEnd([x0 EXCEPT !.animOp = FALSE], TRUE)
                 IN IF "pill" \in Fixes THEN FollowEndIfPermitted(x1) ELSE x1
            ELSE IF n.ret = 0
            THEN ReconcileInvalidLanding(CompleteOwnedEnd([x0 EXCEPT !.animOp = FALSE], FALSE))
            ELSE LET x1 == LibCall(BeginOwnedEnd([x0 EXCEPT !.animOp = FALSE]), "end", 0, 0, FALSE)
                 IN [x1 EXCEPT !.nav = [n EXCEPT !.ret = @ - 1, !.ph = "await", !.tok = x1.tok]]

\* The restore's command. Fixed ("restore"): by row, so the list renders and
\* measures the saved row and places it from its live position when the
\* command runs; before, an offset computed from estimates at the call.
RestoreCall(x, row, off) ==
    IF "restore" \in Fixes THEN LibCall(x, "index", row, off, FALSE)
    ELSE LibCall(x, "offset", 0, Pos(x, row) - off, FALSE)

\* restorePersistedTimelineLocation -> [w, r]
RestoreIssue(x, row, off, pol, fz) ==
    IF ~Present(x, row) THEN [w |-> x, r |-> FALSE]
    ELSE LET x1 == EndLoop(x)
             gen == x1.navGen
             x2 == RestoreCall(x1, row, off)
         IN [w |-> [x2 EXCEPT !.nav = [k |-> "restore", pol |-> pol, gen |-> gen, ret |-> 3,
                                       ph |-> "await", row |-> row, off |-> off,
                                       tok |-> x2.tok, fz |-> fz]],
             r |-> TRUE]

\* The mount-time caller's isAborted: reconcile live geometry through the
\* latch first, then give up on a following-end report, resolving the frozen
\* target. -> [w, a]
MountAbort(x, n) ==
    LET x1 == ObserveLiveGeometry(x) IN
    IF x1.mode = "free" THEN [w |-> x1, a |-> FALSE]
    ELSE LET past == PastFrozen(x1, n.fz)
             x2 == IF past THEN [ClearHydration(x1) EXCEPT !.gate = FALSE] ELSE x1
         IN [w |-> [x2 EXCEPT !.resolveEnd = NoFz, !.pendMeas = NoPend], a |-> TRUE]

\* The restore loop's onSettle, two frames after its promise resolved. The
\* loop runs to the end of this callback even when its own cleanup was
\* called from inside isAborted; only its NEXT settle sees `cancelled`.
RestoreSettle(x) ==
    LET n == x.nav
        ab == IF n.pol = "mount" THEN MountAbort(x, n) ELSE [w |-> x, a |-> FALSE]
        x1 == ab.w
        cancelled == x1.nav # n
        x0 == IF cancelled THEN x1 ELSE [x1 EXCEPT !.nav = NoNav]
    IN IF ab.a \/ x1.navGen # n.gen THEN x0
       ELSE IF LandedAt(x1, n.row, n.off)
       THEN LET x2 == SetTimelineMode(x0, "free", FALSE)
                x3 == CASE n.pol = "mount" -> [x2 EXCEPT !.resolveEnd = NoFz]
                        [] n.pol = "hyd"   -> ClearHydration(x2)
                        [] OTHER           -> x2
                x4 == AcceptExhausted(x3)
                snap == Capture(x4)
            IN IF snap.on THEN [x4 EXCEPT !.mirror = snap] ELSE x4
       ELSE IF n.ret = 0
       THEN CASE n.pol = "mount" ->
                    ReconcileInvalidLanding([x0 EXCEPT !.resolveEnd = NoFz, !.gate = FALSE,
                                                       !.pendMeas = NoPend])
              [] n.pol = "hyd" -> x0
              [] OTHER -> ReconcileInvalidLanding([x0 EXCEPT !.gate = FALSE, !.pendMeas = NoPend])
       ELSE IF ~Present(x0, n.row) THEN x0
       ELSE LET x2 == RestoreCall(x0, n.row, n.off)
            IN IF cancelled THEN x2
               ELSE [x2 EXCEPT !.nav = [n EXCEPT !.ret = @ - 1, !.ph = "await", !.tok = x2.tok]]

(***************************************************************************)
(* The saved state (chat-tab-state-cache.ts) and the mount.                *)
(***************************************************************************)
\* restoreChatTabState over row ids lo..hi (a whole-row transcript)
RestoreState(snap, lo, hi) ==
    IF ~snap.on THEN TailSnap
    ELSE IF snap.anchor = 0 \/ (snap.anchor >= lo /\ snap.anchor <= hi) THEN snap
    ELSE LET ci == Min(Max(snap.idx, 0), hi - lo)
         IN Snap(snap.mode, lo + ci, ci, 0)

\* restoreChatTabStateForMount
RestoreForMount(snap, lo, hi) ==
    LET r == RestoreState(snap, lo, hi) IN
    IF r.mode # "free" \/ r.anchor # 0 THEN r
    ELSE IF snap.on /\ snap.anchor # 0 THEN r
    ELSE TailSnap

\* A fresh ChatMessagesInner: its initializers, LegendList's bootstrap
\* (initialScrollAtEnd / initialScrollIndex over estimates), then the commit's
\* layout effects in order: the timeline's maintain call, the registry write,
\* the measured free restore; the latch's listener effect runs one re-render
\* later and calls followEndIfPermitted again. The hydration retry is a
\* passive effect and runs later (`hydFx`).
MountState(store, reg, lo, hi, real, rowsVer, tok) ==
    LET raw == IF reg.on THEN reg ELSE store
        restored == RestoreForMount(store, lo, hi)
        pendHyd == IF raw.on /\ raw.mode # "follow" /\ raw.anchor # 0
                      /\ restored.anchor # raw.anchor
                   THEN raw.anchor ELSE 0
        follow == restored.mode = "follow"
        pendMeas == IF restored.mode = "free" /\ restored.anchor # 0
                    THEN [on |-> TRUE, row |-> restored.anchor, off |-> restored.off]
                    ELSE NoPend
        base == [
            tailOff |-> [i \in Rows |-> 0], tailGen |-> [i \in Rows |-> 0],
            tailHead |-> [i \in Rows |-> TailHead], rowKnown |-> [i \in Rows |-> TRUE],
            touchWriteMayLand |-> FALSE, liftLanding |-> FALSE,
            lastView |-> NoView, viewCredit |-> 0, depOwed |-> ~follow,
            mounted |-> TRUE, lo |-> lo, hi |-> hi, real |-> real,
            sz |-> [i \in Rows |-> EST], s |-> 0, V |-> VH, visible |-> TRUE,
            dirty |-> FALSE, send |-> FALSE, smooth |-> -1, finger |-> FALSE,
            silent |-> FALSE, panDir |-> 0, inputMove |-> "none", flingDir |-> 0,
            dragging |-> FALSE,
            ro |-> TRUE, settling |-> FALSE, structUnsettled |-> FALSE,
            tok |-> tok, cmd |-> NoCmd,
            perm |-> follow, armed |-> NoArm, rgen |-> 0, cgen |-> 0, corr |-> NoCorr,
            pendEnd |-> 0, cand |-> NoCand, mom |-> NoMom, headedEnd |-> NoHeadedEnd,
            mode |-> IF follow THEN "follow" ELSE "free", atEnd |-> follow,
            pill |-> ~follow, navGen |-> 0,
            gate |-> raw.on /\ raw.mode # "follow" /\ raw.anchor # 0,
            pendHyd |-> pendHyd, pendMeas |-> pendMeas, resolveEnd |-> NoFz,
            nav |-> NoNav, animOp |-> FALSE, mirror |-> NoSnap, lastVisTop |-> -1,
            concealed |-> NoGeo, hydFx |-> TRUE, rowsVer |-> rowsVer, raw |-> raw,
            store |-> store, reg |-> reg,
            known |-> {}, est |-> EST, pend |-> 0, ls |-> 0, jump |-> FALSE, wheelPend |-> 0,
            idleRestore |-> 0, pad |-> 0, turn |-> TRUE, depAt |-> -1, depMoved |-> FALSE, depAhead |-> FALSE, depWheel |-> FALSE,
            boot |-> IF InitialEnd /\ follow THEN "settling" ELSE "none", runner |-> TRUE]
        s0 == IF follow THEN MaxS(base)
              ELSE IF pendMeas.on THEN Clamp(base, Pos(base, pendMeas.row) - pendMeas.off)
              ELSE 0
        b0 == ListSaw([base EXCEPT !.s = s0], s0)
        b1 == FollowEndIfPermitted(b0)
        b2 == IF pendHyd # 0 /\ raw.on THEN [b1 EXCEPT !.reg = raw] ELSE b1
        b3 == IF b2.pendMeas.on /\ b2.mode = "free"
              THEN LET row == b2.pendMeas.row
                       fz == [on |-> TRUE, target |-> Pos(b2, row) - b2.pendMeas.off,
                              h |-> H(b2), v |-> b2.V, rowPos |-> Pos(b2, row),
                              ver |-> b2.rowsVer, row |-> row]
                   IN RestoreIssue([b2 EXCEPT !.resolveEnd = fz], row, b2.pendMeas.off,
                                   "mount", fz).w
              ELSE b2
    IN FollowEndIfPermitted(b3)

(***************************************************************************)
(* The reader's intent and the checks.                                     *)
(***************************************************************************)
IntentOf(x) ==
    IF AtBottom(x) THEN Intent("tail", 0, 0)
    ELSE Intent("at", AnchorRow(x), Pos(x, AnchorRow(x)) - x.s)

\* The transcript shows what the reader asked for: the tail, the row they
\* scrolled to at the offset they left it, or the row they picked (or the
\* bottom, when that row is in the last screenful and cannot reach the top).
IntentHeld(x) ==
    CASE intent.k = "tail" -> AtBottom(x)
      [] intent.k \in {"at", "nav"} ->
            ~Present(x, intent.row)
            \/ Pos(x, intent.row) - x.s = intent.off
            \/ (AtBottom(x) /\ Pos(x, intent.row) - intent.off >= MaxS(x))
      [] OTHER -> TRUE

\* Nothing is in flight: no navigation, correction, list command, scroll
\* event, effect, frame work, finger, fling, or unmeasured visible row.
Quiescent(x) ==
    /\ x.mounted /\ x.visible /\ Measurable(x)
    \* An end command the list has no runner for never runs: nothing more
    \* will happen to it, or to what waits on it.
    /\ x.cmd.k = "none" \/ ~Runs(x)
    /\ x.nav.k = "none" \/ ~Runs(x)
    /\ x.corr.stage = "none" \/ ~Runs(x)
    /\ x.smooth = -1 /\ ~x.dirty /\ ~x.send /\ ~x.ro /\ ~x.hydFx
    /\ ~x.settling /\ ~x.structUnsettled
    /\ ~x.finger /\ x.flingDir = 0 /\ ~x.dragging /\ x.wheelPend = 0
    /\ x.pad = 0 /\ x.boot # "settling"
    /\ \A i \in x.lo..x.hi : InWindow(x, i) => x.sz[i] = x.real[i]
    \* A saved row still loading is in flight: the snapshot's older rows are
    \* on their way, and the windowed line demands the owning turn.
    /\ (x.pendHyd = 0 \/ Present(x, x.pendHyd))

\* A saved state matches what the reader saw.
\* The saved state, replayed on this geometry, shows this view: a row and an
\* offset that name the same pixel as another row's are the same position.
SnapMatches(snap, x) ==
    /\ snap.on
    /\ IF AtBottom(x) THEN snap.mode = "follow"
       ELSE /\ snap.mode = "free" /\ Present(x, snap.anchor)
            /\ Pos(x, snap.anchor) - snap.off = x.s

(***************************************************************************)
(* Initial state.                                                          *)
(***************************************************************************)
StartStore ==
    CASE StartMode = "saved-free" -> Snap("free", 2, 1, 0)
      [] StartMode = "saved-tail" -> TailSnap
      [] OTHER -> NoSnap

Init ==
    /\ w = MountState(StartStore, NoSnap, StartLo, Min(R, 3), RealInit, 0, 0)
    /\ intent = IF StartMode = "saved-free" THEN Intent("at", 2, 0) ELSE Intent("tail", 0, 0)
    /\ flags = [staleSave |-> FALSE]
    /\ led = IF "ledger" \in Fixes THEN -1 ELSE w.s
    /\ silent = FALSE
    /\ liftEnd = NoLiftEnd
    /\ nestedInput = [gen |-> -1, prior |-> intent, endMoved |-> FALSE]
    /\ missedFollow = "none"
    /\ budget = [grow |-> Grows, append |-> Appends, prepend |-> Prepends,
                 wheel |-> Wheels, drag |-> Drags, click |-> Clicks, touch |-> Touches,
                 fling |-> Flings, minimap |-> Minimaps, pick |-> PhonePicks,
                 pill |-> Pills, hide |-> Hides, remount |-> Remounts, jump |-> Jumps,
                 nested |-> NestedWheels, unscrolled |-> UnscrolledWheels, pad |-> Pads,
                 turnEnd |-> TurnEnds, relayout |-> Relayouts, idleShrink |-> IdleShrinks, cycle |-> Cycles, aboveTail |-> AboveTailGrows,
                 tailRemount |-> TailRemounts, viewport |-> Viewports, appWrite |-> AppWrites]
    /\ last = "Init"

Spend(k) == budget' = [budget EXCEPT ![k] = @ - 1]
Can(k) == budget[k] > 0

(***************************************************************************)
(* Content: the agent stream, new rows, older rows, measurement.           *)
(***************************************************************************)
\* A streamed token grows the last row. The list gets a new rows array (a
\* content-only change), so the timeline's maintain effect runs and the
\* hydration retry's dependencies change. The list clears `didDataChange` in
\* the same commit's layout effect and arms no anchor lock, so it is not
\* settling afterwards.
Grow ==
    /\ w.mounted /\ w.turn /\ Can("grow") /\ w.real[w.hi] < MaxH
    /\ LET x1 == [w EXCEPT !.real[w.hi] = @ + 1, !.tailHead[w.hi] = @ \o "a",
                          !.rowsVer = @ + 1, !.hydFx = TRUE]
       \* A same-key update: MVCP's size channel anchors it.
       IN w' = FollowEndIfPermitted(ReEstimate(x1, SizePass))
    /\ Spend("grow") /\ last' = "Grow"
    /\ UNCHANGED <<intent, flags>>

\* Content below an idle reader shrinks until the end meets their view
\* exactly. The later Measure sees strict bottom without moving scrollTop,
\* so the browser dispatches no scroll event to decide the departure hold.
IdleTailShrink ==
    /\ w.mounted /\ ~w.turn /\ Measurable(w) /\ Can("idleShrink")
    /\ ~w.dragging /\ ~w.finger /\ w.pad = 0
    /\ LET d == MaxS(w) - w.s
       IN /\ d > 0 /\ w.sz[w.hi] > d + (IF IdleClamp THEN 1 ELSE 0) /\ InWindow(w, w.hi)
          /\ w' = FollowEndIfPermitted([w EXCEPT !.real[w.hi] = w.sz[w.hi] - d - (IF IdleClamp THEN 1 ELSE 0),
                                                 !.idleRestore = w.sz[w.hi],
                                                 !.rowsVer = @ + 1, !.hydFx = TRUE])
    /\ Spend("idleShrink") /\ last' = "IdleTailShrink"
    /\ UNCHANGED <<intent, flags>>

\* The idle row grows back only after its shrink has been measured.
IdleTailRegrow ==
    /\ w.mounted /\ ~w.turn /\ Measurable(w)
    /\ w.idleRestore > 0 /\ w.sz[w.hi] = w.real[w.hi]
    /\ w' = FollowEndIfPermitted([w EXCEPT !.real[w.hi] = w.idleRestore,
                                                !.idleRestore = 0,
                                                !.rowsVer = @ + 1, !.hydFx = TRUE])
    /\ last' = "IdleTailRegrow"
    /\ UNCHANGED <<intent, flags, budget>>

\* In-row content (e.g. an image) above the trailing block resolves.
\* The measured last row and block top move together; its row top does not.
AboveTailGrow ==
    /\ w.mounted /\ w.turn /\ Measurable(w) /\ Can("aboveTail")
    /\ InWindow(w, w.hi) /\ w.real[w.hi] = w.sz[w.hi] /\ w.sz[w.hi] < MaxH
    /\ LET x == [w EXCEPT !.real[w.hi] = @ + 1, !.sz[w.hi] = @ + 1,
                          !.tailOff[w.hi] = @ + 1, !.rowsVer = @ + 1, !.hydFx = TRUE,
                          !.known = IF "unreadsize" \in Fixes THEN @ \cup {w.hi} ELSE @]
           xf == FollowEndIfPermitted(x)
       IN /\ w' = xf
          \* As Measure: an unreported landing moved past before any read
          \* has not arrived at the end the latch can observe.
          /\ intent' = IF xf.cand.arr /\ ~w.cand.arr THEN Intent("tail", 0, 0)
                       ELSE IF /\ intent.k = "tail" /\ ~w.perm /\ AtBottom(w)
                               /\ ~xf.perm /\ ~AtBottom(xf) /\ ~xf.cand.arr
                               /\ ~ReachedHeadedEnd(xf)
                            THEN Intent("at", AnchorRow(xf), Pos(xf, AnchorRow(xf)) - xf.s)
                       ELSE intent
    /\ Spend("aboveTail") /\ last' = "AboveTailGrow"
    /\ UNCHANGED flags

TailBlockChange(kind) ==
    /\ w.mounted /\ Can("tailRemount")
    /\ CASE kind = "remount" -> w' = [w EXCEPT !.tailGen[w.hi] = @ + 1]
         [] kind = "recycle" -> w' = [w EXCEPT !.tailHead[w.hi] = "x"]
         [] kind = "empty" -> w' = [w EXCEPT !.tailHead[w.hi] = ""]
         [] kind = "unknown-row" -> w' = [w EXCEPT !.rowKnown[w.hi] = FALSE]
    /\ Spend("tailRemount") /\ last' = "TailBlockChange(" \o kind \o ")"
    /\ UNCHANGED <<intent, flags>>

\* A keyboard/chrome change alters the offset that reaches held content.
ViewportChange(v) ==
    /\ w.mounted /\ Can("viewport") /\ v \in {1, 2, 3} /\ v # w.V
    /\ LET x == [w EXCEPT !.V = v, !.ro = TRUE]
           t == Clamp(x, w.s)
           y == [x EXCEPT !.s = t, !.dirty = @ \/ t # w.s, !.send = HasScrollEnd]
       IN /\ w' = y
          /\ intent' = IF intent.k = "at" /\ t # w.s
                       THEN Intent("at", AnchorRow(y), Pos(y, AnchorRow(y)) - t) ELSE intent
    /\ Spend("viewport") /\ last' = "ViewportChange"
    /\ UNCHANGED flags

\* A new row at the end: a key-sequence change (MVCP data channel, and the
\* timeline's structural settle holds reattach until layout is still).
AppendRow ==
    /\ w.mounted /\ w.turn /\ Can("append") /\ w.hi < R
    \* A finger's or a drag's movement and its report share a frame, whether
    \* or not the contact has lifted: a row does not land between them
    \* (frame-granularity residue).
    /\ w.inputMove = "none"
    /\ LET x1 == [w EXCEPT !.hi = @ + 1, !.rowsVer = @ + 1, !.settling = TRUE,
                           !.hydFx = TRUE, !.structUnsettled = TRUE,
                           !.sz[w.hi + 1] = w.est]
       IN w' = FollowEndIfPermitted(ReEstimate(x1, DataPass))
    /\ Spend("append") /\ last' = "AppendRow"
    /\ UNCHANGED <<intent, flags>>

\* An older row arrives above (a snapshot that grows after mount). MVCP's
\* data channel keeps the visible rows still.
PrependRow ==
    /\ w.mounted /\ Can("prepend") /\ w.lo > 1
    /\ LET x1 == [w EXCEPT !.lo = @ - 1, !.rowsVer = @ + 1, !.settling = TRUE,
                           !.hydFx = TRUE, !.structUnsettled = TRUE,
                           !.sz[w.lo - 1] = w.est]
           x2 == IF Measurable(x1)
                 THEN [x1 EXCEPT !.s = @ + x1.sz[w.lo - 1], !.depAt = Tr(x1, x1.s + x1.sz[w.lo - 1]),
                                 !.armed = TrArm(x1, x1.s + x1.sz[w.lo - 1]),
                                 !.mom = TrMom(x1, x1.s + x1.sz[w.lo - 1]),
                                 !.lastView = ViewAfterMove(x1, x1.s + x1.sz[w.lo - 1], FALSE)]
                 ELSE x1
       IN w' = FollowEndIfPermitted(ReEstimate(x2, DataPass))
    /\ Spend("prepend") /\ last' = "PrependRow"
    /\ UNCHANGED <<intent, flags>>

\* The list measures a mounted row (onItemSizeChanged). MVCP's size channel
\* keeps the first visible row still when a row above it changes; the
\* browser clamps scrollTop when content shrinks below it. Then the
\* timeline's size callback calls followEndIfPermitted.
Measure(i) ==
    /\ w.mounted /\ Measurable(w) /\ Present(w, i) /\ InWindow(w, i)
    \* A row at its estimate is measured too, which only matters to a
    \* pass that would replace that estimate, and to #3088's measured-only size.
    /\ w.sz[i] # w.real[i] \/ ((Jumps > 0 \/ "unreadsize" \in Fixes) /\ i \notin w.known)
    /\ ReportBeforeGrowth /\ i = w.hi /\ w.real[i] > w.sz[i]
       /\ w.armed.src = "gesture" /\ w.armed.wheel => led # -1
    /\ LET d == w.real[i] - w.sz[i]
           above == i < AnchorRow(w)
           x1 == [w EXCEPT !.sz[i] = w.real[i],
                           !.known = IF Jumps > 0 \/ "unreadsize" \in Fixes THEN @ \cup {i} ELSE @]
           \* Held back under an animated command; a shrink below the
           \* reader is still the browser's clamp.
           defer == above /\ Deferring(w)
           want == IF above /\ ~defer THEN w.s + d ELSE w.s
           t == Clamp(x1, want)
           x2 == IF t = w.s THEN x1
                 ELSE [x1 EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1, !.send = HasScrollEnd,
                                 !.depAt = Tr(x1, t),
                                 !.armed = IF x1.armed.src = "touch" THEN TrArm(x1, want)
                                           ELSE Carry(x1, t),
                                 !.mom = TrMom(x1, t), !.lastView = ViewAfterMove(x1, t, FALSE)]
           x3 == IF defer THEN [x2 EXCEPT !.pend = @ + d] ELSE ListSaw(x2, t)
           xf == FollowEndIfPermitted(ReEstimate(x3, SizePass))
       IN /\ w' = xf
          \* A transcript that shrank below the reader brings them to its end,
          \* clamped or landing on it exactly. Once the turn has finished, and
          \* with no departure of theirs still to report, they are at the tail.
          \* Otherwise they stay where they were (the owner's rule while the
          \* turn streams), and where the browser's clamp put them is where
          \* they are, as for the end pad's reset.
          \* A request for the end the latch sees met here is the tail.
          /\ intent' = IF xf.cand.arr /\ ~w.cand.arr THEN Intent("tail", 0, 0)
                       ELSE IF intent.k = "at" /\ AtBottom(x2) /\ (~AtBottom(w) \/ t # want)
                       THEN IF t # want
                            THEN Intent("at", AnchorRow(x2), Pos(x2, AnchorRow(x2)) - t)
                            ELSE intent
                       \* A free reader's landing on the end that the latch has not
                       \* yet seen, which this growth moves on before it does:
                       \* arrival is judged against the end the latch sees ("reach"),
                       \* so they asked for no more than where they are.
                       ELSE IF /\ intent.k = "tail" /\ ~w.perm /\ AtBottom(w)
                               /\ ~xf.perm /\ ~AtBottom(xf) /\ ~xf.cand.arr
                               /\ ~ReachedHeadedEnd(xf)
                            THEN Intent("at", AnchorRow(xf), Pos(xf, AnchorRow(xf)) - xf.s)
                       ELSE intent
    /\ last' = "Measure"
    /\ UNCHANGED <<flags, budget>>

\* A turn that has just gone cold mounts at its remembered height, and its
\* type's average jumps more than 2x: every cached estimate of an unmeasured
\* row of that type is stale from here. The rows on screen have been measured
\* by then (the jump is a measurement); the cold ones off it have not. Which
\* pass lays those out next is the environment's choice.
AverageJump ==
    /\ w.mounted /\ Measurable(w) /\ Can("jump") /\ w.est = EST
    /\ \A i \in w.lo..w.hi : InWindow(w, i) => i \in w.known
    /\ \E i \in w.lo..w.hi : i \notin w.known /\ w.sz[i] = EST
    /\ w' = [w EXCEPT !.est = REST]
    /\ Spend("jump") /\ last' = "AverageJump"
    /\ UNCHANGED <<intent, flags>>

\* Two frames with no data change: the list stops settling.
SettleFrames ==
    /\ w.settling
    /\ w' = [w EXCEPT !.settling = FALSE]
    /\ last' = "SettleFrames"
    /\ UNCHANGED <<intent, flags, budget>>

\* The timeline's structural settle: scrollHeight held still for two frames
\* with no end correction outstanding.
StructSettle ==
    /\ w.mounted /\ w.structUnsettled /\ w.pendEnd = 0
    /\ w' = FollowEndIfPermitted([w EXCEPT !.structUnsettled = FALSE])
    /\ last' = "StructSettle"
    /\ UNCHANGED <<intent, flags, budget>>

\* The hydration retry (a passive effect on every rows change).
HydrationEffect ==
    /\ w.mounted /\ w.hydFx
    /\ LET x1 == [w EXCEPT !.hydFx = FALSE] IN
       w' = IF x1.pendHyd # 0 /\ Present(x1, x1.pendHyd)
            THEN RestoreIssue(x1, x1.pendHyd, x1.raw.off, "hyd", NoFz).w
            ELSE x1
    /\ last' = "HydrationEffect"
    /\ UNCHANGED <<intent, flags, budget>>

\* The latch's ResizeObserver (a viewport resize, a pane shown again).
ResizeObserved ==
    /\ w.mounted /\ w.ro
    /\ w' = FollowEndIfPermitted([w EXCEPT !.ro = FALSE])
    /\ last' = "ResizeObserved"
    /\ UNCHANGED <<intent, flags, budget>>

\* The list's ScrollAdjust pads the end (paddingBottom, twice an adjust's
\* overshoot of the content it has laid out) for one frame, then resets it,
\* and the browser clamps the offset back to the real end. What makes an
\* adjust overshoot (content the list has not sized yet) is below the
\* model's sizes, so the pad opens at the environment's choice.
PadOpen ==
    /\ w.mounted /\ w.turn /\ Measurable(w) /\ Can("pad") /\ w.pad = 0
    /\ LET x1 == [w EXCEPT !.pad = 2, !.ro = TRUE]
       IN /\ w' = x1
          \* A free reader's landing on the strict bottom that the pad moves
          \* the end on from before any report sees it is no arrival (Measure).
          /\ intent' = IF /\ intent.k = "tail" /\ ~w.perm /\ AtBottom(w) /\ ~x1.cand.arr
                          /\ ~ReachedHeadedEnd(x1)
                       THEN Intent("at", AnchorRow(x1), Pos(x1, AnchorRow(x1)) - x1.s)
                       ELSE intent
    /\ Spend("pad") /\ last' = "PadOpen"
    /\ UNCHANGED flags

\* The producer may restore and reopen its end pad before any observer.
\* #3081 announces the forced-layout clamp before that regrowth; the
\* before-fix branch preserves the ledger and carried references.
PadCycle ==
    /\ w.mounted /\ w.turn /\ Measurable(w) /\ w.pad = 2 /\ Can("cycle")
    /\ IF Drags > 0
       THEN w.dragging /\ w.armed.src = "gesture" /\ w.armed.dir = "indeterminate"
       ELSE ~w.dragging
    /\ LET down == [w EXCEPT !.pad = 0]
           t == Clamp(down, w.s)
       IN /\ t # w.s
          /\ w' = [w EXCEPT !.s = t, !.dirty = TRUE, !.ro = TRUE,
                            !.smooth = -1, !.send = HasScrollEnd,
                            !.depAt = IF "padannounce" \in Fixes THEN Tr(w, t) ELSE @,
                            !.armed = IF "padannounce" \in Fixes THEN RangeArm(w, t) ELSE @,
                            !.mom = IF "padannounce" \in Fixes THEN TrMom(w, t) ELSE @,
                            !.lastView = IF "padannounce" \in Fixes THEN ViewAfterMove(w, t, TRUE) ELSE @]
    /\ Spend("cycle") /\ last' = "PadCycle"
    /\ UNCHANGED <<intent, flags>>

PadReset ==
    /\ w.pad # 0
    /\ LET x1 == [w EXCEPT !.pad = 0, !.ro = TRUE]
           t == Clamp(x1, w.s)
           x2 == IF t = w.s THEN x1
                 ELSE [x1 EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1, !.send = HasScrollEnd,
                                 !.depAt = Tr(IF "padannounce" \in Fixes THEN w ELSE x1, t), !.armed = RangeArm(IF "padannounce" \in Fixes THEN w ELSE x1, t),
                                 !.mom = IF "padannounce" \in Fixes THEN TrMom(w, t) ELSE @,
                            !.lastView = IF "padannounce" \in Fixes THEN ViewAfterMove(w, t, TRUE) ELSE @]
       IN /\ w' = x2
          \* A reader inside the pad has nowhere to stay once it goes: the
          \* clamp's end is where they are now, whatever the latch has heard.
          \* It is the tail only once the turn has finished, and not under a
          \* departure still to report (as for a shrink, in Measure).
          /\ intent' = IF intent.k = "at" /\ t # w.s
                       THEN Intent("at", AnchorRow(x2), Pos(x2, AnchorRow(x2)) - t)
                       ELSE intent
    /\ last' = "PadReset"
    /\ UNCHANGED <<flags, budget>>

\* The list's initial scroll to the end finishes, and its settled re-layout
\* runs. The list keeps the end target (a chat has a footer, so a reader
\* moving away only retargets it), until refreshed estimates re-finish the
\* initial scroll and clear it: in the model, when this pass refreshes the
\* held estimates, or when a reader's scroll away from the end retires it
\* (WheelScroll).
BootSettle ==
    /\ w.mounted /\ Measurable(w) /\ w.boot = "settling"
    /\ LET x1 == ReEstimate(w, InitPass(w))
           x2 == IF x1.sz # w.sz THEN FollowEndIfPermitted(x1) ELSE x1
           refreshes == ~HoldsTop(w, InitPass(w), 0)
       IN w' = [x2 EXCEPT !.boot = IF refreshes THEN "none" ELSE "kept"]
    /\ last' = "BootSettle"
    /\ UNCHANGED <<intent, flags, budget>>

\* The viewport changes width or height. With the initial end target still
\* kept, the list corrects to it (handleBootstrapInitialScrollLayoutChange,
\* then schedulePreservedEndAnchorCorrection's requestAdjust; before the
\* finish, the bootstrap rearms on it): the view goes to the end. Row sizes
\* do not change here; the latch's ResizeObserver runs.
Relayout ==
    /\ w.mounted /\ Measurable(w) /\ Can("relayout")
    /\ LET x1 == [w EXCEPT !.ro = TRUE]
       IN w' = IF w.boot # "none" /\ ~AtBottom(w) THEN Adjust(x1, MaxS(x1)) ELSE x1
    /\ Spend("relayout") /\ last' = "Relayout"
    /\ UNCHANGED <<intent, flags>>

\* The streaming turn finishes, with the transcript at rest (the turn's
\* last chunk measured and settled), though a wheel's smooth scroll may still
\* be to land. A free reader at the strict bottom then is at the tail (the
\* owner's rule); fixed ("fallen"), the latch follows them. A gesture's arm
\* stays until its scroll reports, the next input, or growth. The rejected
\* "turnclear" clears one still waiting for a reader at the strict bottom,
\* and the wheel's scroll landing after it reads as layout's. Fixed
\* ("turnguard"), the latch does nothing at all while a blocking gesture arm
\* is pending: following them would clear it the same way. Fixed ("heldgap"),
\* a departure published ahead of that report keeps the pending state after
\* its growth publication has consumed the arm.
TurnEnd ==
    /\ w.turn /\ Can("turnEnd") /\ Quiescent([w EXCEPT !.wheelPend = 0])
    /\ LET x0 == IF /\ "turnclear" \in Fixes /\ AtBottom(w) /\ w.armed.src = "gesture"
                    /\ w.armed.blocks
                 THEN [w EXCEPT !.armed = NoArm] ELSE w
           \* Fixed ("restspend"): a waiting gesture arm a report has followed
           \* (the ledger is set again) is spent at rest.
           spend == /\ "restspend" \in Fixes /\ led # -1
                    /\ x0.armed.src = "gesture" /\ x0.armed.blocks
           x1 == [x0 EXCEPT !.turn = FALSE, !.armed = IF spend THEN NoArm ELSE @]
           there == w.mounted /\ AtBottom(w) /\ ~ArmBlocks(x0.armed)
           pending == x1.armed.src = "gesture" /\ x1.armed.blocks
       \* reconcileTurnAtRest reconciles only a held reader (one with a
       \* departure), until "restspend": any free reader at the strict bottom.
       IN /\ w' = IF /\ "fallen" \in Fixes /\ w.mounted /\ AtBottom(w) /\ ~w.perm
                     /\ ("restspend" \in Fixes \/ w.depAt # -1)
                     /\ ~CorrSuppressed(w) /\ ~("turnguard" \in Fixes /\ pending)
                     /\ ~FollowGuarded(x1)
                     /\ ~("heldgap" \in Fixes /\ x1.depAhead)
                     THEN LatchSetIntent(x1, TRUE) ELSE x1
          /\ intent' = IF intent.k = "at" /\ there THEN Intent("tail", 0, 0) ELSE intent
    /\ Spend("turnEnd") /\ last' = "TurnEnd"
    /\ UNCHANGED flags

(***************************************************************************)
(* LegendList and the browser.                                             *)
(***************************************************************************)
\* A pick whose row cannot reach the top of the viewport lands at the tail,
\* and a reader there is at the tail: when its loop ends, the intent is the
\* tail's.
NavIntent(x, x2) ==
    IF /\ intent.k = "nav" /\ x.nav.k = "free" /\ x2.nav.k = "none"
       /\ AtBottom(x2) /\ Present(x2, intent.row)
       /\ Pos(x2, intent.row) - intent.off >= MaxS(x2)
    THEN Intent("tail", 0, 0) ELSE intent

\* `settling` is isSettlingAfterDataChange: an MVCP recalculation scheduled
\* under the anchor lock that a key-sequence commit arms (about 300ms).
LibReady ==
    /\ w.mounted /\ w.cmd.ph = "wait" /\ ~w.settling /\ Measurable(w) /\ Runs(w)
    /\ w' = LibRun(w)
    /\ last' = "LibReady"
    /\ UNCHANGED <<intent, flags, budget>>

\* A timer of 100ms or more cannot fire before a scroll event already queued
\* for the next frame, while the renderer produces frames.
TimerMayFire(x) == ~Foreground \/ ~x.dirty

\* runWhenReady's 800ms timeout. A loop that arms its 750ms `scrollend`
\* fallback in the same task as the call has that fallback fire first.
EventSettled(x) == x.nav.k = "end" \/ (x.nav.k = "free" /\ "nav" \notin Fixes)

LibReadyTimeout ==
    /\ w.mounted /\ w.cmd.ph = "wait" /\ w.settling /\ Measurable(w) /\ TimerMayFire(w) /\ Runs(w)
    /\ ~(EventSettled(w) /\ w.nav.ph = "await" /\ w.nav.tok = w.cmd.tok)
    /\ w' = LibRun(w)
    /\ last' = "LibReadyTimeout"
    /\ UNCHANGED <<intent, flags, budget>>

\* finishScrollTo: 100ms after a non-animated write; for an animated scroll
\* at `scrollend` near the target, 80ms idle, or the 1500ms ceiling.
LibFinish ==
    /\ w.mounted /\ TimerMayFire(w)
    /\ \/ w.cmd.ph = "fin"
       \/ w.cmd.ph = "fly" /\ w.smooth = -1
    \* It commits a held adjust against its own target, then re-lays every
    \* row (recalculateSettledScroll); the timeline follows the content height.
    /\ LET x0 == IF w.pend = 0 THEN w
                 ELSE LET t == LibTarget(w) IN [Adjust(w, t) EXCEPT !.pend = 0]
           x1 == ReEstimate(x0, SettledPass(x0, w.cmd.k = "end"))
           x2 == IF x1.sz # x0.sz THEN FollowEndIfPermitted(x1) ELSE x1
       IN w' = Resolve([x2 EXCEPT !.cmd = NoCmd], w.cmd.tok)
    /\ intent' = NavIntent(w, w')
    /\ last' = "LibFinish"
    /\ UNCHANGED <<flags, budget>>

\* A native smooth scroll advances one unit per frame.
SmoothStep ==
    /\ w.mounted /\ w.smooth # -1 /\ Measurable(w) /\ ~(DeferUnderFinger /\ w.finger)
    /\ LET t == Clamp(w, w.smooth)
           s1 == IF t > w.s THEN w.s + 1 ELSE IF t < w.s THEN w.s - 1 ELSE w.s
           done == s1 = t
       IN w' = [w EXCEPT !.s = s1, !.depAt = Tr(w, s1), !.armed = Carry(w, s1), !.mom = TrMom(w, s1), !.lastView = ViewAfterMove(w, s1, FALSE),
                         !.dirty = (s1 # w.s) \/ @,
                         !.smooth = IF done THEN -1 ELSE w.smooth,
                         !.send = IF done THEN HasScrollEnd ELSE @]
    /\ last' = "SmoothStep"
    /\ UNCHANGED <<intent, flags, budget>>

\* The coalesced `scroll` event. LegendList's listener calls the timeline's
\* onScroll (the latch's observeLiveGeometry, then ChatMessages.handleScroll),
\* then the latch's own native listener observes again.
DeliverScroll ==
    /\ w.mounted /\ w.dirty
    \* The list's own listener runs first: a scroll-driven pass.
    /\ LET x1 == ObserveLiveGeometry(ReEstimate(ListSaw([w EXCEPT !.dirty = FALSE,
                                                              !.inputMove = "none"], w.s),
                                                ScrollPass))
           x2 == IF x1.visible /\ Measurable(x1)
                 THEN LET snap == Capture(x1)
                      IN [x1 EXCEPT !.lastVisTop = x1.s,
                                    !.mirror = IF snap.on THEN snap ELSE @]
                 ELSE x1
       IN w' = ObserveLiveGeometry(x2)
    /\ last' = "DeliverScroll"
    /\ UNCHANGED <<intent, flags, budget>>

\* `scrollend`: settles an awaiting free or end loop (awaitScrollSettle).
DeliverScrollEnd ==
    /\ w.mounted /\ w.send /\ ~w.dirty
    /\ LET x1 == [w EXCEPT !.send = FALSE] IN
       w' = IF EventSettled(x1) /\ x1.nav.ph = "await" THEN NavSettle(x1, FALSE) ELSE x1
    /\ intent' = NavIntent(w, w')
    /\ last' = "DeliverScrollEnd"
    /\ UNCHANGED <<flags, budget>>

\* A nested scroller holding the wheel target ends that wheel sequence.
\* Transcript scrollend cannot do this; read publications have no target.
NestedScrollEnd ==
    /\ HasScrollEnd /\ w.mounted /\ "heldgap" \in Fixes
    /\ LET endsWait == w.depAhead /\ w.depWheel
           unblocks == w.armed.src = "gesture" /\ w.armed.blocks /\ w.armed.nested
           x == [w EXCEPT !.depAhead = IF endsWait THEN FALSE ELSE @,
                          !.depWheel = IF endsWait THEN FALSE ELSE @,
                          !.armed.blocks = IF unblocks THEN FALSE ELSE @]
       IN /\ endsWait \/ unblocks
          /\ w' = FollowEndIfPermitted(x)
    \* The reader's gesture was in flight, and the transcript never moves under one.
    \* Without intervening end movement, the nested scroller consumed it and
    \* the transcript keeps its preceding intent. Growth preserves the
    \* position its provisional away intent already names.
    /\ intent' = IF nestedInput.gen = w.rgen /\ ~nestedInput.endMoved
                 THEN nestedInput.prior ELSE intent
    /\ last' = "NestedScrollEnd"
    /\ UNCHANGED <<flags, budget>>

\* awaitScrollSettle's 750ms fallback. The promise loop's 2600ms fallback
\* outlasts the list's whole contract (800ms readiness, then 1500ms) while
\* frames run, so it fires only in the background.
NavFallback ==
    /\ w.mounted /\ w.nav.ph = "await" /\ TimerMayFire(w)
    /\ \/ EventSettled(w) /\ w' = NavSettle(w, FALSE)
       \/ w.nav.k = "free" /\ "nav" \in Fixes /\ ~Foreground /\ w' = NavSettle(w, TRUE)
    /\ intent' = NavIntent(w, w')
    /\ last' = "NavFallback"
    /\ UNCHANGED <<flags, budget>>

\* A promise loop's double-rAF quiet window, then its onSettle.
\* A frame runs its animation callbacks, then layout, then ResizeObserver: a
\* row on screen at one frame is measured before the next frame's callbacks.
\* So the loop's second frame never sees a row it rendered still at its
\* estimate (a row that grew since may still be unmeasured).
FirstMeasurePending(x) ==
    \E i \in x.lo..x.hi : InWindow(x, i) /\ x.sz[i] = EST /\ x.real[i] # EST

RestoreFrame ==
    /\ w.mounted /\ PromiseSettled(w) /\ w.nav.ph \in {"q1", "q2"}
    /\ w.nav.ph = "q2" => ~FirstMeasurePending(w)
    /\ w' = IF w.nav.ph = "q1" THEN [w EXCEPT !.nav.ph = "q2"]
            ELSE IF w.nav.k = "restore" THEN RestoreSettle(w)
            ELSE NavSettle(w, FALSE)
    /\ intent' = NavIntent(w, w')
    /\ last' = "RestoreFrame"
    /\ UNCHANGED <<flags, budget>>

\* An end correction's two-frame validation (scheduleValidation, then
\* validateAndReissue).
CorrFrame ==
    /\ w.mounted /\ w.corr.stage \in {"f1", "f2"}
    /\ w' = IF ~CorrCurrent(w) THEN [w EXCEPT !.corr.stage = "none"]
            ELSE IF w.corr.stage = "f1" THEN [w EXCEPT !.corr.stage = "f2"]
            ELSE LET x1 == ViewRead([w EXCEPT !.corr.stage = "none"]) IN
                 IF "ledgermaint" \in Fixes /\ Unexplained(x1)
                 THEN PublishReadDeparture(x1)
                 ELSE IF ~Measurable(x1) \/ AtBottom(x1) THEN CancelCorr(x1) ELSE CorrIssue(x1)
    /\ last' = "CorrFrame"
    /\ UNCHANGED <<intent, flags, budget>>

(***************************************************************************)
(* The reader on a desktop.                                                *)
(***************************************************************************)
Reading(x) == x.mounted /\ x.visible /\ Measurable(x)

\* A reader's next deliberate input (another wheel, a pick, the pill, a
\* click, a drag, a tab switch) comes after their wheel has scrolled: Chrome
\* lands it within frames, sooner than a person acts again.
ReaderActs(x) == Reading(x) /\ x.wheelPend = 0

\* A wheel's arm (`departsOnGrowth`).
WheelArm(x) == IF x.armed.src = "gesture" THEN [x EXCEPT !.armed.wheel = TRUE] ELSE x

\* A wheel notch (handleWheel): the latch notes the gesture, and the browser
\* scrolls the transcript later (WheelScroll). Chrome's smooth scroll first
\* reports frames after the handler; the model sets no bound on how many,
\* and anything may run between.
\* A wheel up at the very top moves nothing. Here that is only the top of a
\* snapshot whose older rows are still loading, which the model leaves out
\* as placeholders: there the reader is asking for those rows.
Wheel(dir) ==
    /\ HasWheel /\ ReaderActs(w) /\ Can("wheel") /\ ~w.dragging /\ dir \in WheelDirs
    /\ WheelsApart => ~w.dirty
    /\ dir = "away-from-end" => w.s > 0
    /\ LET moves == CanMove(w, dir)
           x0 == WheelArm(NoteReaderGesture(w, dir, TRUE, TRUE))
           \* Fixed ("toward"): handleWheel then runs maintenance. A reader
           \* asking for the end at the strict bottom is there, with no scroll
           \* event to say so; a following one short of it is corrected now.
           x1 == IF "toward" \in Fixes /\ dir = "toward-end"
                 THEN FollowEndIfPermitted(x0) ELSE x0
       IN /\ w' = [x1 EXCEPT !.wheelPend = IF ~moves THEN 0
                                          ELSE IF dir = "toward-end" THEN 1 ELSE -1]
          \* A following reader scrolling toward the end keeps following.
          /\ intent' = IF dir = "toward-end" /\ w.perm THEN Intent("tail", 0, 0)
                       ELSE IntentOf(x1)
    /\ Spend("wheel") /\ last' = "Wheel(" \o dir \o ")"
    /\ UNCHANGED flags

\* The wheel's scroll: one unit, which interrupts a native smooth scroll.
WheelScroll ==
    /\ w.wheelPend # 0 /\ Reading(w)
    /\ LET t == Clamp(w, w.s + w.wheelPend)
           x1 == IF t = w.s THEN [w EXCEPT !.wheelPend = 0]
                 ELSE [w EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1, !.send = HasScrollEnd,
                                !.wheelPend = 0,
                                !.armed = IF @.src = "gesture" THEN [@ EXCEPT !.scrolled = TRUE] ELSE @,
                                \* The reader's own scroll away from the end
                                \* retires the kept initial end target.
                                !.boot = IF @ = "settling" /\ w.wheelPend = -1 THEN "none" ELSE @]
       IN /\ w' = x1
          /\ intent' = IF w.wheelPend = 1 /\ (w.perm \/ ReachedHeadedEnd(x1))
                       THEN Intent("tail", 0, 0)
                       ELSE IF t = w.s THEN intent ELSE IntentOf(x1)
    /\ last' = "WheelScroll"
    /\ UNCHANGED <<flags, budget>>

\* A wheel handleWheel notes as the transcript's that never scrolls it.
WheelNoScroll(dir) ==
    LET armed == WheelArm(NoteReaderGesture(w, dir, TRUE, TRUE))
        x0 == [armed EXCEPT !.armed.nested = armed.armed.src = "gesture"]
    IN IF "toward" \in Fixes /\ dir = "toward-end" THEN FollowEndIfPermitted(x0) ELSE x0

\* A wheel over a nested scroller (a code block, a wide table) that can
\* still scroll that way: the browser scrolls that element. Fixed
\* ("nested"), handleWheel returns before touching latch state. Consume the
\* input budget even on that path so fixed configs exercise nested input.
NestedWheel(dir) ==
    /\ HasWheel /\ ReaderActs(w) /\ Can("nested") /\ ~w.dragging /\ dir \in WheelDirs
    /\ w' = IF "nested" \in Fixes THEN w ELSE WheelNoScroll(dir)
    /\ Spend("nested")
    /\ last' = IF "nested" \in Fixes THEN "NestedWheel(consumed)"
                ELSE "NestedWheel(" \o dir \o ")"
    /\ UNCHANGED <<intent, flags>>

\* A wheel the transcript never scrolls though handleWheel takes it for the
\* transcript's: a descendant cancelled it, or Chrome latched the wheel's
\* sequence to a nested scroller now at its edge (one handleWheel's check
\* sees as unable to take it). The two are one step here.
\* A reader turning it up asks to leave the tail: the nearest the transcript
\* can give is where they are; a following one turning it down asks for the
\* tail, as with any wheel.
UnscrolledWheel(dir) ==
    /\ HasWheel /\ ReaderActs(w) /\ Can("unscrolled") /\ ~w.dragging /\ dir \in WheelDirs
    /\ w' = WheelNoScroll(dir)
    /\ intent' = IF dir = "away-from-end"
                 THEN Intent("at", AnchorRow(w), Pos(w, AnchorRow(w)) - w.s)
                 ELSE IF w.perm THEN Intent("tail", 0, 0) ELSE intent
    /\ Spend("unscrolled") /\ last' = "UnscrolledWheel(" \o dir \o ")"
    /\ UNCHANGED flags

\* The scrollbar: pointerdown on the scroll node, drag, pointerup.
DragStart ==
    /\ HasWheel /\ ReaderActs(w) /\ Can("drag") /\ ~w.dragging
    /\ w' = [TranscriptPointerDown(w, TRUE) EXCEPT !.dragging = TRUE, !.panDir = 0]
    \* A press asks for nothing; the drag's moves do.
    /\ UNCHANGED intent
    /\ Spend("drag") /\ last' = "DragStart"
    /\ UNCHANGED flags

DragMove(dir) ==
    /\ Cycles = 0 /\ w.dragging /\ Reading(w)
    \* A drag reports every frame, and the browser applies the frame's net
    \* movement: no reversal with the last move still unreported (T2).
    /\ w.dirty /\ w.panDir # 0 => w.panDir = IF dir = "toward-end" THEN 1 ELSE -1
    /\ LET t == Clamp(w, IF dir = "toward-end" THEN w.s + 1 ELSE w.s - 1)
           x1 == [w EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1, !.send = HasScrollEnd,
                           !.inputMove = "drag", !.panDir = IF dir = "toward-end" THEN 1 ELSE -1]
       IN /\ t # w.s
          /\ w' = x1
          \* A following reader's drag toward the end keeps following.
          /\ intent' = IF dir = "toward-end" /\ w.perm THEN Intent("tail", 0, 0) ELSE IntentOf(x1)
    /\ last' = "DragMove(" \o dir \o ")"
    /\ UNCHANGED <<flags, budget>>

DragEnd ==
    /\ w.dragging /\ w.mounted
    /\ w' = [CompletePointerPreflight(w) EXCEPT !.dragging = FALSE]
    /\ last' = "DragEnd"
    /\ UNCHANGED <<intent, flags, budget>>

\* A click on a card in a visible row: a pointerdown preflight, then the
\* disclosure changes that row's height.
Click(i) ==
    /\ ReaderActs(w) /\ Can("click") /\ Present(w, i) /\ InWindow(w, i) /\ ~w.dragging
    /\ ~w.finger
    /\ LET x1 == CompletePointerPreflight(TranscriptPointerDown(w, FALSE))
       IN w' = [x1 EXCEPT !.real[i] = IF @ = 1 THEN MaxH ELSE 1]
    \* A click on a card is not the reader moving: they still want the tail,
    \* or the row they scrolled to. It does abandon a pick in flight: a reader
    \* the pick has not moved off the tail still follows; one it has moved is
    \* wherever the view is.
    /\ intent' = IF intent.k # "nav" THEN intent
                 ELSE IF w'.perm THEN Intent("tail", 0, 0) ELSE IntentOf(w')
    /\ Spend("click") /\ last' = "Click"
    /\ UNCHANGED flags

\* A turn-minimap pick: pointerdown inside the transcript container (not the
\* scroll node), then the click navigates.
PickMoves(x, r) == NoOpPicks \/ Clamp(x, Pos(x, r) - NAVOFF) # x.s

Minimap(r) ==
    /\ HasWheel /\ ReaderActs(w) /\ Can("minimap") /\ Present(w, r) /\ ~w.dragging
    /\ PickMoves(w, r)
    /\ w' = NavigateToMessage(TranscriptPointerDown(w, FALSE), r)
    /\ intent' = Intent("nav", r, NAVOFF)
    /\ Spend("minimap") /\ last' = "Minimap"
    /\ UNCHANGED flags

\* The scroll-to-end pill: a pointerdown preflight, then scrollToEnd(true).
Pill ==
    /\ ReaderActs(w) /\ Can("pill") /\ w.pill /\ ~w.dragging /\ ~w.finger
    /\ w' = ScrollToEndNav(TranscriptPointerDown(w, FALSE), TRUE)
    /\ intent' = Intent("tail", 0, 0)
    /\ Spend("pill") /\ last' = "Pill"
    /\ UNCHANGED flags

(***************************************************************************)
(* The reader on a phone.                                                  *)
(***************************************************************************)
\* pointerdown on the row under the finger, then touchstart (handleTouchStart).
TouchStart ==
    /\ TouchInput /\ Reading(w) /\ Can("touch") /\ ~w.finger /\ w.flingDir = 0
    /\ LET x1 == TranscriptPointerDown(w, FALSE)
           x2 == CancelCorr([x1 EXCEPT !.rgen = @ + 1])
           x3 == [x2 EXCEPT !.cand = NoCand, !.mom = NoMom, !.headedEnd = NoHeadedEnd, !.armed = TouchArm(x2.s)]
       IN w' = [SupersedeEnd(x3, x3.s) EXCEPT !.finger = TRUE, !.silent = FALSE, !.panDir = 0]
    \* A seen contact takes control at this geometry, superseding any
    \* preceding fling arrival that no observation has reconciled yet.
    /\ intent' = IntentOf(w')
    /\ Spend("touch") /\ last' = "TouchStart"
    /\ UNCHANGED flags

\* A finger landing on a fling: the fling stops and the page sees no touch or
\* pointer event for this contact at all.
TouchOnFling ==
    /\ TouchInput /\ Reading(w) /\ Can("touch") /\ ~w.finger /\ w.flingDir # 0
    /\ w' = [w EXCEPT !.finger = TRUE, !.silent = TRUE, !.panDir = 0, !.flingDir = 0,
                      !.send = HasScrollEnd]
    /\ intent' = IntentOf(w')
    /\ Spend("touch") /\ last' = "TouchOnFling"
    /\ UNCHANGED flags

\* The native pan moves the view; a delivered touchmove publishes first.
FingerMove(dir) ==
    /\ w.finger /\ Reading(w)
    \* A pan that moves the view fires a scroll event every frame, and the
    \* browser applies a frame's net movement: no reversal with the last move
    \* still unreported.
    /\ w.dirty /\ w.panDir # 0 => w.panDir = IF dir = "toward-end" THEN 1 ELSE -1
    /\ LET x1 == IF TouchMoveDelivered /\ ~w.silent
                 THEN NoteReaderGesture(w, dir, TRUE, TRUE) ELSE w
           t == Clamp(x1, IF dir = "toward-end" THEN x1.s + 1 ELSE x1.s - 1)
           x2 == [x1 EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1, !.inputMove = "finger",
                             !.panDir = IF dir = "toward-end" THEN 1 ELSE -1]
       IN /\ t # w.s
          /\ w' = x2
          \* A following reader's drag toward the end keeps following.
          /\ intent' = IF dir = "toward-end" /\ w.perm THEN Intent("tail", 0, 0) ELSE IntentOf(x2)
    /\ last' = "FingerMove(" \o dir \o ")"
    /\ UNCHANGED <<flags, budget>>

\* The physical lift precedes clearTouch catch-up; later commands announce
\* their writes. Browser assignments never replay unannounced after lift.
TouchEnd(fling) ==
    /\ w.finger /\ w.mounted
    \* A fling carries the finger's last movement on past the lift: a contact
    \* that never moved the view lifts with none.
    /\ fling # 0 => Can("fling") /\ fling = w.panDir
    /\ LET lifted == [w EXCEPT !.finger = FALSE]
           x1 == IF w.silent THEN lifted ELSE ClearTouch(lifted)
           x2 == [x1 EXCEPT !.finger = FALSE, !.silent = FALSE,
                            !.liftLanding = IF ~w.silent /\ x1.touchWriteMayLand THEN TRUE ELSE @,
                            !.touchWriteMayLand = IF ~w.silent THEN FALSE ELSE @]
           x3 == x2
           \* Lifted where it landed: the latch reads a tap, and a following
           \* reader who tapped is still following.
           tap == w.armed.src = "touch" /\ w.s = w.armed.at
       IN /\ w' = [x3 EXCEPT !.flingDir = fling,
                             !.send = IF fling = 0 THEN HasScrollEnd ELSE @]
          \* The lift itself asks for nothing: the reader's intent is where
          \* their finger left it, unless a write held under the finger lands.
          /\ intent' = IF tap /\ x3.perm THEN Intent("tail", 0, 0)
                       ELSE intent
    /\ IF fling # 0 THEN Spend("fling") ELSE UNCHANGED budget
    /\ last' = "TouchEnd"
    /\ UNCHANGED flags

\* A stress input: an app assignment overridden by an active native touch
\* records a mismatch but never queues a browser replay. It is not navigation.
AppWriteEnd ==
    /\ DeferUnderFinger /\ w.finger /\ ~w.perm /\ ~w.dirty /\ Can("appWrite")
    /\ w' = Write(w, MaxS(w))
    /\ Spend("appWrite") /\ last' = "AppWriteEnd"
    /\ UNCHANGED <<intent, flags>>

\* GHOST: the native fling heads for the content that ended the transcript
\* at its lift. This is independent of the production momentum record and
\* survives neither a stopped fling nor a new contact. Tail growth extends
\* below it; growth above that content moves it with the content.
ReachedLiftEnd(x) ==
    LET g == liftEnd
        shift == IF Present(x, g.last) THEN TailBlockTop(x, g.last) - g.lastPos ELSE 0
    IN g.on /\ x.s >= EndOffset(x, g.target, shift)

\* Momentum after a lift: scroll reports with no touch or pointer events.
FlingStep ==
    /\ w.flingDir # 0 /\ Reading(w) /\ ~w.finger
    /\ LET t == Clamp(w, w.s + w.flingDir)
           x1 == [w EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1]
       IN IF t = w.s
          THEN /\ w' = [w EXCEPT !.flingDir = 0, !.send = HasScrollEnd]
               /\ UNCHANGED intent
          ELSE /\ w' = x1
               /\ intent' = IF w.flingDir = 1 /\ ReachedLiftEnd(x1)
                             THEN Intent("tail", 0, 0) ELSE IntentOf(x1)
    /\ last' = "FlingStep"
    /\ UNCHANGED <<flags, budget>>

FlingStop ==
    /\ w.flingDir # 0 /\ w.mounted
    /\ w' = [w EXCEPT !.flingDir = 0, !.send = HasScrollEnd]
    /\ last' = "FlingStop"
    /\ UNCHANGED <<intent, flags, budget>>

\* A pick in the phone tile bar's Messages list: no pointer event reaches
\* the transcript.
PhonePick(r) ==
    /\ TouchInput /\ Reading(w) /\ Can("pick") /\ Present(w, r) /\ ~w.finger
    /\ PickMoves(w, r)
    /\ w' = NavigateToMessage(w, r)
    /\ intent' = Intent("nav", r, NAVOFF)
    /\ Spend("pick") /\ last' = "PhonePick"
    /\ UNCHANGED flags

(***************************************************************************)
(* Hide, show, unmount, remount.                                           *)
(***************************************************************************)
\* The tile is hidden. Collapse (display:none) zeroes the box and resets
\* scrollTop with no scroll event. The visibility effect records the
\* concealed geometry and publishes the last-visible snapshot.
Hide(kind) ==
    \* As for Show: a pending scroll report is dispatched within the frame.
    /\ kind \in HideKinds /\ ReaderActs(w) /\ Can("hide") /\ ~w.finger /\ ~w.dragging
    /\ ~w.dirty
    /\ LET x1 == IF kind = "collapse"
                 THEN [w EXCEPT !.V = 0, !.s = 0, !.smooth = -1, !.flingDir = 0]
                 ELSE w
           x2 == [x1 EXCEPT !.visible = FALSE]
           geo == IF ~Measurable(x2) THEN NoGeo
                  ELSE IF AtBottom(x2) \/ x2.lastVisTop = x2.s THEN [on |-> TRUE, s |-> x2.s]
                  ELSE NoGeo
           x3 == [x2 EXCEPT !.concealed = geo]
           x4 == IF x3.mirror.on THEN [x3 EXCEPT !.store = x3.mirror] ELSE x3
       IN /\ w' = x4
          /\ flags' = [flags EXCEPT !.staleSave =
                         @ \/ (Quiescent(w) /\ ~SnapMatches(x4.store, w))]
    /\ Spend("hide") /\ last' = "Hide(" \o kind \o ")"
    /\ UNCHANGED intent

\* listUndisturbedSinceConcealment
Undisturbed(geo, x, mode) ==
    /\ geo.on /\ Measurable(x)
    /\ IF mode = "follow" THEN AtBottom(x) ELSE x.s = geo.s

\* Shown again: the visibility effect replays the saved state unless the
\* list is exactly where it was left.
Show ==
    \* A scroll report still pending at the hide is dispatched within the
    \* frame; showing the tile again is a later user action.
    /\ w.mounted /\ ~w.visible /\ ~w.dirty
    /\ LET collapsed == ~Measurable(w)
           x1 == [w EXCEPT !.visible = TRUE, !.V = VH, !.ro = @ \/ collapsed]
           x2 == [EndLoop(x1) EXCEPT !.concealed = NoGeo]
           replay == RestoreState(x2.store, x2.lo, x2.hi)
           x3 == IF ~x2.gate /\ Undisturbed(x1.concealed, x2, replay.mode) THEN x2
                 ELSE IF replay.mode = "follow" THEN LibCall(x2, "end", 0, 0, FALSE)
                 ELSE IF replay.anchor = 0 THEN x2
                 ELSE LET r == RestoreIssue([x2 EXCEPT !.gate = TRUE], replay.anchor,
                                            replay.off, "vis", NoFz)
                      IN IF r.r THEN r.w
                         ELSE ReconcileInvalidLanding([r.w EXCEPT !.gate = FALSE,
                                                                  !.pendMeas = NoPend])
       IN w' = x3
    /\ last' = "Show"
    /\ UNCHANGED <<intent, flags, budget>>

\* The tile unmounts (evicted, closed, or its pane torn down) and mounts
\* again from the store. `closing` is a tab close: the tab-key entry is
\* gone, so only the durable copy is written.
Remount(closing) ==
    \* As for Show: a pending scroll report is dispatched within the frame.
    /\ w.mounted /\ Can("remount") /\ ~w.finger /\ ~w.dragging /\ ~w.dirty
    /\ LET x1 == Persist(w, closing)
           x2 == MountState(x1.store, x1.reg, x1.lo, x1.hi, x1.real, x1.rowsVer + 1, x1.tok)
       IN /\ w' = [x2 EXCEPT !.jump = w.jump, !.turn = w.turn]
          /\ flags' = [flags EXCEPT !.staleSave =
                         @ \/ (Quiescent(w) /\ ~SnapMatches(x1.store, w))]
    /\ Spend("remount") /\ last' = IF closing THEN "Remount(close)" ELSE "Remount"
    \* A wheel's scroll still to land goes with the tile: the reader asked
    \* for no more than what the tile showed.
    /\ intent' = IF w.wheelPend # 0 THEN IntentOf(w) ELSE intent

(***************************************************************************)
(* Next.                                                                   *)
(***************************************************************************)
Dirs2 == {"toward-end", "away-from-end"}

\* The reader's own scrolling, which no write announces.
ReaderMoved(l) ==
    \/ l \in {"WheelScroll", "TouchOnFling", "FlingStep"}
    \/ \E d \in Dirs2 : l \in {"DragMove(" \o d \o ")", "FingerMove(" \o d \o ")"}

\* The ledger: a scroll report re-bases it on the view, a reader gesture
\* clears it until the next report, and every announced write moves it by
\* what it moved the view (from the view itself, when that was on the end:
\* the browser may have clamped it there). A view on the end is the
\* browser's clamp. A free reader's gesture clears it too: restspend and
\* the ahead-of-report publication read that null until their report.
\* A remount restarts it on the remounted view.
LedgerNext ==
    led' = LET credited == IF led = -1 THEN -1 ELSE led + w'.viewCredit - w.viewCredit IN
           IF last' = "NestedWheel(consumed)" THEN credited
           ELSE IF last' = "PadCycle" /\ "padannounce" \notin Fixes THEN led
           ELSE IF \/ "ledger" \notin Fixes \/ ~w'.mounted \/ ~w'.visible
              \/ last' \in {"DeliverScroll", "Show", "Remount", "Remount(close)"}
           THEN w'.s
           \* Fixed ("liftledger"): everything up to an announced contact's
           \* lift was the reader's, so the ledger is the view from there.
           ELSE IF last' = "TouchEnd" /\ w'.liftLanding THEN -1
           ELSE IF "liftledger" \in Fixes /\ last' = "TouchEnd" /\ ~w.silent THEN w'.s
           ELSE IF w'.rgen # w.rgen THEN -1
           ELSE IF last' = "ViewportChange" THEN credited
           ELSE IF led = -1 \/ ReaderMoved(last') THEN credited
           ELSE IF AtBottom(w') THEN w'.s
           ELSE (IF AtBottom(w) THEN w.s ELSE credited) + w'.s - w.s

Steps ==
    \/ Grow \/ AboveTailGrow \/ \E k \in {"remount", "recycle", "empty", "unknown-row"} : TailBlockChange(k)
    \/ \E v \in {1, 2, 3} : ViewportChange(v)
    \/ IdleTailShrink \/ IdleTailRegrow \/ AppendRow \/ PrependRow \/ \E i \in Rows : Measure(i) \/ AverageJump
    \/ SettleFrames \/ StructSettle \/ HydrationEffect \/ ResizeObserved
    \/ PadOpen \/ PadReset \/ PadCycle \/ TurnEnd \/ BootSettle \/ Relayout
    \/ LibReady \/ LibReadyTimeout \/ LibFinish \/ SmoothStep
    \/ DeliverScroll \/ DeliverScrollEnd \/ NestedScrollEnd \/ NavFallback \/ RestoreFrame \/ CorrFrame
    \/ \E d \in Dirs2 : Wheel(d) \/ NestedWheel(d) \/ UnscrolledWheel(d)
                       \/ DragMove(d) \/ FingerMove(d)
    \/ WheelScroll
    \/ DragStart \/ DragEnd \/ \E i \in Rows : Click(i)
    \/ \E r \in Rows : Minimap(r) \/ PhonePick(r)
    \/ Pill
    \/ TouchStart \/ TouchOnFling \/ \E f \in {-1, 0, 1} : TouchEnd(f)
    \/ FlingStep \/ FlingStop \/ AppWriteEnd
    \/ \E k \in HideKinds : Hide(k)
    \/ Show
    \/ \E c \in BOOLEAN : Remount(c)

\* GHOST: retain intent before a wheel the transcript never scrolled.
\* A matching nested scrollend later proves where that input went; a newer
\* gesture supersedes the oracle snapshot just as it supersedes the input.
NestedInputNext ==
    nestedInput' = IF last' \in {"UnscrolledWheel(toward-end)", "UnscrolledWheel(away-from-end)",
                                "NestedWheel(toward-end)", "NestedWheel(away-from-end)"}
                   THEN [gen |-> w'.rgen,
                         prior |-> IF nestedInput.gen = w.rgen THEN nestedInput.prior ELSE intent,
                         endMoved |-> (nestedInput.gen = w.rgen /\ nestedInput.endMoved)
                                      \/ MaxS(w') - w'.s > MaxS(w) - w.s]
                   ELSE IF last' = "NestedScrollEnd" \/ w'.rgen # w.rgen
                        THEN [nestedInput EXCEPT !.gen = -1]
                   ELSE IF nestedInput.gen = w.rgen /\ MaxS(w') - w'.s > MaxS(w) - w.s
                        THEN [nestedInput EXCEPT !.endMoved = TRUE] ELSE nestedInput

LiftEndNext ==
    liftEnd' = IF last' = "TouchEnd" /\ w'.flingDir = 1
               THEN [on |-> TRUE, target |-> H(w') + w'.pad, last |-> w'.hi,
                     lastPos |-> TailBlockTop(w', w'.hi)]
               ELSE IF w'.flingDir # 1 THEN NoLiftEnd ELSE liftEnd

\* GHOST: provenance for the accepted missed re-follow prices. This never
\* changes intent or permits an action. New input/navigation or content
\* moving under the reading line ends it; a compensation preserves it.
MissedFollowNext ==
    LET unreadRetired == "unreadsize" \in Fixes
                         /\ ((w.mom.on /\ ~w'.mom.on /\ ~EndShift(w', w.mom).known)
                             \/ (w.cand.on /\ ~w'.cand.on /\ ~EndShift(w', w.cand).known))
        newInput == last' \in {"TouchStart", "TouchOnFling", "DragStart", "Click", "Minimap", "PhonePick", "Pill"}
                    \/ \E d \in Dirs2 : last' \in {"Wheel(" \o d \o ")", "UnscrolledWheel(" \o d \o ")",
                                                         "NestedWheel(" \o d \o ")"}
        row == AnchorRow(w)
        carriedLine == Present(w', row) /\ Pos(w', row) - w'.s = Pos(w, row) - w.s
        reset == newInput \/ w'.nav.k # "none" \/ w'.mounted # w.mounted \/ w'.perm
                 \/ (~ReaderMoved(last') /\ ~carriedLine)
    IN missedFollow' = IF reset THEN "none"
                       ELSE IF unreadRetired THEN "unread-tail"
                       ELSE missedFollow

SilentNext ==
    silent' = IF last' = "TouchOnFling" /\ w'.armed.src # "touch" THEN TRUE
              ELSE IF w'.perm \/ ~w'.turn \/ (last' = "DeliverScroll" /\ w.s # w.depAt)
              THEN FALSE ELSE silent

\* The silent pan's frame: a finger on a fling, with no touch event, moved
\* the view, and the page sees that frame's report before anything else
\* (frame-granularity residue: a write in that window would land over the
\* pan's first movement before any report or read could see it).
SilentPanUnreported(x) == x.silent /\ x.dirty /\ x.panDir # 0
SilentFrame ==
    SilentPanUnreported(w) =>
        last' \in {"DeliverScroll", "FingerMove(toward-end)", "FingerMove(away-from-end)"}

\* Desktop scrollbar movements report before an announced write or a
\* browser clamp can erase them. inputMove outlives pointerup and an arm's
\* retirement; its source keeps this boundary specific to DragMove. The report may then
\* reconcile the view, and further same-direction movements can coalesce.
\* T2's in-flight-write residue and clamp+append's unreported clamp use
\* this same frame boundary; neither depends on a press arm still existing.
DragFrame ==
    (w.inputMove = "drag" /\ w.dirty) =>
        /\ (last' = "DeliverScroll" \/ ReaderMoved(last') \/ w'.s = w.s)
        /\ ~(MaxS(w') < MaxS(w) /\ MaxS(w') <= w.s)

SilentMomentumFrame ==
    ~(silent /\ ~w.perm /\ w.mom.on /\ MomArrived(w)
      /\ ~AtBottom(w) /\ w'.perm)

Next == Steps /\ LedgerNext /\ NestedInputNext /\ LiftEndNext /\ SilentNext /\ SilentFrame /\ DragFrame
        /\ SilentMomentumFrame /\ MissedFollowNext

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants. Each is a symptom a reader would report.                    *)
(***************************************************************************)
TypeOK ==
    /\ w.s >= 0
    /\ missedFollow \in {"none", "unread-tail"}
    /\ w.depWheel \in BOOLEAN
    /\ w.inputMove \in {"none", "drag", "finger"}
    /\ w.depOwed \in BOOLEAN
    /\ w.lastView.on \in BOOLEAN
    /\ w.viewCredit \in Int
    /\ led \in Nat \cup {-1}
    /\ w.mode \in {"follow", "free"}
    /\ w.armed.src \in {"none", "gesture", "owned", "touch"}
    /\ w.nav.k \in {"none", "free", "end", "restore"}
    /\ w.nav.ph \in {"none", "await", "q1", "q2", "trail"}
    /\ w.cmd.k \in {"none", "end", "offset", "index"}
    /\ w.est \in {EST, REST}
    /\ w.wheelPend \in {-1, 0, 1}
    /\ w.pad \in {0, 2}
    /\ w.boot \in {"none", "settling", "kept"}

\* "It does not stay where I put it": at rest, the transcript shows the tail
\* the reader asked for, the row they scrolled to, or the row they picked.
\* Only a tagged unread-end retirement may miss the tail. Reading-position
\* and navigation failures, and tail failures without this history, still
\* fail I_IntentHeld. The separate price invariant keeps the witnesses live.
KnownMissedFollow(x) ==
    /\ missedFollow = "unread-tail"
    /\ intent.k = "tail" /\ ~x.perm /\ x.mode = "free" /\ x.pill /\ ~AtBottom(x)
I_IntentHeld == Quiescent(w) => (IntentHeld(w) \/ KnownMissedFollow(w))
I_MissedFollowPrice == ~(Quiescent(w) /\ KnownMissedFollow(w))

\* "It does not keep my place": at rest with the whole transcript loaded, the
\* reading position is being saved (neither restore gate is stuck armed).
I_SavingLive == (Quiescent(w) /\ w.lo = 1) => (~w.gate /\ w.pendHyd = 0)

\* "Coming back puts me somewhere else": a hide or unmount from rest saved
\* exactly what the reader was looking at.
I_SavedIsView == ~flags.staleSave

\* The latch and the controller agree with the geometry at rest: following
\* means at the tail (else the next token yanks), free means not at the tail
\* (else new content does not follow and the pill shows with nowhere to go).
\* One exception, the owner's: while the turn streams, a free reader the end
\* came to (they did not ask for the tail) is free at the strict bottom,
\* with the pill. And a free reader's wheel the strict bottom absorbs (no
\* scroll, so no report) leaves its arm waiting, turn or no turn: they stay
\* free at the strict bottom, with the pill, until their next input.
AbsorbedWheel(x) ==
    /\ x.armed.src = "gesture" /\ x.armed.blocks /\ x.armed.wheel /\ x.wheelPend = 0
    /\ ~x.armed.scrolled
\* And the R2 residue translate exposes: a silent contact's excursion that no
\* report saw, back to where the reader departed, is at every observation
\* the end coming up to a reader who held still: held, with the pill, until
\* the turn rests (M2's price).
SilentReturn(x) == x.turn /\ silent
EndCameIdle(x) ==
    /\ "idlehold" \in Fixes /\ "rawidle" \notin Fixes
    /\ ~x.turn /\ intent.k = "at" /\ x.depAt # -1 /\ x.s <= x.depAt

EndCameToFree(x) ==
    /\ ~x.perm /\ x.mode = "free" /\ x.pill /\ AtBottom(x)
    /\ (x.turn /\ intent.k # "tail") \/ AbsorbedWheel(x) \/ SilentReturn(x) \/ EndCameIdle(x)
I_ModeMatchesGeometry ==
    Quiescent(w) => (((w.mode = "follow") = AtBottom(w)) \/ EndCameToFree(w))
I_PillHonest == Quiescent(w) => ((w.pill = ~AtBottom(w)) \/ EndCameToFree(w))

\* "It jumped": the line at the top of the view moved with no scroll, pick
\* or follow of the reader's - the list re-laid rows above it unanchored, or
\* wrote back a scroll it had not seen yet.
I_NoJump == ~w.jump

=============================================================================
