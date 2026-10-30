#!/usr/bin/env python3
"""Writes every ChatScroll_<name>.cfg. Edit this, not the configs."""

import os

HERE = os.path.dirname(os.path.abspath(__file__))

BASE = dict(
    R=3, VH=2, EST=2, Heights='"mixed"', MaxH=3, NAVOFF=0,
    HasWheel="TRUE", TouchInput="FALSE", TouchMoveDelivered="FALSE",
    HasScrollEnd="TRUE", DeferUnderFinger="FALSE", HideKinds='{"intact", "collapse"}',
    StartLo=1, StartMode='"fresh"', Foreground="TRUE", NoOpPicks="TRUE",
    Fixes="{}", REST=4, DataAnchored="TRUE", InitialEnd="FALSE", DeferAdjust="FALSE",
    Grows=0, Appends=0, Prepends=0, Wheels=0, Drags=0, Clicks=0, Touches=0,
    Flings=0, Minimaps=0, PhonePicks=0, Pills=0, Hides=0, Remounts=0, Jumps=0, NestedWheels=0,
    UnscrolledWheels=0, Pads=0, TurnEnds=0, Relayouts=0, IdleShrinks=0, IdleClamp="FALSE", Cycles=0, AboveTailGrows=0, TailRemounts=0, Viewports=0, AppWrites=0, TailHead='"p"',
    WheelDirs='{"toward-end", "away-from-end"}', WheelsApart="FALSE", ReportBeforeGrowth="FALSE",
)

# iOS WebKit in the Capacitor shell: no wheel or scrollbar, no `scrollend`.
# Measured on iOS 27.0 (Simulator): touchmove keeps arriving through a native
# pan, and a scroll write under the finger applies at once.
PHONE = dict(HasWheel="FALSE", TouchInput="TRUE", TouchMoveDelivered="TRUE",
             HasScrollEnd="FALSE", DeferUnderFinger="FALSE")

INVARIANTS = ["TypeOK", "I_IntentHeld", "I_SavingLive", "I_SavedIsView",
              "I_ModeMatchesGeometry", "I_PillHonest", "I_NoJump"]

CONFIGS = {
    # Desktop: a minimap pick while following a live reply.
    "nav_follow": ("A minimap pick while following a streamed reply.",
                   dict(Grows=2, Minimaps=1)),
    "nav_follow_moving": ("The same pick, naming only rows whose landing moves the view.",
                          dict(Grows=2, Minimaps=1, NoOpPicks="FALSE")),
    "nav_follow_bg": ("The same pick in a window that stops producing frames.",
                      dict(Grows=1, Minimaps=1, Foreground="FALSE")),
    "nav_follow_click": ("The same pick, and a click in the transcript before it lands.",
                         dict(Grows=1, Minimaps=1, Clicks=1)),
    # Desktop: a send at the tail. The prompt's row, then the reply's row, are
    # key-sequence commits (the list settles under its anchor lock); the reply
    # then streams.
    "send": ("A send while following: the prompt's row, the reply's row, then tokens.",
             dict(R=5, Appends=2, Grows=2)),
    "send_wheel": ("A send while following, and a wheel while the list settles.",
                   dict(R=5, Appends=2, Grows=1, Wheels=1)),
    "send_pick": ("A send while following, and a minimap pick while the list settles.",
                  dict(R=5, Appends=1, Grows=1, Minimaps=1, NoOpPicks="FALSE")),
    # Desktop: a minimap pick after the reader scrolled away, rows remeasuring.
    "nav_detached": ("A minimap pick after a wheel took the reader off the tail.",
                     dict(Grows=1, Wheels=1, Minimaps=1)),
    # Desktop: the pill and a wheel against a stream.
    "pill": ("The pill after a wheel detached the reader, with a streamed token.",
             dict(Grows=1, Wheels=1, Pills=1)),
    # Desktop: a saved free position, hidden and shown again.
    "hide_saved": ("A restored reading position, hidden (either kind) and shown again.",
                   dict(StartMode='"saved-free"', Hides=1, Grows=1)),
    # Desktop: the reader moves, then the tile is hidden and shown.
    "hide_read": ("The reader scrolls, then the tile is hidden (either kind) and shown.",
                  dict(Wheels=2, Hides=1, Grows=1)),
    # Desktop: the reader moves, then the tile remounts (evicted, or closed).
    "remount_read": ("The reader scrolls, then the tile remounts (evicted or closed and reopened).",
                     dict(Wheels=2, Remounts=1, Grows=1)),
    # Desktop: remount of a saved position, with a click that resizes a row.
    "remount_saved": ("A restored reading position remounts; the reader clicks a card.",
                      dict(StartMode='"saved-free"', Remounts=1, Clicks=1, Grows=1)),
    # A partial snapshot: the saved row arrives after the mount.
    "partial": ("A saved position whose row is not in the first snapshot; older rows arrive.",
                dict(StartMode='"saved-free"', StartLo=3, Prepends=2, Wheels=1, Grows=1)),
    # Phone: a pan, a lift with momentum, a Messages-list pick.
    "phone_pick": ("Phone: a Messages-list pick while following, a finger on the transcript.",
                   dict(PHONE, Grows=1, Touches=1, PhonePicks=1)),
    "phone_read": ("Phone: the reader pans and flings while a reply streams.",
                   dict(PHONE, Grows=2, Touches=2, Flings=1)),
    "phone_viewport": ("Phone: a resting contact across the viewport clamp and tail regrowth witness.",
                       dict(PHONE, Grows=1, Touches=1, Flings=1, Viewports=1)),
    "phone_pad_range": ("Phone: a resting contact across the announced pad-range clamp witness.",
                       dict(PHONE, Grows=1, Touches=1, Flings=1, Pads=1)),
    "armless_viewport": ("A following reader with no arm across the viewport clamp witness.",
                         dict(Grows=1, Viewports=1, WheelsApart="TRUE")),
    "wheel_viewport": ("A toward wheel whose arrival only the viewport read observes.",
                       dict(Grows=1, Wheels=2, Viewports=1, WheelsApart="TRUE")),
    "phone_above_tail": ("Phone: content above the last paragraph grows while a native fling heads for it.",
                         dict(PHONE, Grows=1, Touches=1, Flings=1, AboveTailGrows=1)),
    "phone_read_turn": ("Phone: the same, and the turn ends.",
                        dict(PHONE, Grows=2, Touches=2, Flings=1, TurnEnds=1)),
    "phone_restore": ("Phone: a restored position, touched while it converges, then hidden.",
                      dict(PHONE, StartMode='"saved-free"', Touches=1, Hides=1, Grows=1)),
    # Estimates: an unmeasured row above the reader goes stale (the type's
    # average jumps) and the next pass that lays it out re-estimates it.
    "teleport": ("A wheel up off the end of a streaming reply while a row above goes stale.",
                 dict(Jumps=1, Wheels=1, Grows=1)),
    "teleport_pill": ("The same with the pill after the wheel: an end request releases the hold.",
                      dict(Jumps=1, Wheels=1, Pills=1, Grows=1)),
    # chat-scroll-matrix-stream F2: a new turn's row is laid out at the
    # jumped estimate, and the reader wheels up within the last screenful.
    "stream_f2": ("A new turn after the average jumped, a wheel up, the reply's tokens, its end.",
                  dict(R=4, Jumps=1, Appends=1, Wheels=1, Grows=1, TurnEnds=1)),
    # chat-follow-latch-touch: its fixture's list anchors no data change.
    "touch_end": ("Phone, {data: false}: a swipe off the end, then a new row and tokens.",
                  dict(PHONE, R=4, DataAnchored="FALSE", Jumps=1, Touches=1, Appends=1,
                       Grows=1)),
    # The end release: the settled re-layout of a follow correction's
    # scrollToEnd judges the end from the list's own offset, while the
    # reader's wheel, its handler run, has yet to scroll. A renderer starved
    # of frames (a loaded runner) lets the finish timer beat the wheel's
    # scroll report.
    "release_wheel": ("A wheel up as a follow correction settles, its scroll frames after its handler.",
                      dict(DeferAdjust="TRUE", Foreground="FALSE", Jumps=1,
                           Wheels=1, Grows=1)),
    # A wheel the transcript never scrolls: a nested scroller takes it.
    "nested_wheel": ("A wheel over a nested scroller while following a streamed reply.",
                     dict(Grows=2, NestedWheels=1)),
    # A wheel the transcript never scrolls though the latch takes it for the
    # transcript's (a descendant cancelled it, or Chrome latched it to a
    # nested scroller at its edge).
    "unscrolled_wheel": ("A wheel that never scrolls the transcript while following a streamed reply.",
                         dict(Grows=2, UnscrolledWheels=1)),
    # M2: the list pads the end for a frame; the paint write lands in the
    # pad, the reader wheels up inside it, and the pad's reset clamps them
    # to the real end below where they departed. Then the turn ends.
    "pad_wheel": ("A wheel up inside the list's one-frame end pad, then the turn ends.",
                  dict(Grows=2, Pads=1, Wheels=1, TurnEnds=1)),
    # A wheel at the strict bottom whose scroll lands after the turn ends.
    "turn_wheel": ("A wheel up at the end of a streamed reply, its scroll landing after the turn ends.",
                   dict(Grows=1, Wheels=1, TurnEnds=1)),
    # A held reader (a wheel took them off, the appended row's measure
    # brought the end up to them) wheels up again at the strict bottom just
    # before the turn ends; that wheel's scroll lands after it. Their wheels
    # only turn up, each after the report of the one before: a wheel down,
    # and a second wheel before the first one's report, are other cases.
    "turn_held": ("A held reader's wheel up at the strict bottom, its scroll landing after the turn ends.",
                  dict(R=4, Appends=1, Wheels=2, TurnEnds=1,
                       WheelDirs='{"away-from-end"}', WheelsApart="TRUE")),
    # W1: the same, with the second wheel before the first one's scroll
    # report: that report decides the departure and spends the arm both
    # wheels share, and the turn's end then follows the held reader with the
    # second wheel's scroll still to land.
    "turn_spent": ("A held reader's second wheel up, before the first one's report, its scroll landing after the turn ends.",
                   dict(R=4, Appends=1, Wheels=2, TurnEnds=1, WheelDirs='{"away-from-end"}')),
    # W2: a held reader wheels down at the strict bottom, which takes no
    # scroll, while the turn streams; the row they are reading then grows.
    "held_down": ("A held reader's wheel down at the strict bottom, then the row in view grows.",
                  dict(R=4, Appends=1, Grows=1, Wheels=2, WheelsApart="TRUE")),
    # #3048: a free reader's wheel up lands, and the end pad's reset then
    # clamps them to the end with no input of theirs; then the turn ends.
    "pad_land": ("A free reader's wheel up whose scroll lands, then the end pad's reset brings the end to them and the turn ends.",
                 dict(Grows=2, Pads=1, Wheels=2, TurnEnds=1, WheelDirs='{"away-from-end"}',
                      WheelsApart="TRUE")),
    # A departed reader's own scroll farther from the end, then the end comes
    # to them with no input of theirs, while the reply streams on.
    "drag_pad": ("A scrollbar drag up off the end, reported twice, then the end pad's reset brings the end to the reader; the turn ends.",
                 dict(Grows=1, Pads=1, Drags=1, TurnEnds=1)),
    # The same, the turn ending with the reader mid-transcript and the end
    # coming to them after it.
    "drag_idle": ("A scrollbar drag up off the end, the turn ends mid-transcript, then a row below measures smaller.",
                  dict(R=4, Appends=1, Drags=1, TurnEnds=1)),
    "pad_cycle_follow": ("An announced end-pad clamp and reopen before any observer, while following.",
                         dict(Grows=1, Pads=1, TurnEnds=1, Cycles=1)),
    "pad_cycle_press": ("The same coalesced clamp and reopen while a stationary scrollbar press is held.",
                        dict(Grows=1, Pads=1, TurnEnds=1, Cycles=1, Drags=1)),
    "idle_gap": ("An idle departed reader whom a last-row shrink meets exactly, with no scroll event.",
                 dict(Drags=1, TurnEnds=1, IdleShrinks=1)),
    "idle_clamp": ("An idle departed reader is clamped, may report there, then the end regrows.",
                   dict(Grows=1, Drags=1, TurnEnds=1, IdleShrinks=1, IdleClamp="TRUE")),
    "idle_absorbed": ("An absorbed wheel report, growth publishes a departure, then an idle shrink meets the reader without another report.",
                      dict(Grows=1, UnscrolledWheels=1, TurnEnds=1, IdleShrinks=1, ReportBeforeGrowth="TRUE",
                           WheelDirs='{"away-from-end"}')),
    # B6: a mount at the tail through the list's initial scroll to the end;
    # the reader wheels away before or after it settles, then the viewport
    # changes size while the list may still keep the end target.
    "boot_wheel": ("A wheel up around the initial scroll to the end, then a viewport resize.",
                   dict(InitialEnd="TRUE", Wheels=1, Relayouts=1, Grows=1)),
    # P6b: a wheel during an animated pick, while MVCP holds its adjust back.
    "p6b": ("A wheel during an animated pick whose rows above are measured or go stale.",
            dict(DeferAdjust="TRUE", NoOpPicks="FALSE", Jumps=1, Minimaps=1, Wheels=1)),
}

# Every config runs twice: against the code before the fixes, and as
# `<name>_fixed` with the fixes the client ships.
SHIPPED = ["nav", "toward", "restore", "pill", "cancel", "paint", "supersede", "reach",
           "arrive", "live", "hold-init", "fling", "evidence", "nested", "fallen", "depart",
           "keep", "padend", "turnguard", "ledger", "ledgermaint", "translate", "followguard",
           "liftledger", "obsarm", "momstill", "freeland", "freelanddep", "armcarry", "restspend",
           "deprebase", "heldgap", "pressland", "pressstep", "padannounce", "idlehold", "momhybrid", "tailblock", "unreadsize", "restoreanswer", "viewcarry", "oweddep"]
FIXED = "{" + ", ".join(f'"{f}"' for f in SHIPPED) + "}"

# Configs also run with one shipped fix taken out (`_fixed_no<fix>`;
# `nohold` takes out the estimate hold), with the hold swapped for a rule it
# beat (`_fixed_<rule>`), or with a rejected one added (`_fixed_with<fix>`), to
# show the violation that fix removes.
RULES = {"holdall": "hold-all", "holdmvcp": "hold-mvcp", "holdrelease": "hold-release",
         "holdend": "hold-end", "holdboot": "hold-boot"}
# "hold-all" differs from "hold-init" only in the initial scroll's settled
# re-layout, which only `boot_wheel` runs.
EVERY_RULE = ["nohold"] + [r for r in RULES if r != "holdall"]
VARIANTS = {
    "send_wheel": ["noevidence"],
    "nav_detached": ["noevidence"],
    "hide_read": ["noevidence"],
    "remount_read": ["noevidence", "nofollowguard"],
    "partial": ["noevidence"],
    "teleport": EVERY_RULE + ["noevidence"],
    "teleport_pill": EVERY_RULE + ["noevidence"],
    "touch_end": EVERY_RULE + ["nosupersede", "noobsarm", "nomomstill"],
    "stream_f2": ["noevidence", "nodepart", "notranslate"],
    "phone_read": ["nofling", "noledger", "noliftledger", "nomomhybrid_notailblock"],
    "phone_above_tail": ["notailblock", "nounreadsize"],
    "phone_viewport": ["noviewcarry"],
    "phone_pad_range": ["noviewcarry"],
    "armless_viewport": ["noviewcarry"],
    "wheel_viewport": ["noviewcarry"],
    "phone_pick": ["notranslate"],
    "phone_restore": ["noobsarm"],
    "release_wheel": EVERY_RULE + ["noevidence"],
    "nested_wheel": ["nonested"],
    "boot_wheel": ["holdall", "nohold", "holdboot", "noledgermaint"],
    "pad_wheel": ["nofallen", "nodepart", "nopadend", "noheldgap"],
    "turn_wheel": ["withturnclear"],
    "turn_held": ["noturnguard", "nofreeland", "noheldgap"],
    "turn_spent": ["noledger", "noledgermaint", "nofreeland", "noheldgap"],
    "pad_land": ["nofreeland", "nofreelanddep", "noarmcarry", "norestspend", "nodeprebase",
                 "nodeprebase_nopressland", "noheldgap"],
    "drag_pad": ["nopadannounce", "nodeprebase", "nopressland", "nopressstep", "noarmcarry", "noheldgap"],
    "drag_idle": ["nodeprebase", "nopressland", "nopressstep", "noarmcarry", "noheldgap"],
    "idle_gap": ["noheldgap", "noidlehold", "withrawidle"],
    "idle_clamp": ["noheldgap", "noidlehold", "withrawidle"],
    "idle_absorbed": ["withalwaysawait"],
    "unscrolled_wheel": ["nodepart"],
    "pill": ["noevidence", "nokeep"],
    "p6b": ["nolive", "noevidence"] + EVERY_RULE,
}


def variant_fixes(v):
    """A variant is one or more changes to the shipped set, joined by `_`."""
    fixes = list(SHIPPED)
    for part in v.split("_"):
        if part.startswith("with"):
            fixes.append(part[4:])
        elif part == "nohold":
            fixes.remove("hold-init")
        elif part in RULES:
            fixes[fixes.index("hold-init")] = RULES[part]
        else:
            assert part.startswith("no"), part
            fixes.remove(part[2:])
    return "{" + ", ".join(f'"{f}"' for f in fixes) + "}"


def write(name, doc, consts):
    lines = [f"\\* {doc}", "SPECIFICATION Spec", "CONSTANTS"]
    lines += [f"    {k} = {v}" for k, v in consts.items()]
    lines += ["INVARIANTS"] + [f"    {i}" for i in INVARIANTS]
    with open(os.path.join(HERE, f"ChatScroll_{name}.cfg"), "w") as f:
        f.write("\n".join(lines) + "\n")


names = []
for name, (doc, overrides) in CONFIGS.items():
    write(name, doc, dict(BASE, **overrides))
    write(f"{name}_fixed", f"{doc} With the fixes.", dict(BASE, **overrides, Fixes=FIXED))
    names += [name, f"{name}_fixed"]
    for v in VARIANTS.get(name, []):
        write(f"{name}_fixed_{v}", f"{doc} With the fixes, {v}.",
              dict(BASE, **overrides, Fixes=variant_fixes(v)))
        names.append(f"{name}_fixed_{v}")
print(" ".join(f"ChatScroll_{n}" for n in names))
