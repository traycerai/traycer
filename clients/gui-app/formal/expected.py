"""Measured CI26 selection for pinned main 66529da1c.

Exploration controls stay generated outside this explicit selection.
Bounds count states including Init; violation lengths are evidence, not assertions.
"""

DEPTH = {'ChatScroll_nested_wheel_fixed': 18,
 'ChatScroll_idle_clamp_fixed': 22,
 'ChatScroll_idle_clamp_fixed_noheldgap': 22,
 'ChatScroll_idle_gap_fixed_withrawidle': 18,
 'ChatScroll_idle_clamp_fixed_withrawidle': 22,
 'ChatScroll_pad_cycle_follow_fixed': 18,
 'ChatScroll_pad_cycle_press_fixed': 18,
 'ChatScroll_drag_pad_fixed': 18,
 'ChatScroll_nav_follow_fixed': 18,
 'ChatScroll_send_fixed': 16,
 'ChatScroll_phone_read': 12,
 'ChatScroll_phone_read_fixed': 12,
 'ChatScroll_touch_end_fixed': 12,
 'ChatScroll_drag_idle_fixed': 18,
 'ChatScroll_drag_idle_fixed_nopressstep': 18,
 'ChatScroll_idle_gap_fixed': 18,
 'ChatScroll_idle_gap_fixed_noheldgap': 18,
 'ChatScroll_pad_land_fixed': 18,
 'ChatScroll_unscrolled_wheel_fixed': 18,
 'ChatScroll_turn_wheel_fixed': 18,
 'ChatScroll_turn_wheel_fixed_withturnclear': 18,
 'ChatScroll_phone_above_tail_fixed': 20,
 'ChatScroll_phone_viewport_fixed': 18,
 'ChatScroll_phone_pad_range_fixed': 18,
 'ChatScroll_armless_viewport_fixed': 18,
 'ChatScroll_wheel_viewport_fixed': 18}

VIOLATIONS = {'ChatScroll_drag_idle_fixed_nopressstep': {'I_IntentHeld': 'Without pressstep, a return drag is hidden by '
                                                            'its original press offset and corrected '
                                                            '(18-state witness; earlier run 17).'},
 'ChatScroll_idle_gap_fixed_withrawidle': {'I_ModeMatchesGeometry': 'EndCameIdle exact-meet price: detached '
                                                                    'at the bottom (13-state raw witness).',
                                           'I_PillHonest': 'EndCameIdle exact-meet price: the pill remains '
                                                           'at the bottom (13-state raw witness).'},
 'ChatScroll_idle_clamp_fixed_withrawidle': {'I_ModeMatchesGeometry': 'EndCameIdle clamp price: detached at '
                                                                      'the bottom (17-state raw witness).',
                                             'I_PillHonest': 'EndCameIdle clamp price: the pill remains at '
                                                             'the bottom (17-state raw witness).'},
 'ChatScroll_turn_wheel_fixed_withturnclear': {'I_IntentHeld': 'Clearing a pending wheel arm at TurnEnd lets '
                                                               'the later wheel be corrected (14-state '
                                                               'witness).'},
 'ChatScroll_phone_above_tail_fixed': {'I_IntentHeld': 'UnreadTail: the unrendered-row size guard can '
                                                       'withhold a streaming-tail re-follow (18-state '
                                                       'prototype witness); view stays put with the pill.'}}
