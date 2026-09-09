import { createContext, use } from "react";

/**
 * Whether the app-wide session strip is currently showing a bar.
 *
 * ONE bar on screen at a time. The app-wide strip, the Epic's strip and a
 * chat's strip all report the same class of fact - a connection coming back -
 * and an app switch drops every one of those legs in the same tick, so without
 * a rule they appear stacked, saying the same thing three times. The outermost
 * one that is speaking wins; each inner surface defers to it and takes over
 * when it stops, so the indicator is continuous from the first drop until
 * everything on screen is current.
 *
 * Published from the shell rather than re-derived below, because
 * `useHostSessionConnectivity` builds a store per call - its own poll timer,
 * its own latched episode, its own announce and escalate deadlines. Two callers
 * are two episodes that can disagree about whether anything is on screen, which
 * is the disagreement this rule exists to prevent.
 *
 * Defaults to `false` with no provider: a tree that has no app-wide strip
 * (desktop, and every test that mounts a surface on its own) has nothing to
 * defer to.
 */
export const AppConnectivityStripContext = createContext<boolean>(false);

export function useAppConnectivityStripShowing(): boolean {
  return use(AppConnectivityStripContext);
}
