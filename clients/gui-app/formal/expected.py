"""Selected bounded regressions and their observed invariant classes.

Landed-input controls were measured against source main 120982023.
The original 25 names and bounds retain their freshly observed classes.
Bounds count states including Init; witness lengths are evidence.
"""

# Only the queued-command pair uses T2; the focused pair keeps ordinary Next.
MODULES = {'ChatScroll_PKConsumer_after': ('ChatScrollPKConsumer', 'ReplaySpec'),
 'ChatScroll_PKConsumer_before': ('ChatScrollPKConsumer', 'ReplaySpec'),
 'ChatScroll_drag_idle_fixed_pressqueue_after': ('ChatScrollT2Bounded', 'T2Spec'),
 'ChatScroll_drag_idle_fixed_pressqueue_before': ('ChatScrollT2Bounded', 'T2Spec')}

# Engine deadlock checks distinguish a stalled required history from a source-Q terminal.
CHECK_DEADLOCK = {'ChatScroll_PKConsumer_after': True, 'ChatScroll_PKConsumer_before': True}

DEPTH = {'ChatScroll_PKConsumer_after': 42,
 'ChatScroll_PKConsumer_before': 42,
 'ChatScroll_armless_viewport_fixed': 18,
 'ChatScroll_drag_idle_fixed': 18,
 'ChatScroll_drag_idle_fixed_nopressstep': 18,
 'ChatScroll_drag_idle_fixed_pressqueue_after': 20,
 'ChatScroll_drag_idle_fixed_pressqueue_before': 20,
 'ChatScroll_drag_pad_fixed': 18,
 'ChatScroll_idle_clamp_fixed': 22,
 'ChatScroll_idle_clamp_fixed_noheldgap': 22,
 'ChatScroll_idle_clamp_fixed_withrawidle': 22,
 'ChatScroll_idle_clamp_fixed_withrawidle_keyanswer_after': 18,
 'ChatScroll_idle_clamp_fixed_withrawidle_keyanswer_before': 18,
 'ChatScroll_idle_clamp_fixed_withrawidle_presskey_after': 18,
 'ChatScroll_idle_clamp_fixed_withrawidle_presskey_before': 18,
 'ChatScroll_idle_gap_fixed': 18,
 'ChatScroll_idle_gap_fixed_noheldgap': 18,
 'ChatScroll_idle_gap_fixed_withrawidle': 18,
 'ChatScroll_idle_gap_fixed_withrawidle_keyanswer_after': 18,
 'ChatScroll_idle_gap_fixed_withrawidle_keyanswer_before': 18,
 'ChatScroll_idle_gap_fixed_withrawidle_presskey_after': 18,
 'ChatScroll_idle_gap_fixed_withrawidle_presskey_before': 18,
 'ChatScroll_nav_follow': 14,
 'ChatScroll_nav_follow_fixed': 18,
 'ChatScroll_nested_wheel_fixed': 18,
 'ChatScroll_pad_cycle_follow_fixed': 18,
 'ChatScroll_pad_cycle_press_fixed': 18,
 'ChatScroll_pad_land_fixed': 18,
 'ChatScroll_phone_above_tail_fixed': 20,
 'ChatScroll_phone_read': 12,
 'ChatScroll_phone_read_fixed': 12,
 'ChatScroll_send': 14,
 'ChatScroll_send_fixed': 16,
 'ChatScroll_touch_end_fixed': 12,
 'ChatScroll_turn_wheel_fixed': 18,
 'ChatScroll_turn_wheel_fixed_withturnclear': 18,
 'ChatScroll_unscrolled_wheel_fixed': 18}

VIOLATIONS = {'ChatScroll_PKConsumer_after': {'I_PKConsumerEndpointNotReached': 'Required coverage only: the '
                                                                   'complete reader history '
                                                                   'reaches source quiescence (10 '
                                                                   'states); absence fails the '
                                                                   'control.'},
 'ChatScroll_PKConsumer_before': {'I_IntentHeld': 'Without PressKey, a zero-pixel key spends the '
                                                  'held press arm and the later report moves '
                                                  'requested row 2 from offset -2 to -3 (11-state '
                                                  'measured witness).',
                                  'I_PKConsumerEndpointNotReached': 'Required coverage only: the '
                                                                    'complete reader history '
                                                                    'reaches source quiescence (11 '
                                                                    'states); absence fails the '
                                                                    'control.'},
 'ChatScroll_drag_idle_fixed_nopressstep': {'I_IntentHeld': 'Without pressstep, a return drag is '
                                                            'hidden by its original press offset '
                                                            'and corrected (17-state measured '
                                                            'witness).'},
 'ChatScroll_drag_idle_fixed_pressqueue_after': {},
 'ChatScroll_drag_idle_fixed_pressqueue_before': {'I_IntentHeld': 'Without the physical-press '
                                                                  'queue gate, the queued end '
                                                                  'command moves the requested row '
                                                                  '(19-state measured witness '
                                                                  'under the explicit T2 frame).'},
 'ChatScroll_idle_clamp_fixed_withrawidle': {'I_ModeMatchesGeometry': 'EndCameIdle clamp price: '
                                                                      'detached at the bottom '
                                                                      '(17-state raw witness).',
                                             'I_PillHonest': 'EndCameIdle clamp price: the pill '
                                                             'remains at the bottom (17-state raw '
                                                             'witness).'},
 'ChatScroll_idle_clamp_fixed_withrawidle_keyanswer_after': {'I_IntentHeld': 'Retained original '
                                                                             'outcome on an '
                                                                             'independently '
                                                                             'matched before/after '
                                                                             'history (10-state '
                                                                             'measured witness).',
                                                             'I_MissedFollowPrice': 'Retained '
                                                                                    'original '
                                                                                    'outcome on an '
                                                                                    'independently '
                                                                                    'matched '
                                                                                    'before/after '
                                                                                    'history '
                                                                                    '(17-state '
                                                                                    'measured '
                                                                                    'witness).',
                                                             'I_ModeMatchesGeometry': 'Retained '
                                                                                      'original '
                                                                                      'outcome on '
                                                                                      'an '
                                                                                      'independently '
                                                                                      'matched '
                                                                                      'before/after '
                                                                                      'history '
                                                                                      '(12-state '
                                                                                      'measured '
                                                                                      'witness).',
                                                             'I_PillHonest': 'Retained original '
                                                                             'outcome on an '
                                                                             'independently '
                                                                             'matched before/after '
                                                                             'history (12-state '
                                                                             'measured witness).'},
 'ChatScroll_idle_clamp_fixed_withrawidle_keyanswer_before': {'I_IntentHeld': 'Retained original '
                                                                              'outcome on an '
                                                                              'independently '
                                                                              'matched '
                                                                              'before/after '
                                                                              'history (10-state '
                                                                              'measured witness).',
                                                              'I_KeyAnswer': 'Missing same-handler '
                                                                             'follow answer after '
                                                                             'a zero-pixel toward '
                                                                             'key (6-state '
                                                                             'measured witness).',
                                                              'I_MissedFollowPrice': 'Retained '
                                                                                     'original '
                                                                                     'outcome on '
                                                                                     'an '
                                                                                     'independently '
                                                                                     'matched '
                                                                                     'before/after '
                                                                                     'history '
                                                                                     '(17-state '
                                                                                     'measured '
                                                                                     'witness).',
                                                              'I_ModeMatchesGeometry': 'Retained '
                                                                                       'original '
                                                                                       'outcome on '
                                                                                       'an '
                                                                                       'independently '
                                                                                       'matched '
                                                                                       'before/after '
                                                                                       'history '
                                                                                       '(12-state '
                                                                                       'measured '
                                                                                       'witness).',
                                                              'I_PillHonest': 'Retained original '
                                                                              'outcome on an '
                                                                              'independently '
                                                                              'matched '
                                                                              'before/after '
                                                                              'history (12-state '
                                                                              'measured witness).'},
 'ChatScroll_idle_clamp_fixed_withrawidle_presskey_after': {'I_IntentHeld': 'Retained original '
                                                                            'outcome on an '
                                                                            'independently matched '
                                                                            'before/after history '
                                                                            '(10-state measured '
                                                                            'witness).',
                                                            'I_MissedFollowPrice': 'Retained '
                                                                                   'original '
                                                                                   'outcome on an '
                                                                                   'independently '
                                                                                   'matched '
                                                                                   'before/after '
                                                                                   'history '
                                                                                   '(17-state '
                                                                                   'measured '
                                                                                   'witness).',
                                                            'I_ModeMatchesGeometry': 'Retained '
                                                                                     'original '
                                                                                     'outcome on '
                                                                                     'an '
                                                                                     'independently '
                                                                                     'matched '
                                                                                     'before/after '
                                                                                     'history '
                                                                                     '(12-state '
                                                                                     'measured '
                                                                                     'witness).',
                                                            'I_PillHonest': 'Retained original '
                                                                            'outcome on an '
                                                                            'independently matched '
                                                                            'before/after history '
                                                                            '(12-state measured '
                                                                            'witness).'},
 'ChatScroll_idle_clamp_fixed_withrawidle_presskey_before': {'I_IntentHeld': 'Retained original '
                                                                             'outcome on an '
                                                                             'independently '
                                                                             'matched before/after '
                                                                             'history (10-state '
                                                                             'measured witness).',
                                                             'I_MissedFollowPrice': 'Retained '
                                                                                    'original '
                                                                                    'outcome on an '
                                                                                    'independently '
                                                                                    'matched '
                                                                                    'before/after '
                                                                                    'history '
                                                                                    '(17-state '
                                                                                    'measured '
                                                                                    'witness).',
                                                             'I_ModeMatchesGeometry': 'Retained '
                                                                                      'original '
                                                                                      'outcome on '
                                                                                      'an '
                                                                                      'independently '
                                                                                      'matched '
                                                                                      'before/after '
                                                                                      'history '
                                                                                      '(12-state '
                                                                                      'measured '
                                                                                      'witness).',
                                                             'I_PillHonest': 'Retained original '
                                                                             'outcome on an '
                                                                             'independently '
                                                                             'matched before/after '
                                                                             'history (12-state '
                                                                             'measured witness).'},
 'ChatScroll_idle_gap_fixed_withrawidle': {'I_ModeMatchesGeometry': 'EndCameIdle exact-meet price: '
                                                                    'detached at the bottom '
                                                                    '(13-state raw witness).',
                                           'I_PillHonest': 'EndCameIdle exact-meet price: the pill '
                                                           'remains at the bottom (13-state raw '
                                                           'witness).'},
 'ChatScroll_idle_gap_fixed_withrawidle_keyanswer_after': {'I_IntentHeld': 'Retained original '
                                                                           'outcome on an '
                                                                           'independently matched '
                                                                           'before/after history '
                                                                           '(10-state measured '
                                                                           'witness).',
                                                           'I_ModeMatchesGeometry': 'Retained '
                                                                                    'original '
                                                                                    'outcome on an '
                                                                                    'independently '
                                                                                    'matched '
                                                                                    'before/after '
                                                                                    'history '
                                                                                    '(11-state '
                                                                                    'measured '
                                                                                    'witness).',
                                                           'I_PillHonest': 'Retained original '
                                                                           'outcome on an '
                                                                           'independently matched '
                                                                           'before/after history '
                                                                           '(11-state measured '
                                                                           'witness).'},
 'ChatScroll_idle_gap_fixed_withrawidle_keyanswer_before': {'I_IntentHeld': 'Retained original '
                                                                            'outcome on an '
                                                                            'independently matched '
                                                                            'before/after history '
                                                                            '(10-state measured '
                                                                            'witness).',
                                                            'I_KeyAnswer': 'Missing same-handler '
                                                                           'follow answer after a '
                                                                           'zero-pixel toward key '
                                                                           '(6-state measured '
                                                                           'witness).',
                                                            'I_ModeMatchesGeometry': 'Retained '
                                                                                     'original '
                                                                                     'outcome on '
                                                                                     'an '
                                                                                     'independently '
                                                                                     'matched '
                                                                                     'before/after '
                                                                                     'history '
                                                                                     '(11-state '
                                                                                     'measured '
                                                                                     'witness).',
                                                            'I_PillHonest': 'Retained original '
                                                                            'outcome on an '
                                                                            'independently matched '
                                                                            'before/after history '
                                                                            '(11-state measured '
                                                                            'witness).'},
 'ChatScroll_idle_gap_fixed_withrawidle_presskey_after': {'I_IntentHeld': 'Retained original '
                                                                          'outcome on an '
                                                                          'independently matched '
                                                                          'before/after history '
                                                                          '(10-state measured '
                                                                          'witness).',
                                                          'I_ModeMatchesGeometry': 'Retained '
                                                                                   'original '
                                                                                   'outcome on an '
                                                                                   'independently '
                                                                                   'matched '
                                                                                   'before/after '
                                                                                   'history '
                                                                                   '(11-state '
                                                                                   'measured '
                                                                                   'witness).',
                                                          'I_PillHonest': 'Retained original '
                                                                          'outcome on an '
                                                                          'independently matched '
                                                                          'before/after history '
                                                                          '(11-state measured '
                                                                          'witness).'},
 'ChatScroll_idle_gap_fixed_withrawidle_presskey_before': {'I_IntentHeld': 'Retained original '
                                                                           'outcome on an '
                                                                           'independently matched '
                                                                           'before/after history '
                                                                           '(10-state measured '
                                                                           'witness).',
                                                           'I_ModeMatchesGeometry': 'Retained '
                                                                                    'original '
                                                                                    'outcome on an '
                                                                                    'independently '
                                                                                    'matched '
                                                                                    'before/after '
                                                                                    'history '
                                                                                    '(11-state '
                                                                                    'measured '
                                                                                    'witness).',
                                                           'I_PillHonest': 'Retained original '
                                                                           'outcome on an '
                                                                           'independently matched '
                                                                           'before/after history '
                                                                           '(11-state measured '
                                                                           'witness).'},
 'ChatScroll_nav_follow': {'I_IntentHeld': 'Without navigation fixes, a minimap landing near the '
                                           'tail loses the requested follow (13-state measured '
                                           'witness).',
                           'I_ModeMatchesGeometry': 'The completed minimap leaves free mode at the '
                                                    'strict bottom (10-state witness).',
                           'I_PillHonest': 'The same free-at-bottom landing leaves the pill '
                                           'showing (10-state witness).'},
 'ChatScroll_phone_above_tail_fixed': {'I_MissedFollowPrice': 'UnreadTail: the unrendered-row size '
                                                              'guard can withhold a streaming-tail '
                                                              're-follow (18-state prototype '
                                                              'witness); view stays put with the '
                                                              'pill.'},
 'ChatScroll_turn_wheel_fixed_withturnclear': {'I_IntentHeld': 'Clearing a pending wheel arm at '
                                                               'TurnEnd lets the later wheel be '
                                                               'corrected (14-state witness).'}}
