-------------------- MODULE ChatScrollMomentumPair --------------------
EXTENDS ChatScrollBounded

\* One reader history: a delivered contact lifts moving away, the tail grows,
\* and a contact on that fling delivers no touch event and pans onto the end
\* the lift recorded. Every edge satisfies the published Next but for
\* SilentMomentumFrame, the frame that excludes this class from ordinary runs:
\* with it the report that consumes the record could not be taken at all.
PairNext == Steps /\ LedgerNext /\ NestedInputNext /\ LiftEndNext /\ SilentNext /\ SilentFrame /\ DragFrame
            /\ MissedFollowNext

VARIABLE replayTick, replayAction
ReplayVars == <<vars, replayTick, replayAction>>

MandatoryAt(i) ==
    CASE i = 0 -> (Grow /\ replayAction' = "Grow")
    [] i = 1 -> (HydrationEffect /\ replayAction' = "HydrationEffect")
    [] i = 2 -> (ResizeObserved /\ replayAction' = "ResizeObserved")
    [] i = 3 -> (TouchStart /\ replayAction' = "TouchStart")
    [] i = 4 -> (FingerMove("away-from-end") /\ replayAction' = "FingerMove(\"away-from-end\")")
    [] i = 5 -> (TouchEnd(-1) /\ replayAction' = "TouchEnd(-1)")
    [] i = 6 -> (Measure(3) /\ replayAction' = "Measure(3)")
    [] i = 7 -> (TouchOnFling /\ replayAction' = "TouchOnFling")
    [] i = 8 -> (FingerMove("toward-end") /\ replayAction' = "FingerMove(\"toward-end\")")
    [] i = 9 -> (DeliverScroll /\ replayAction' = "DeliverScroll")
    [] OTHER -> FALSE

CompletionAction ==
    \/ (DeliverScroll /\ replayAction' = "DeliverScroll")
    \/ (LibReady /\ replayAction' = "LibReady")
    \/ (LibFinish /\ replayAction' = "LibFinish")
    \/ (TouchEnd(0) /\ replayAction' = "TouchEnd(0)")
    \/ (\E i \in Rows : Measure(i) /\ replayAction' = "Measure")

ReplayInit == Init /\ replayTick = 0 /\ replayAction = "Init"
CompletedPrefixQ == replayTick >= 10 /\ Quiescent(w)
StepNext ==
    /\ replayTick < MaxLevel
    /\ (IF replayTick < 10 THEN MandatoryAt(replayTick)
        ELSE ~Quiescent(w) /\ CompletionAction)
    /\ PairNext
    /\ replayTick' = replayTick + 1
\* A source-Q endpoint already admits temporal stuttering. This explicit branch
\* only lets TLC distinguish that legitimate terminal from a disabled prefix,
\* a stalled completion, or a non-Q cap. It writes no original or replay variable.
ReplayNext ==
    \/ StepNext
    \/ (CompletedPrefixQ /\ UNCHANGED ReplayVars)
ReplaySpec == ReplayInit /\ [][ReplayNext]_ReplayVars

\* The history is the one named: the contact on the fling is silent, and its
\* pan reaches the lift's old end short of the strict bottom.
I_NamedPreconditions ==
    /\ (replayTick = 8 => w.silent /\ w.finger)
    /\ (replayTick = 9 => w.silent /\ w.dirty /\ ~AtBottom(w))

\* Intentionally violated only on an actual completed-prefix source-Q state.
\* CI requires this coverage class in every control; it is not a product symptom.
I_MomentumPairEndpointNotReached == ~CompletedPrefixQ
=============================================================================
