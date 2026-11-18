"""Selected bounded regressions and their observed invariant classes.

Landed-input controls were measured against source main 120982023.
The original 25 names and bounds retain their freshly observed classes.
The MomentumPair controls were measured with the pair on main 49ec74dbf.
The SendHold controls and the layout-hold variants were measured on main 8636d3252.
Bounds count states including Init; witness lengths are evidence.
"""

# Only the queued-command pair uses T2; the focused pair keeps ordinary Next.
MODULES = {'ChatScroll_MomentumPair_after': ('ChatScrollMomentumPair', 'ReplaySpec'),
 'ChatScroll_MomentumPair_before': ('ChatScrollMomentumPair', 'ReplaySpec'),
 'ChatScroll_MomentumPair_first_after': ('ChatScrollMomentumPair', 'ReplaySpec'),
 'ChatScroll_MomentumPair_first_before': ('ChatScrollMomentumPair', 'ReplaySpec'),
 'ChatScroll_PKConsumer_after': ('ChatScrollPKConsumer', 'ReplaySpec'),
 'ChatScroll_PKConsumer_before': ('ChatScrollPKConsumer', 'ReplaySpec'),
 'ChatScroll_SendHold_after': ('ChatScrollSendHold', 'ReplaySpec'),
 'ChatScroll_SendHold_before': ('ChatScrollSendHold', 'ReplaySpec'),
 'ChatScroll_SendHold_closepad': ('ChatScrollSendHold', 'ReplaySpec'),
 'ChatScroll_SendHold_nowindow': ('ChatScrollSendHold', 'ReplaySpec'),
 'ChatScroll_drag_idle_fixed_pressqueue_after': ('ChatScrollT2Bounded', 'T2Spec'),
 'ChatScroll_drag_idle_fixed_pressqueue_before': ('ChatScrollT2Bounded', 'T2Spec')}

# Engine deadlock checks distinguish a stalled required history from a source-Q terminal.
CHECK_DEADLOCK = {'ChatScroll_MomentumPair_after': True,
 'ChatScroll_MomentumPair_before': True,
 'ChatScroll_MomentumPair_first_after': True,
 'ChatScroll_MomentumPair_first_before': True,
 'ChatScroll_PKConsumer_after': True,
 'ChatScroll_PKConsumer_before': True,
 'ChatScroll_SendHold_after': True,
 'ChatScroll_SendHold_before': True,
 'ChatScroll_SendHold_closepad': True,
 'ChatScroll_SendHold_nowindow': True}

DEPTH = {'ChatScroll_MomentumPair_after': 16,
 'ChatScroll_MomentumPair_before': 16,
 'ChatScroll_MomentumPair_first_after': 15,
 'ChatScroll_MomentumPair_first_before': 15,
 'ChatScroll_PKConsumer_after': 42,
 'ChatScroll_PKConsumer_before': 42,
 'ChatScroll_SendHold_after': 40,
 'ChatScroll_SendHold_before': 40,
 'ChatScroll_SendHold_closepad': 32,
 'ChatScroll_SendHold_nowindow': 40,
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
 'ChatScroll_phone_send_fixed': 12,
 'ChatScroll_phone_send_fixed_withlayouthold': 12,
 'ChatScroll_send': 14,
 'ChatScroll_send_fixed': 16,
 'ChatScroll_touch_end_fixed': 12,
 'ChatScroll_touch_end_fixed_withlayouthold': 12,
 'ChatScroll_turn_wheel_fixed': 18,
 'ChatScroll_turn_wheel_fixed_withturnclear': 18,
 'ChatScroll_unscrolled_wheel_fixed': 18}

MOMENTUM_ENDPOINT = ('Required coverage only: the reader history reaches source quiescence; '
                     'absence fails the control.')
MOMENTUM_YANK = ('Without momdir, the silent pan onto the end an away lift recorded reads as '
                 'its fling arriving: the report follows and writes past where the reader stopped.')

SEND_ENDPOINT = ('Required coverage only: the send-6 history reaches source quiescence; '
                 'absence fails the control.')
SEND_DETACH = ('Send 6: the frame reverts the burst in the open pad to the offset before it, '
               'below the ledger; the report publishes a departure, and the reader rests one unit '
               'short of the end, detached with the pill (24-state measured witness).')
SEND_NOWINDOW = ('The structural bit alone closes a frame after the send, so the close correction '
                 'queues the scrollToEnd that bursts into the pad inside the void, and the reader '
                 'detaches as without the hold (26-state measured witness).')
SEND_CLOSEPAD = ('Under the hold, the close correction lands, then its own queued scrollToEnd runs '
                 'into a pad that opens as it runs; the frame takes it back below the ledger, the '
                 'report detaches the reader, and the pad reset leaves them free at the strict '
                 'bottom with the pill ({} measured witness).')

VIOLATIONS = {'ChatScroll_MomentumPair_after': {'I_MomentumPairEndpointNotReached': MOMENTUM_ENDPOINT},
 'ChatScroll_MomentumPair_before': {'I_IntentHeld': MOMENTUM_YANK,
                                    'I_MomentumPairEndpointNotReached': MOMENTUM_ENDPOINT},
 'ChatScroll_MomentumPair_first_after': {'I_MomentumPairEndpointNotReached': MOMENTUM_ENDPOINT},
 'ChatScroll_MomentumPair_first_before': {'I_IntentHeld': MOMENTUM_YANK,
                                          'I_MomentumPairEndpointNotReached': MOMENTUM_ENDPOINT},
 'ChatScroll_PKConsumer_after': {'I_PKConsumerEndpointNotReached': 'Required coverage only: the '
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
 'ChatScroll_SendHold_after': {'I_SendHoldEndpointNotReached': SEND_ENDPOINT},
 'ChatScroll_SendHold_before': {'I_IntentHeld': SEND_DETACH,
                                'I_SendHoldEndpointNotReached': SEND_ENDPOINT},
 'ChatScroll_SendHold_closepad': {'I_ModeMatchesGeometry': SEND_CLOSEPAD.format('29- to 30-state'),
                                  'I_PillHonest': SEND_CLOSEPAD.format('30-state'),
                                  'I_SendHoldEndpointNotReached': SEND_ENDPOINT},
 'ChatScroll_SendHold_nowindow': {'I_IntentHeld': SEND_NOWINDOW,
                                  'I_SendHoldEndpointNotReached': SEND_ENDPOINT},
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
