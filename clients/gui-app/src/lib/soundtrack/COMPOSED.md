# Composed soundtrack contract

Published v1 remains `v1.json` and contains generative tracks with no `kind`.
The renderer normalizes those to `kind: "generative"`. A v2 catalog uses
`version: 2`, explicitly tags every generative track with that kind, and adds
composed tracks shaped `{ kind: "composed", name, title, recording }`. The
`recording` names one entry `{ name, file }` in `stems.recordings`; existing
`stems.tracks` and view pools retain their v1 shape. Track and recording names
must be unique, every view and recording reference must resolve, and a composed
track cannot carry generative fields. Desktop opts into `v2.json` through
`SoundtrackSourceOptions.manifestVersion`; its default remains v1. Paths use
exactly the same relative-object restrictions and signed URL handling as stems.
The publisher and production selection of v2 remain ST15 work.

The existing decoded LRU, in-flight deduplication and one-refresh-on-refusal
apply to recordings as well as stems. Cache identity is catalog identity without
signed query strings; refresh refuses a changed catalog. The 512 MiB cache
limit does not include buffers still retained by active voices, and a single
oversized decoded buffer can exceed it. Pilot memory measurement remains needed.

Both player kinds implement start, elapsed, fade, stop, rewind, hold, release and
description. Generative scheduling and state planning remain on `TrackPlayer`.
Composed playback uses the audio clock and decoded duration; stopped sources
invalidate their completion callback and pending loads. Natural completion
advances once; an exhausted resume offset completes without creating a source.
A composed singleton repeats after the existing quiet gap. This is not mixed
selection, protected navigation or final recording-log semantics: ST14 owns
those. The existing shared mix graph supplies volume, ducking and capture. Composed
playback clears the generative low-pass dim on replan, keeping its authored mix
neutral. An explicit skip uses the requested crossfade at the actual decoded
start; starts from silence use a short click-prevention envelope.

For a local owned fixture, run `python3 clients/gui-app/scripts/soundtrack-composed-fixture.py /tmp/traycer-composed-fixture`, serve that directory on the development soundtrack server at port 8765, and use the default dev manifest URL. The generator creates a short synthetic WAV; no soundtrack audio is published by this change.
