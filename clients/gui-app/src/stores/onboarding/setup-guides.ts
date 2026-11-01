/**
 * The optional setup guides, as data.
 *
 * React-free and leaf on purpose: the store owns progress, and the product code
 * a guide waits on (the login import) reports an EVENT. Neither names a guide
 * id, so a guide's rules live here and nowhere else.
 */

/**
 * Something the product did that a guide is waiting for. The call site reports
 * what happened; this table decides which guide, if any, cares.
 */
export type SetupGuideEvent = "browser-logins-imported";

export interface SetupGuide {
  /** The stored progress value that means complete. */
  readonly length: number;
  /** The event that finishes the guide. */
  readonly completesOn?: SetupGuideEvent;
  /** Offered only where the desktop browser bridge exists. */
  readonly requiresBrowserView?: true;
}

const SETUP_GUIDES = {
  agents: { length: 3 },
  appearance: { length: 6 },
  cookies: {
    length: 2,
    completesOn: "browser-logins-imported",
    requiresBrowserView: true,
  },
} satisfies Record<string, SetupGuide>;

export type SetupGuideId = keyof typeof SETUP_GUIDES;

function isSetupGuideId(key: string): key is SetupGuideId {
  return key in SETUP_GUIDES;
}

export const SETUP_GUIDE_IDS: ReadonlyArray<SetupGuideId> =
  Object.keys(SETUP_GUIDES).filter(isSetupGuideId);

/**
 * The widening accessor. The table is written as literals so its events are
 * checked where they are typed; reading a guide's optional flags needs the
 * declared shape rather than the literal one.
 */
function setupGuide(id: SetupGuideId): SetupGuide {
  return SETUP_GUIDES[id];
}

/** The stored progress value that means a guide is complete. */
export function setupGuideLength(id: SetupGuideId): number {
  return setupGuide(id).length;
}

/** The guide this event finishes, if any. */
export function setupGuideCompletedBy(
  event: SetupGuideEvent,
): SetupGuideId | null {
  return (
    SETUP_GUIDE_IDS.find((id) => setupGuide(id).completesOn === event) ?? null
  );
}

/** What this shell can offer a guide. */
export interface SetupGuideShell {
  readonly browserView: boolean;
}

/**
 * Whether a guide can be completed here at all. A guide that cannot is left
 * out of the checklist's totals: counting a step nobody can take leaves the
 * panel one short forever and keeps the "you're all set" nudge alive.
 */
function isSetupGuideAvailable(
  id: SetupGuideId,
  shell: SetupGuideShell,
): boolean {
  return setupGuide(id).requiresBrowserView !== true || shell.browserView;
}

export function availableSetupGuideIds(
  shell: SetupGuideShell,
): ReadonlyArray<SetupGuideId> {
  return SETUP_GUIDE_IDS.filter((id) => isSetupGuideAvailable(id, shell));
}
