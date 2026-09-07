import { create } from "zustand";

interface HostBootDetailsState {
  readonly open: boolean;
  // `this: void` because consumers SELECT these off the store (`useHostBootDetailsStore((s) =>
  // s.setOpen)`), which detaches them from the object they were declared on.
  setOpen(this: void, open: boolean): void;
  reset(this: void): void;
}

/**
 * Whether the boot card's `Show details` disclosure is expanded. STORE-SCOPED RATHER THAN
 * COMPONENT-SCOPED, because the disclosure outlives the component that draws it.
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
