import { create } from "zustand";

interface HostBootDetailsState {
  readonly open: boolean;
  // `this: void` because consumers SELECT these off the store
  // (`useHostBootDetailsStore((s) => s.setOpen)`), which detaches them from
  // the object they were declared on.
  setOpen(this: void, open: boolean): void;
  reset(this: void): void;
}

/**
 * Whether the boot card's `Show details` disclosure is expanded.
 *
 * STORE-SCOPED RATHER THAN COMPONENT-SCOPED, because the disclosure outlives
 * the component that draws it. A launch crosses three separate surfaces - the
 * runtime fallback, the gate's attach cover, and the window narrator's startup
 * card - and they are different React trees, so each hand-off UNMOUNTS the
 * disclosure and a `useState` open flag died with it. A user who opened the
 * log to watch a slow start had it snap shut under them at the exact moments
 * something interesting was happening, and the only way back was to re-open it
 * on the next surface.
 *
 * DELIBERATELY NOT PERSISTED. This is a debugging affordance for the launch in
 * front of you, not a preference: carrying it across app restarts would greet
 * the next cold start with an expanded log tail nobody asked for. `reset` is
 * for tests, which must not inherit one case's expansion.
 */
export const useHostBootDetailsStore = create<HostBootDetailsState>((set) => ({
  open: false,
  setOpen: (open) => {
    set({ open });
  },
  reset: () => {
    set({ open: false });
  },
}));
