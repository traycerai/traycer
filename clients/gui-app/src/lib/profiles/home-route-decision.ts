/**
 * Whether the signed-in `/` beforeLoad should redirect to `/draft/new`.
 *
 * When the active profile is null ("All projects"), the home route is the
 * aggregate home surface and must not bounce away. When a profile is active
 * and no tabs were restored, send the user to a fresh draft (the locked
 * composer is that project's home until launch-landing jumps to an epic).
 */
export function shouldRedirectHomeToDraft(
  hasRestoredTabs: boolean,
  activeProfileId: string | null,
): boolean {
  return !hasRestoredTabs && activeProfileId !== null;
}
