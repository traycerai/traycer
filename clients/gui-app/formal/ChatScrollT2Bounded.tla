--------------------- MODULE ChatScrollT2Bounded ---------------------
EXTENDS ChatScrollBounded
\* Explicit T2-only pair: permit a write during a pending drag report.
\* A range decrease that erases the pending drag remains forbidden.
T2DragFrame ==
    (w.inputMove = "drag" /\ w.dirty) =>
        ~(MaxS(w') < MaxS(w) /\ MaxS(w') <= w.s)
T2Next == Steps /\ LedgerNext /\ NestedInputNext /\ LiftEndNext /\ SilentNext /\ SilentFrame /\ T2DragFrame
        /\ SilentMomentumFrame /\ MissedFollowNext
T2Spec == Init /\ [][T2Next]_vars
=============================================================================
