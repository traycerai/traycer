--------------------- MODULE ChatScrollPKConsumer ---------------------
EXTENDS ChatScrollBounded

\* One measured reader-history shape, then only its existing native reports.
\* Every edge also satisfies the unchanged published Next, including frames.
VARIABLE replayTick, replayAction
ReplayVars == <<vars, replayTick, replayAction>>

MandatoryAt(i) ==
    CASE i = 0 -> (Measure(2) /\ replayAction' = "Measure(2)")
    [] i = 1 -> (HydrationEffect /\ replayAction' = "HydrationEffect")
    [] i = 2 -> (ResizeObserved /\ replayAction' = "ResizeObserved")
    [] i = 3 -> (DragStart /\ replayAction' = "DragStart")
    [] i = 4 -> (KeyStep("toward-end") /\ replayAction' = "KeyStep(\"toward-end\")")
    [] i = 5 -> (DragMove("away-from-end") /\ replayAction' = "DragMove(\"away-from-end\")")
    [] i = 6 -> (DeliverScroll /\ replayAction' = "DeliverScroll")
    [] i = 7 -> (DragEnd /\ replayAction' = "DragEnd")
    [] OTHER -> FALSE

ReportAction ==
    \/ (DeliverScroll /\ replayAction' = "DeliverScroll")
    \/ (DeliverScrollEnd /\ replayAction' = "DeliverScrollEnd")

ReplayInit == Init /\ replayTick = 0 /\ replayAction = "Init"
CompletedPrefixQ == replayTick >= 8 /\ Quiescent(w)
StepNext ==
    /\ replayTick < 39
    /\ (IF replayTick < 8 THEN MandatoryAt(replayTick)
        ELSE ~Quiescent(w) /\ ReportAction)
    /\ Next
    /\ replayTick' = replayTick + 1
\* A source-Q endpoint already admits temporal stuttering. This explicit branch
\* only lets TLC distinguish that legitimate terminal from a disabled prefix,
\* native-report stall, or non-Q cap. It writes no original or replay variable.
ReplayNext ==
    \/ StepNext
    \/ (CompletedPrefixQ /\ UNCHANGED ReplayVars)
ReplaySpec == ReplayInit /\ [][ReplayNext]_ReplayVars

I_NamedPreconditions ==
    /\ (replayTick = 4 => (w.pressDown /\ AtBottom(w) /\ w.perm
                          /\ w.armed.src = "gesture" /\ w.armed.dir = "indeterminate"))
    /\ (replayTick = 5 => (w.keyNoMove /\ w.pressDown))

\* Intentionally violated only on an actual completed-prefix source-Q state.
\* CI requires this coverage class in BOTH controls; it is not a product symptom.
I_PKConsumerEndpointNotReached == ~CompletedPrefixQ
=============================================================================
