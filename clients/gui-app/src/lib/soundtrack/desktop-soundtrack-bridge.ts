export type SoundtrackSetReadResult =
  | { readonly kind: "ok"; readonly manifest: unknown }
  | { readonly kind: "unavailable" };

/** The members of the desktop preload bridge that reach the team's track set. */
export interface DesktopSoundtrackBridge {
  readonly soundtrackSourceAvailable: true;
  readonly readSoundtrackSet: () => Promise<SoundtrackSetReadResult>;
}

function isDesktopSoundtrackBridge(
  value: unknown,
): value is DesktopSoundtrackBridge {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "soundtrackSourceAvailable") === true &&
    typeof Reflect.get(value, "readSoundtrackSet") === "function"
  );
}

/**
 * The bridge, on a desktop build that has a track set to read. The gate is read
 * at render, before any runtime exists, so this goes to the global. A web or
 * mobile build has no such bridge and a production desktop build reports no
 * source, so each answers null.
 *
 * Its own module, with nothing imported, because whether the build offers
 * a soundtrack is read by the settings section table, which every surface
 * imports; reading the set itself (`desktop-set.ts`) needs the query client.
 */
export function desktopSoundtrackBridge(): DesktopSoundtrackBridge | null {
  const host: unknown = Reflect.get(globalThis, "runnerHost");
  return isDesktopSoundtrackBridge(host) ? host : null;
}
