# Resolution Matrix Harness

Run from `clients/desktop`:

```bash
bun run test:resolution
```

The script builds the desktop shell with a non-secret local-storage test key,
launches Electron once or twice per matrix case with throwaway `userData` and
`HOME` directories, applies `--force-device-scale-factor`, pins the window
bounds, asserts zoom behavior, and captures renderer screenshots under
`clients/desktop/dist/resolution-snapshots/<timestamp>/`.

Matrix:

- baseline `1366x768@1x` and `1920x1080@1x`, seeded at `100%`
- fresh `2560x1440@1x`, asserting the first-run heuristic persists `125%`
- fresh `2560x1440@1.5x`, asserting OS-scaled displays stay at `100%`
- fresh `3840x2160@1x`, asserting the first-run heuristic persists `150%`
- persisted `150%` relaunch at `1920x1080@1x`, asserting explicit zoom survives
  a second launch

The manifest records screenshot paths, estimated zoom factor, first rendered tab
width when a tab is present, the discovered zoom preference JSON, and each
assertion result. Baseline scenarios seed `window-zoom.json`; heuristic
scenarios start from a fresh profile with no zoom file so the first-run resolver
is exercised.

Fresh profiles usually start at the signed-out or host gate. Tab-width cap
assertions run when a header tab is present and are recorded as skipped when the
profile has no rendered tab.

Set `TRAYCER_RESOLUTION_KEEP_PROFILES=1` to keep the temporary profile
directories for inspection.
