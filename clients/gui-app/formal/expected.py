"""Measured CI subset: main 575a4525e plus landed #3081 and #3079 (0c9863c3c).

The remaining generated configs are exploration inputs, pending the full
matrix after the open latch PRs land. Depth counts states including Init.
A reason records each expected failing invariant; passing entries omit it.
"""

DEPTH = {
    "ChatScroll_idle_clamp_fixed": 22,
    "ChatScroll_idle_clamp_fixed_noheldgap": 22,
    "ChatScroll_idle_gap_fixed_withrawidle": 18,
    "ChatScroll_idle_clamp_fixed_withrawidle": 22,
    "ChatScroll_pad_cycle_follow_fixed": 18,
    "ChatScroll_pad_cycle_press_fixed": 18,
    "ChatScroll_drag_pad_fixed": 18,
    "ChatScroll_drag_pad_fixed_nopadannounce": 18,
    "ChatScroll_nav_follow": 14,
    "ChatScroll_nav_follow_fixed": 18,
    "ChatScroll_send": 14,
    "ChatScroll_send_fixed": 16,
    "ChatScroll_phone_read": 12,
    "ChatScroll_phone_read_fixed": 12,
    "ChatScroll_touch_end_fixed": 12,
    "ChatScroll_drag_idle_fixed": 18,
    "ChatScroll_drag_idle_fixed_nopressstep": 18,
    "ChatScroll_idle_gap_fixed": 18,
    "ChatScroll_idle_gap_fixed_noheldgap": 18,
    "ChatScroll_pad_land_fixed": 18,
    "ChatScroll_unscrolled_wheel_fixed": 18,
    "ChatScroll_turn_wheel_fixed": 18,
    "ChatScroll_turn_wheel_fixed_withturnclear": 18,
}

VIOLATIONS = {
    "ChatScroll_drag_pad_fixed_nopadannounce": {
        "I_IntentHeld": "Without #3081's announcement, a coalesced pad clamp and regrowth departs an unmoved press (13-state witness).",
    },
    "ChatScroll_nav_follow": {
        "I_IntentHeld": "Without navigation fixes, a minimap landing near the tail loses the requested follow (13-state measured witness).",
        "I_ModeMatchesGeometry": "The completed minimap leaves free mode at the strict bottom (10-state witness).",
        "I_PillHonest": "The same free-at-bottom landing leaves the pill showing (10-state witness).",
    },
    "ChatScroll_drag_idle_fixed_nopressstep": {
        "I_IntentHeld": "Without pressstep, a return drag is hidden by its original press offset and corrected (18-state witness; earlier run 17).",
    },
    "ChatScroll_idle_gap_fixed_withrawidle": {
        "I_ModeMatchesGeometry": "EndCameIdle exact-meet price: detached at the bottom (13-state raw witness).",
        "I_PillHonest": "EndCameIdle exact-meet price: the pill remains at the bottom (13-state raw witness).",
    },
    "ChatScroll_idle_clamp_fixed_withrawidle": {
        "I_ModeMatchesGeometry": "EndCameIdle clamp price: detached at the bottom (17-state raw witness).",
        "I_PillHonest": "EndCameIdle clamp price: the pill remains at the bottom (17-state raw witness).",
    },
    "ChatScroll_turn_wheel_fixed_withturnclear": {
        "I_IntentHeld": "Clearing a pending wheel arm at TurnEnd lets the later wheel be corrected (14-state witness).",
    },
}
