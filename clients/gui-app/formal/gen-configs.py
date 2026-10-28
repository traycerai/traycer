#!/usr/bin/env python3
"""Writes every ChatScroll_<name>.cfg. Edit this, not the configs."""

BASE = dict(
    R=3, VH=2, EST=2, Heights='"mixed"', MaxH=3, NAVOFF=0,
    HasWheel="TRUE", TouchInput="FALSE", TouchMoveDelivered="FALSE",
    HasScrollEnd="TRUE", DeferUnderFinger="FALSE", HideKinds='{"intact", "collapse"}',
    StartLo=1, StartMode='"fresh"', Foreground="TRUE", NoOpPicks="TRUE",
    Fixes="{}",
    Grows=0, Appends=0, Prepends=0, Wheels=0, Drags=0, Clicks=0, Touches=0,
    Flings=0, Minimaps=0, PhonePicks=0, Pills=0, Hides=0, Remounts=0,
)

# iOS WebKit in the Capacitor shell: no wheel or scrollbar, no `scrollend`.
# Measured on iOS 27.0 (Simulator): touchmove keeps arriving through a native
# pan, and a scroll write under the finger applies at once.
PHONE = dict(HasWheel="FALSE", TouchInput="TRUE", TouchMoveDelivered="TRUE",
             HasScrollEnd="FALSE", DeferUnderFinger="FALSE")

INVARIANTS = ["TypeOK", "I_IntentHeld", "I_SavingLive", "I_SavedIsView",
              "I_ModeMatchesGeometry", "I_PillHonest"]

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
    "phone_restore": ("Phone: a restored position, touched while it converges, then hidden.",
                      dict(PHONE, StartMode='"saved-free"', Touches=1, Hides=1, Grows=1)),
}

# Every config runs twice: against the code before the fixes, and as
# `<name>_fixed` with the fixes the client ships ("supersede" stays a
# model-only option: its counterexample does not reproduce in Chrome against
# the shipped fixes).
FIXED = '{"nav", "toward", "restore", "pill", "cancel", "paint", "reach", "arrive"}'


def write(name, doc, consts):
    lines = [f"\\* {doc}", "SPECIFICATION Spec", "CONSTANTS"]
    lines += [f"    {k} = {v}" for k, v in consts.items()]
    lines += ["INVARIANTS"] + [f"    {i}" for i in INVARIANTS]
    with open(f"ChatScroll_{name}.cfg", "w") as f:
        f.write("\n".join(lines) + "\n")


names = []
for name, (doc, overrides) in CONFIGS.items():
    write(name, doc, dict(BASE, **overrides))
    write(f"{name}_fixed", f"{doc} With the fixes.", dict(BASE, **overrides, Fixes=FIXED))
    names += [name, f"{name}_fixed"]
print(" ".join(f"ChatScroll_{n}" for n in names))
