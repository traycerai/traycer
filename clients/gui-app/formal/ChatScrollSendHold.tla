---------------------- MODULE ChatScrollSendHold ----------------------
EXTENDS ChatScrollBounded

\* Send 6 (iOS 26.5 Simulator, frame f7986), inside the send's void. A
\* following reader at the end sends: the latch writes to the inflated end
\* and queues the list's scrollToEnd, and that frame lands. Still inside the
\* void, the list runs the queued scrollToEnd into its end pad as the pad
\* opens, the sent row is measured taller, and the latch writes back out of
\* the pad to the moved content end. That frame renders the burst reverted
\* to the offset before it with the pad still open, and its report reads
\* below the latch's ledger. The pad resets after the report; the snapshot
\* returns.
\*
\* A beat whose write the model did not issue is skipped and the model
\* stutters there: no structural hold to close, no queued scrollToEnd, no
\* burst for the frame to revert, nothing moved to report. The pad opens as
\* the list's scrollToEnd runs it, as the trace and the plan account for it,
\* so it is skipped with that command.
\*
\* PadAfter: once the history is done, the pad may still open as a queued
\* scrollToEnd runs, the way it opened in send 6. Under the hold that is
\* the close correction's own command, which the history never issued.
CONSTANT PadAfter
VARIABLE replayTick, replayAction
ReplayVars == <<vars, replayTick, replayAction>>

Beats == 16

Skipped(i) ==
    CASE i = 6 -> w.holdStruct # "framed"
      [] i \in {10, 11} -> w.cmd.k # "end"
      [] i = 13 -> ~w.burst.on
      [] i = 14 -> ~w.dirty
      [] OTHER -> FALSE

MandatoryAt(i) ==
    CASE i = 0 -> (Measure(2) /\ replayAction' = "Measure(2)")
    [] i = 1 -> (HydrationEffect /\ replayAction' = "HydrationEffect")
    [] i = 2 -> (ResizeObserved /\ replayAction' = "ResizeObserved")
    [] i = 3 -> (DeliverScroll /\ replayAction' = "DeliverScroll")
    [] i = 4 -> (SendVoid /\ replayAction' = "SendVoid")
    [] i = 5 -> (Frame("land") /\ replayAction' = "Frame(land)")
    [] i = 6 -> (HoldClose /\ replayAction' = "HoldClose")
    [] i = 7 -> (Grow /\ replayAction' = "Grow")
    [] i = 8 -> (Grow /\ replayAction' = "Grow")
    [] i = 9 -> (SettleFrames /\ replayAction' = "SettleFrames")
    [] i = 10 -> (PadOpen /\ replayAction' = "PadOpen")
    [] i = 11 -> (LibReady /\ replayAction' = "LibReady")
    [] i = 12 -> (Measure(4) /\ replayAction' = "Measure(4)")
    [] i = 13 -> (Frame("revert") /\ replayAction' = "Frame(revert)")
    [] i = 14 -> (DeliverScroll /\ replayAction' = "DeliverScroll")
    [] i = 15 -> (SnapshotReturn /\ replayAction' = "SnapshotReturn")
    [] OTHER -> FALSE

\* After the history, only what completes it: no input, no growth, and a pad
\* only with PadAfter, as a queued scrollToEnd runs.
CompletionAction ==
    \/ (PadAfter /\ w.cmd.k = "end" /\ PadOpen /\ replayAction' = "PadOpen")
    \/ (DeliverScroll /\ replayAction' = "DeliverScroll")
    \/ (LibReady /\ replayAction' = "LibReady")
    \/ (LibReadyTimeout /\ replayAction' = "LibReadyTimeout")
    \/ (LibFinish /\ replayAction' = "LibFinish")
    \/ (\E i \in Rows : Measure(i) /\ replayAction' = "Measure")
    \/ (\E o \in FrameOutcomes : Frame(o) /\ replayAction' = "Frame")
    \/ (HoldClose /\ replayAction' = "HoldClose")
    \/ (PadReset /\ replayAction' = "PadReset")
    \/ (CorrFrame /\ replayAction' = "CorrFrame")
    \/ (StructSettle /\ replayAction' = "StructSettle")
    \/ (SettleFrames /\ replayAction' = "SettleFrames")
    \/ (HydrationEffect /\ replayAction' = "HydrationEffect")
    \/ (ResizeObserved /\ replayAction' = "ResizeObserved")

ReplayInit == Init /\ replayTick = 0 /\ replayAction = "Init"
CompletedPrefixQ == replayTick >= Beats /\ Quiescent(w)
StepNext ==
    /\ replayTick < MaxLevel
    /\ IF replayTick < Beats
       THEN IF Skipped(replayTick)
            THEN UNCHANGED vars /\ replayAction' = "skip"
            ELSE MandatoryAt(replayTick) /\ Next
       ELSE ~Quiescent(w) /\ CompletionAction /\ Next
    /\ replayTick' = replayTick + 1
\* A source-Q endpoint already admits temporal stuttering. This explicit branch
\* only lets TLC distinguish that legitimate terminal from a disabled beat,
\* a stalled completion, or a non-Q cap. It writes no original or replay variable.
ReplayNext ==
    \/ StepNext
    \/ (CompletedPrefixQ /\ UNCHANGED ReplayVars)
ReplaySpec == ReplayInit /\ [][ReplayNext]_ReplayVars

\* The history is the one named, wherever its writes were issued: the send
\* meets a following reader at the end with a live ledger; the burst's last
\* write goes back out of the open pad to the moved content end; the report
\* reads the reverted offset below the ledger, off the strict bottom, the pad
\* still open.
I_NamedPreconditions ==
    /\ (replayTick = 4 => w.perm /\ AtBottom(w) /\ led = w.s)
    /\ ((replayTick = 13 /\ w.burst.on) =>
            w.pad # 0 /\ w.burst.to = H(w) - w.V /\ w.burst.to > w.burst.from)
    /\ ((replayTick = 14 /\ w.dirty) =>
            w.pad # 0 /\ ~AtBottom(w) /\ led # -1 /\ w.s < led)

\* Intentionally violated only on an actual completed-prefix source-Q state.
\* CI requires this coverage class in every control; it is not a product symptom.
I_SendHoldEndpointNotReached == ~CompletedPrefixQ
=============================================================================
