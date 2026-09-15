# macOS installer artwork

The desktop `package.json` merges the exported DMG layout into its existing
electron-builder configuration. Assets live here because `build/` is ignored.

- `assets/dmg-background.png` is the original 642×406, 1x export. Its text,
  arrow, and label backgrounds are baked in; do not draw them again.
- `assets/app-icon.png` is the original optional 512×512 reference. The same
  artwork already exists in the app's higher-resolution `../icon.png` and
  native `../icon.icns`; packaging continues to use that existing icon pipeline.
- Finder supplies the app icon, Applications link, and filename labels. The
  app entry deliberately omits `path` so the packaged app is used.

Before release, mount the DMG on macOS and check label fit. The supplied app
label background is only about 53 pixels wide: `Traycer.app` with its extension
visible, and the staging name `Traycer Staging`, need particular attention.
The staging release inherits this layout without changing its app identity.
Retina artwork was not supplied.
