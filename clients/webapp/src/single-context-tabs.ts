import { suppressTabsLocalRestore } from "@/stores/tabs/tabs-local-restore-policy";

/**
 * Declares, before anything else in this bundle runs, that this shell must not
 * restore a persisted tab layout.
 *
 * THE ORDER IS THE MECHANISM. The tab store rehydrates from `localStorage`
 * while its module is being evaluated - before a component mounts, before an
 * effect runs, before the runner host is even consulted - so a shell that says
 * this any later has already had the read happen behind it. Modules evaluate
 * in import order, so this file must stay the FIRST import of the entry, ahead
 * of anything that reaches the shared renderer.
 *
 * Why the answer is "do not restore": that layout is persisted per ORIGIN,
 * while this shell's contexts come from the browser around it. Restoring would
 * hand a freshly opened tab the active surface and split arrangement of a
 * different tab - and with no strip drawn, the person would have no way to see
 * where it came from or to change it. The address the tab was opened at is the
 * only thing that should decide what it shows.
 *
 * A module of its own rather than a line in the entry, because a statement
 * whose correctness IS its position needs somewhere to say so.
 */
suppressTabsLocalRestore();
