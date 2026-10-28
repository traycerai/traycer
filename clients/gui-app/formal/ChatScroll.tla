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
                        \*   "paint", "supersede", "arrive"}: the fixes modelled
                        \*   ({} is the code before them, see README.md)
    \* Budgets
    Grows, Appends, Prepends, Wheels, Drags, Clicks, Touches, Flings,
    Minimaps, PhonePicks, Pills, Hides, Remounts

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
NoArm == [src |-> "none", dir |-> "indeterminate", blocks |-> FALSE, at |-> 0]
OwnedArm == [src |-> "owned", dir |-> "indeterminate", blocks |-> TRUE, at |-> 0]
TouchArm(at) == [src |-> "touch", dir |-> "indeterminate", blocks |-> TRUE, at |-> at]
NoCorr == [on |-> FALSE, gen |-> 0, rgen |-> 0, att |-> 0, stage |-> "none"]
NoCand == [on |-> FALSE, rgen |-> 0, target |-> 0, arr |-> FALSE, last |-> 0, lastPos |-> 0]
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
Intent(k, row, off) == [k |-> k, row |-> row, off |-> off]

VARIABLES
    w,          \* the tile, its list, its scroll node, and the two stores
                \*   that outlive a mount (`store`, `reg`)
    intent,     \* GHOST: where the reader last put the transcript
    flags,      \* GHOST: violations an action detected when it ran
    budget,     \* remaining environment events
    last        \* GHOST: the last action, for reading traces

vars == <<w, intent, flags, budget, last>>

(***************************************************************************)
(* Geometry over the list's believed sizes.                                *)
(***************************************************************************)
RECURSIVE SumSz(_, _, _)
SumSz(f, a, b) == IF a > b THEN 0 ELSE f[a] + SumSz(f, a + 1, b)

Pos(x, i) == SumSz(x.sz, x.lo, i - 1)
H(x) == SumSz(x.sz, x.lo, x.hi)
MaxS(x) == Max(0, H(x) - VH)
Clamp(x, t) == Max(0, Min(t, MaxS(x)))
Measurable(x) == x.V > 0
AtBottom(x) == Measurable(x) /\ x.s >= MaxS(x)
Present(x, i) == i >= x.lo /\ i <= x.hi
\* The row under the reading line (viewportAnchorRowKey).
AnchorRow(x) ==
    CHOOSE i \in x.lo..x.hi : Pos(x, i) <= x.s /\ (i = x.hi \/ Pos(x, i + 1) > x.s)
\* The rows the list has mounted: the viewport plus a unit of buffer.
InWindow(x, i) == Pos(x, i) < x.s + VH + 1 /\ Pos(x, i) + x.sz[i] > x.s - 1
View(x) ==
    IF AtBottom(x) THEN [tail |-> TRUE, row |-> 0, off |-> 0]
    ELSE [tail |-> FALSE, row |-> AnchorRow(x), off |-> Pos(x, AnchorRow(x)) - x.s]

(***************************************************************************)
(* The scroll node. A programmatic write cancels a native smooth scroll    *)
(* and ends in `scrollend`. Under a finger on iOS it is held until lift.   *)
(***************************************************************************)
Write(x, t) ==
    IF DeferUnderFinger /\ x.finger THEN [x EXCEPT !.deferred = t]
    ELSE IF t = x.s THEN [x EXCEPT !.smooth = -1]
    ELSE [x EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1, !.send = HasScrollEnd]

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
    ELSE [Write(x, t) EXCEPT !.cmd.ph = "fin"]

LibCall(x, kind, row, off, anim) ==
    LET t == x.tok + 1
        x1 == Resolve([x EXCEPT !.tok = t], x.cmd.tok)
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

ArmBlocks(a) ==
    IF a.src = "none" THEN FALSE ELSE IF a.src = "gesture" THEN a.blocks ELSE TRUE

\* supersedePendingEndCorrection. Before the fix it issues scrollToOffset at
\* the offset read in the gesture's handler; the list defers that command
\* while it settles and later writes the stale offset. Fixed, it cancels the
\* queued command and writes nothing. A pending end correction is always the
\* list's current command: any newer call resolves it.
SupersedeEnd(x, offset) ==
    IF x.pendEnd = 0 THEN x
    ELSE IF "supersede" \in Fixes
    THEN [Resolve([x EXCEPT !.tok = @ + 1, !.pendEnd = 0], x.cmd.tok) EXCEPT !.cmd = NoCmd]
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
RECURSIVE LatchSetIntent(_, _), OnIntentChange(_, _), SetTimelineMode(_, _, _),
          SetFollowingEndFromPosition(_)

\* setFollowIntent
LatchSetIntent(x, b) ==
    LET x1 == IF ~b THEN CancelCorr(x) ELSE x IN
    IF x1.perm = b THEN x1
    ELSE OnIntentChange([x1 EXCEPT !.armed = IF x1.armed.src = "touch" THEN @ ELSE NoArm,
                                   !.perm = b], b)

\* onFollowIntentChange
OnIntentChange(x, b) ==
    IF x.atEnd = b /\ ((x.mode = "follow") = b) THEN x
    ELSE IF b THEN SetFollowingEndFromPosition(x)
    ELSE [SetTimelineMode(x, "free", TRUE) EXCEPT !.pill = TRUE]

\* setTimelineMode
SetTimelineMode(x, next, release) ==
    LET x1 == LatchSetIntent(x, next = "follow")
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
    ELSE LET x0 == IF "paint" \in Fixes THEN Write(x, MaxS(x)) ELSE x
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
HandleReaderGesture(x, freeze, publishes) ==
    LET hadAnim == x.animOp
        keepsRestore == "restore" \in Fixes /\ ~publishes /\ x.nav.k = "restore"
        x1 == [x EXCEPT !.animOp = FALSE, !.navGen = IF keepsRestore THEN @ ELSE @ + 1,
                        !.pendMeas = IF publishes \/ (x.pendHyd = 0 /\ "restore" \notin Fixes)
                                     THEN NoPend ELSE @]
        x2 == IF publishes THEN [ClearHydration(x1) EXCEPT !.gate = FALSE] ELSE x1
        \* Fixed ("cancel"): the restore or navigation this input ends may
        \* still have a command queued in the list, its own or the latch's
        \* supersede write just before this handler; it is retired, unrun.
        x3 == IF /\ "cancel" \in Fixes /\ publishes /\ x2.nav.k # "none"
                 /\ x2.cmd.k # "none" /\ x2.cmd.ph = "wait"
              THEN [Resolve([x2 EXCEPT !.tok = @ + 1], x2.cmd.tok) EXCEPT !.cmd = NoCmd]
              ELSE x2
    IN IF freeze /\ hadAnim THEN LibCall(x3, "offset", 0, x3.s, FALSE) ELSE x3

\* noteReaderGesture
NoteReaderGesture(x, dir, freeze, publishes) ==
    LET x1 == CancelCorr([x EXCEPT !.rgen = @ + 1])
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
                    THEN [src |-> "gesture", dir |-> dir, blocks |-> blocks, at |-> 0]
                    ELSE NoArm
        cand == IF dir = "toward-end" /\ arm.src # "touch" /\ meas
                THEN [on |-> TRUE, rgen |-> x1.rgen, target |-> MaxS(x1), arr |-> FALSE,
                      last |-> x1.hi, lastPos |-> Pos(x1, x1.hi)]
                ELSE NoCand
        x2 == [x1 EXCEPT !.armed = arm, !.cand = cand]
        x3 == IF publishes /\ blocks /\ meas /\ ~cont THEN SupersedeEnd(x2, x2.s) ELSE x2
    IN HandleReaderGesture(x3, freeze, publishes)

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
       ELSE LET x3 == IF ad.src = "gesture" /\ (~ad.blocks \/ native)
                      THEN [x2 EXCEPT !.armed = NoArm] ELSE x2
                supp == CorrSuppressed(x3)
                res == IF supp THEN ResolveSuppressedEndLanding(x3) ELSE [w |-> x3, r |-> FALSE]
            IN LatchSetIntent(res.w, ~supp \/ res.r)

\* Fixed ("reach"): the end the gesture headed for is the content that ended
\* the transcript then, so it moves down with every row that grows above that
\* last row. The list compensates such growth by moving the offset, which
\* alone cannot reach it now.
TryReattach(x) ==
    LET c == x.cand
        shift == IF "reach" \in Fixes /\ Present(x, c.last) THEN Pos(x, c.last) - c.lastPos ELSE 0
        reached == c.on /\ c.rgen = x.rgen /\ x.s >= c.target + shift
    IN IF ~reached \/ CorrSuppressed(x) THEN [w |-> x, r |-> FALSE]
       ELSE [w |-> StartEndCorrection(LatchSetIntent([x EXCEPT !.cand = NoCand], TRUE)),
             r |-> TRUE]

PublishArmedDeparture(x, a) ==
    CASE a.src = "touch" ->
            IF x.s = a.at THEN [w |-> x, r |-> FALSE]
            ELSE [w |-> HandleReaderGesture(SupersedeEnd(x, x.s), TRUE, TRUE), r |-> TRUE]
      [] a.src = "gesture" -> [w |-> SupersedeEnd(x, x.s), r |-> TRUE]
      [] OTHER -> [w |-> x, r |-> TRUE]

ObserveLiveGeometry(x) ==
    IF ~x.mounted \/ ~Measurable(x) THEN x
    ELSE IF AtBottom(x) THEN ReconcileStrictBottom(x, TRUE, x.s)
    ELSE IF x.corr.on /\ x.corr.rgen = x.rgen THEN x
    ELSE LET ra == TryReattach(x) IN
         IF ra.r THEN ra.w
         \* Fixed ("restore"): a free reader's finger that moved the view is the
         \* reader's position too; published once, while a restore still holds
         \* the saved coordinate (iOS delivers no touchmove to publish it).
         ELSE IF ~x.perm
         THEN IF /\ "restore" \in Fixes /\ x.armed.src = "touch"
                 /\ x.s # x.armed.at /\ CorrSuppressed(x)
              THEN PublishArmedDeparture(x, x.armed).w
              ELSE x
         ELSE IF x.armed.src # "none"
              THEN LET pd == PublishArmedDeparture(x, x.armed) IN
                   IF ~pd.r THEN pd.w
                   ELSE LatchSetIntent(IF x.armed.src # "touch"
                                       THEN [pd.w EXCEPT !.armed = NoArm] ELSE pd.w,
                                       FALSE)
         ELSE IF CorrSuppressed(x) THEN x ELSE StartEndCorrection(x)

FollowEndIfPermitted(x) ==
    IF ~x.mounted \/ ~Measurable(x) THEN x
    ELSE IF AtBottom(x)
         THEN IF CorrSuppressed(x) THEN CancelCorr(x)
              ELSE IF ~x.perm /\ ReattachSuppressed(x)
                   THEN [CancelCorr(x) EXCEPT !.cand = Arrived(x)]
              ELSE ReconcileStrictBottom(x, FALSE, x.s)
    \* Fixed ("arrive"): the suppression has lifted, and the reader reached
    \* the end they asked for while it held: they follow from here.
    ELSE IF /\ ~x.perm /\ x.cand.arr /\ x.cand.rgen = x.rgen
            /\ ~CorrSuppressed(x) /\ ~ReattachSuppressed(x)
         THEN StartEndCorrection(LatchSetIntent([x EXCEPT !.cand = NoCand], TRUE))
    ELSE IF ~x.perm \/ CorrSuppressed(x) \/ ArmBlocks(x.armed) THEN x
    ELSE StartEndCorrection(x)

\* beginOwnedEndNavigation / beginOwnedFreeNavigation and their completions
BeginOwnedEnd(x) == NewCorr(LatchSetIntent([x EXCEPT !.armed = NoArm], TRUE))
BeginOwnedFree(x) == [CancelCorr(x) EXCEPT !.cand = NoCand, !.armed = OwnedArm]
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
         ELSE LatchSetIntent(x1, FALSE)
CompleteOwnedEnd(x, landed) == LatchSetIntent(CancelCorr(x), landed)

\* The touch lift (clearTouch).
ClearTouch(x) ==
    IF x.armed.src # "touch" THEN FollowEndIfPermitted(x)
    ELSE LET a == x.armed
             x1 == IF x.perm /\ Measurable(x) /\ ~AtBottom(x) /\ x.s # a.at
                   THEN ObserveLiveGeometry(x) ELSE x
         IN FollowEndIfPermitted([x1 EXCEPT !.armed = NoArm])

\* completePointerPreflight (pointerup / pointercancel on the scroll node)
CompletePointerPreflight(x) ==
    IF x.armed.src = "gesture" /\ x.armed.dir = "indeterminate"
    THEN IF Measurable(x) /\ ~AtBottom(x) THEN ObserveLiveGeometry(x)
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
            mounted |-> TRUE, lo |-> lo, hi |-> hi, real |-> real,
            sz |-> [i \in Rows |-> EST], s |-> 0, V |-> VH, visible |-> TRUE,
            dirty |-> FALSE, send |-> FALSE, smooth |-> -1, finger |-> FALSE,
            silent |-> FALSE, deferred |-> -1, flingDir |-> 0, dragging |-> FALSE,
            ro |-> TRUE, settling |-> FALSE, structUnsettled |-> FALSE,
            tok |-> tok, cmd |-> NoCmd,
            perm |-> follow, armed |-> NoArm, rgen |-> 0, cgen |-> 0, corr |-> NoCorr,
            pendEnd |-> 0, cand |-> NoCand,
            mode |-> IF follow THEN "follow" ELSE "free", atEnd |-> follow,
            pill |-> ~follow, navGen |-> 0,
            gate |-> raw.on /\ raw.mode # "follow" /\ raw.anchor # 0,
            pendHyd |-> pendHyd, pendMeas |-> pendMeas, resolveEnd |-> NoFz,
            nav |-> NoNav, animOp |-> FALSE, mirror |-> NoSnap, lastVisTop |-> -1,
            concealed |-> NoGeo, hydFx |-> TRUE, rowsVer |-> rowsVer, raw |-> raw,
            store |-> store, reg |-> reg]
        b0 == [base EXCEPT !.s = IF follow THEN MaxS(base)
                                 ELSE IF pendMeas.on
                                      THEN Clamp(base, Pos(base, pendMeas.row) - pendMeas.off)
                                      ELSE 0]
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
    /\ x.nav.k = "none" /\ x.corr.stage = "none" /\ x.cmd.k = "none"
    /\ x.smooth = -1 /\ ~x.dirty /\ ~x.send /\ ~x.ro /\ ~x.hydFx
    /\ ~x.settling /\ ~x.structUnsettled
    /\ ~x.finger /\ x.flingDir = 0 /\ ~x.dragging /\ x.deferred = -1
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
    /\ budget = [grow |-> Grows, append |-> Appends, prepend |-> Prepends,
                 wheel |-> Wheels, drag |-> Drags, click |-> Clicks, touch |-> Touches,
                 fling |-> Flings, minimap |-> Minimaps, pick |-> PhonePicks,
                 pill |-> Pills, hide |-> Hides, remount |-> Remounts]
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
    /\ w.mounted /\ Can("grow") /\ w.real[w.hi] < MaxH
    /\ LET x1 == [w EXCEPT !.real[w.hi] = @ + 1, !.rowsVer = @ + 1, !.hydFx = TRUE]
       IN w' = FollowEndIfPermitted(x1)
    /\ Spend("grow") /\ last' = "Grow"
    /\ UNCHANGED <<intent, flags>>

\* A new row at the end: a key-sequence change (MVCP data channel, and the
\* timeline's structural settle holds reattach until layout is still).
AppendRow ==
    /\ w.mounted /\ Can("append") /\ w.hi < R
    /\ LET x1 == [w EXCEPT !.hi = @ + 1, !.rowsVer = @ + 1, !.settling = TRUE,
                           !.hydFx = TRUE, !.structUnsettled = TRUE]
       IN w' = FollowEndIfPermitted(x1)
    /\ Spend("append") /\ last' = "AppendRow"
    /\ UNCHANGED <<intent, flags>>

\* An older row arrives above (a snapshot that grows after mount). MVCP's
\* data channel keeps the visible rows still.
PrependRow ==
    /\ w.mounted /\ Can("prepend") /\ w.lo > 1
    /\ LET x1 == [w EXCEPT !.lo = @ - 1, !.rowsVer = @ + 1, !.settling = TRUE,
                           !.hydFx = TRUE, !.structUnsettled = TRUE]
           x2 == IF Measurable(x1) THEN [x1 EXCEPT !.s = @ + x1.sz[w.lo - 1]] ELSE x1
       IN w' = FollowEndIfPermitted(x2)
    /\ Spend("prepend") /\ last' = "PrependRow"
    /\ UNCHANGED <<intent, flags>>

\* The list measures a mounted row (onItemSizeChanged). MVCP's size channel
\* keeps the first visible row still when a row above it changes; the
\* browser clamps scrollTop when content shrinks below it. Then the
\* timeline's size callback calls followEndIfPermitted.
Measure(i) ==
    /\ w.mounted /\ Measurable(w) /\ Present(w, i) /\ InWindow(w, i)
    /\ w.sz[i] # w.real[i]
    /\ LET d == w.real[i] - w.sz[i]
           above == i < AnchorRow(w)
           x1 == [w EXCEPT !.sz[i] = w.real[i]]
           want == IF above THEN w.s + d ELSE w.s
           t == Clamp(x1, want)
           x2 == IF t = w.s THEN x1
                 ELSE [x1 EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1, !.send = HasScrollEnd]
       IN /\ w' = FollowEndIfPermitted(x2)
          \* A transcript that shrank below the reader brings them to its end,
          \* clamped or landing on it exactly: they are at the tail now, which
          \* the latch follows by design.
          /\ intent' = IF intent.k = "at" /\ AtBottom(x2) /\ ~AtBottom(w)
                       THEN Intent("tail", 0, 0) ELSE intent
    /\ last' = "Measure"
    /\ UNCHANGED <<flags, budget>>

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
    /\ w.mounted /\ w.cmd.ph = "wait" /\ ~w.settling /\ Measurable(w)
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
    /\ w.mounted /\ w.cmd.ph = "wait" /\ w.settling /\ Measurable(w) /\ TimerMayFire(w)
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
    /\ w' = Resolve([w EXCEPT !.cmd = NoCmd], w.cmd.tok)
    /\ intent' = NavIntent(w, w')
    /\ last' = "LibFinish"
    /\ UNCHANGED <<flags, budget>>

\* A native smooth scroll advances one unit per frame.
SmoothStep ==
    /\ w.mounted /\ w.smooth # -1 /\ Measurable(w) /\ ~(DeferUnderFinger /\ w.finger)
    /\ LET t == Clamp(w, w.smooth)
           s1 == IF t > w.s THEN w.s + 1 ELSE IF t < w.s THEN w.s - 1 ELSE w.s
           done == s1 = t
       IN w' = [w EXCEPT !.s = s1, !.dirty = (s1 # w.s) \/ @,
                         !.smooth = IF done THEN -1 ELSE w.smooth,
                         !.send = IF done THEN HasScrollEnd ELSE @]
    /\ last' = "SmoothStep"
    /\ UNCHANGED <<intent, flags, budget>>

\* The coalesced `scroll` event. LegendList's listener calls the timeline's
\* onScroll (the latch's observeLiveGeometry, then ChatMessages.handleScroll),
\* then the latch's own native listener observes again.
DeliverScroll ==
    /\ w.mounted /\ w.dirty
    /\ LET x1 == ObserveLiveGeometry([w EXCEPT !.dirty = FALSE])
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
            ELSE LET x1 == [w EXCEPT !.corr.stage = "none"] IN
                 IF ~Measurable(x1) \/ AtBottom(x1) THEN CancelCorr(x1) ELSE CorrIssue(x1)
    /\ last' = "CorrFrame"
    /\ UNCHANGED <<intent, flags, budget>>

(***************************************************************************)
(* The reader on a desktop.                                                *)
(***************************************************************************)
Reading(x) == x.mounted /\ x.visible /\ Measurable(x)

\* A wheel notch (handleWheel), then the browser scrolls one unit; a reader
\* scroll interrupts a native smooth scroll.
\* A wheel up at the very top moves nothing. Here that is only the top of a
\* snapshot whose older rows are still loading, which the model leaves out
\* as placeholders: there the reader is asking for those rows.
Wheel(dir) ==
    /\ HasWheel /\ Reading(w) /\ Can("wheel") /\ ~w.dragging
    /\ dir = "away-from-end" => w.s > 0
    /\ LET x0 == NoteReaderGesture(w, dir, TRUE, TRUE)
           \* Fixed ("toward"): handleWheel then runs maintenance. A reader
           \* asking for the end at the strict bottom is there, with no scroll
           \* event to say so; a following one short of it is corrected now.
           x1 == IF "toward" \in Fixes /\ dir = "toward-end"
                 THEN FollowEndIfPermitted(x0) ELSE x0
           t == Clamp(x1, IF dir = "toward-end" THEN x1.s + 1 ELSE x1.s - 1)
           x2 == IF t = x1.s THEN [x1 EXCEPT !.smooth = -1]
                 ELSE [x1 EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1, !.send = HasScrollEnd]
       IN /\ w' = x2
          \* A following reader scrolling toward the end keeps following.
          /\ intent' = IF dir = "toward-end" /\ w.perm THEN Intent("tail", 0, 0)
                       ELSE IntentOf(x2)
    /\ Spend("wheel") /\ last' = "Wheel(" \o dir \o ")"
    /\ UNCHANGED flags

\* The scrollbar: pointerdown on the scroll node, drag, pointerup.
DragStart ==
    /\ HasWheel /\ Reading(w) /\ Can("drag") /\ ~w.dragging
    /\ w' = [TranscriptPointerDown(w, TRUE) EXCEPT !.dragging = TRUE]
    /\ intent' = IntentOf(w')
    /\ Spend("drag") /\ last' = "DragStart"
    /\ UNCHANGED flags

DragMove(dir) ==
    /\ w.dragging /\ Reading(w)
    /\ LET t == Clamp(w, IF dir = "toward-end" THEN w.s + 1 ELSE w.s - 1)
           x1 == [w EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1, !.send = HasScrollEnd]
       IN /\ t # w.s
          /\ w' = x1
          /\ intent' = IntentOf(x1)
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
    /\ Reading(w) /\ Can("click") /\ Present(w, i) /\ InWindow(w, i) /\ ~w.dragging
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
    /\ HasWheel /\ Reading(w) /\ Can("minimap") /\ Present(w, r) /\ ~w.dragging
    /\ PickMoves(w, r)
    /\ w' = NavigateToMessage(TranscriptPointerDown(w, FALSE), r)
    /\ intent' = Intent("nav", r, NAVOFF)
    /\ Spend("minimap") /\ last' = "Minimap"
    /\ UNCHANGED flags

\* The scroll-to-end pill: a pointerdown preflight, then scrollToEnd(true).
Pill ==
    /\ Reading(w) /\ Can("pill") /\ w.pill /\ ~w.dragging /\ ~w.finger
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
           x3 == [x2 EXCEPT !.cand = NoCand, !.armed = TouchArm(x2.s)]
       IN w' = [SupersedeEnd(x3, x3.s) EXCEPT !.finger = TRUE, !.silent = FALSE]
    \* A finger landing is not the reader moving (`FingerMove` is): like a
    \* click, it keeps their intent and only abandons a pick in flight.
    /\ intent' = IF intent.k # "nav" THEN intent
                 ELSE IF w'.perm THEN Intent("tail", 0, 0) ELSE IntentOf(w')
    /\ Spend("touch") /\ last' = "TouchStart"
    /\ UNCHANGED flags

\* A finger landing on a fling: the fling stops and the page sees no touch or
\* pointer event for this contact at all.
TouchOnFling ==
    /\ TouchInput /\ Reading(w) /\ Can("touch") /\ ~w.finger /\ w.flingDir # 0
    /\ w' = [w EXCEPT !.finger = TRUE, !.silent = TRUE, !.flingDir = 0,
                      !.send = HasScrollEnd]
    /\ intent' = IntentOf(w')
    /\ Spend("touch") /\ last' = "TouchOnFling"
    /\ UNCHANGED flags

\* The native pan moves the view; a delivered touchmove publishes first.
FingerMove(dir) ==
    /\ w.finger /\ Reading(w)
    /\ LET x1 == IF TouchMoveDelivered /\ ~w.silent
                 THEN NoteReaderGesture(w, dir, TRUE, TRUE) ELSE w
           t == Clamp(x1, IF dir = "toward-end" THEN x1.s + 1 ELSE x1.s - 1)
           x2 == [x1 EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1]
       IN /\ t # w.s
          /\ w' = x2
          /\ intent' = IntentOf(x2)
    /\ last' = "FingerMove(" \o dir \o ")"
    /\ UNCHANGED <<flags, budget>>

\* The lift (clearTouch), then a write iOS held lands, then maybe a fling.
TouchEnd(fling) ==
    /\ w.finger /\ w.mounted
    /\ fling # 0 => Can("fling")
    /\ LET x1 == IF w.silent THEN w ELSE ClearTouch(w)
           x2 == [x1 EXCEPT !.finger = FALSE, !.silent = FALSE]
           x3 == IF x2.deferred # -1
                 THEN Write([x2 EXCEPT !.deferred = -1], Clamp(x2, x2.deferred)) ELSE x2
           \* Lifted where it landed: the latch reads a tap, and a following
           \* reader who tapped is still following.
           tap == w.armed.src = "touch" /\ w.s = w.armed.at
       IN /\ w' = [x3 EXCEPT !.flingDir = fling,
                             !.send = IF fling = 0 THEN HasScrollEnd ELSE @]
          /\ intent' = IF tap /\ x3.perm THEN Intent("tail", 0, 0) ELSE IntentOf(x3)
    /\ IF fling # 0 THEN Spend("fling") ELSE UNCHANGED budget
    /\ last' = "TouchEnd"
    /\ UNCHANGED flags

\* Momentum after a lift: scroll reports with no touch or pointer events.
FlingStep ==
    /\ w.flingDir # 0 /\ Reading(w) /\ ~w.finger
    /\ LET t == Clamp(w, w.s + w.flingDir)
           x1 == [w EXCEPT !.s = t, !.dirty = TRUE, !.smooth = -1]
       IN IF t = w.s
          THEN /\ w' = [w EXCEPT !.flingDir = 0, !.send = HasScrollEnd]
               /\ UNCHANGED intent
          ELSE /\ w' = x1
               /\ intent' = IntentOf(x1)
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
    /\ kind \in HideKinds /\ Reading(w) /\ Can("hide") /\ ~w.finger /\ ~w.dragging
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
       IN /\ w' = x2
          /\ flags' = [flags EXCEPT !.staleSave =
                         @ \/ (Quiescent(w) /\ ~SnapMatches(x1.store, w))]
    /\ Spend("remount") /\ last' = IF closing THEN "Remount(close)" ELSE "Remount"
    /\ UNCHANGED intent

(***************************************************************************)
(* Next.                                                                   *)
(***************************************************************************)
Dirs2 == {"toward-end", "away-from-end"}

Next ==
    \/ Grow \/ AppendRow \/ PrependRow \/ \E i \in Rows : Measure(i)
    \/ SettleFrames \/ StructSettle \/ HydrationEffect \/ ResizeObserved
    \/ LibReady \/ LibReadyTimeout \/ LibFinish \/ SmoothStep
    \/ DeliverScroll \/ DeliverScrollEnd \/ NavFallback \/ RestoreFrame \/ CorrFrame
    \/ \E d \in Dirs2 : Wheel(d) \/ DragMove(d) \/ FingerMove(d)
    \/ DragStart \/ DragEnd \/ \E i \in Rows : Click(i)
    \/ \E r \in Rows : Minimap(r) \/ PhonePick(r)
    \/ Pill
    \/ TouchStart \/ TouchOnFling \/ \E f \in {-1, 0, 1} : TouchEnd(f)
    \/ FlingStep \/ FlingStop
    \/ \E k \in HideKinds : Hide(k)
    \/ Show
    \/ \E c \in BOOLEAN : Remount(c)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants. Each is a symptom a reader would report.                    *)
(***************************************************************************)
TypeOK ==
    /\ w.s >= 0
    /\ w.mode \in {"follow", "free"}
    /\ w.armed.src \in {"none", "gesture", "owned", "touch"}
    /\ w.nav.k \in {"none", "free", "end", "restore"}
    /\ w.nav.ph \in {"none", "await", "q1", "q2", "trail"}
    /\ w.cmd.k \in {"none", "end", "offset", "index"}

\* "It does not stay where I put it": at rest, the transcript shows the tail
\* the reader asked for, the row they scrolled to, or the row they picked.
I_IntentHeld == Quiescent(w) => IntentHeld(w)

\* "It does not keep my place": at rest with the whole transcript loaded, the
\* reading position is being saved (neither restore gate is stuck armed).
I_SavingLive == (Quiescent(w) /\ w.lo = 1) => (~w.gate /\ w.pendHyd = 0)

\* "Coming back puts me somewhere else": a hide or unmount from rest saved
\* exactly what the reader was looking at.
I_SavedIsView == ~flags.staleSave

\* The latch and the controller agree with the geometry at rest: following
\* means at the tail (else the next token yanks), free means not at the tail
\* (else new content does not follow and the pill shows with nowhere to go).
I_ModeMatchesGeometry == Quiescent(w) => ((w.mode = "follow") = AtBottom(w))
I_PillHonest == Quiescent(w) => (w.pill = ~AtBottom(w))

=============================================================================
