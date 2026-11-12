import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { authMutationKeys } from "@/lib/query-keys/auth-mutation-keys";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

interface SignOutService {
  readonly signOut: () => Promise<boolean>;
}

/** The question and its operation outlive the header/shell seat that draws them. */
interface SignOutConfirmState {
  readonly open: boolean;
  readonly status: "idle" | "pending" | "failed";
  readonly retry: (() => void) | null;
  readonly setOpen: (next: boolean) => void;
  readonly signOut: (
    queryClient: QueryClient,
    auth: SignOutService,
  ) => Promise<void>;
}

let sessionGeneration = 0;
let inFlight: Promise<void> | null = null;

export const useSignOutConfirmStore = create<SignOutConfirmState>(
  (set, get) => ({
    open: false,
    status: "idle",
    retry: null,
    setOpen: (next) => {
      if (!next && get().status === "pending") return;
      if (next) set({ open: true });
      else set({ open: false, status: "idle", retry: null });
    },
    signOut: (queryClient, auth) => {
      if (inFlight !== null) return inFlight;
      const generation = sessionGeneration;
      set({ status: "pending" });
      const mutation = queryClient.getMutationCache().build(queryClient, {
        mutationKey: authMutationKeys.signOut(),
        mutationFn: async () => {
          if (!(await auth.signOut())) {
            throw new Error("Couldn't sign out. Please try again.");
          }
        },
      });
      const operation = mutation.execute(undefined).then(
        () => {
          if (generation === sessionGeneration) {
            set({ open: false, status: "idle", retry: null });
          }
          if (
            generation === sessionGeneration ||
            !admitsLocalPlane(useAuthStore.getState().status)
          ) {
            useMobileNavStore.getState().setOpen(false);
          }
        },
        () => {
          if (generation !== sessionGeneration) return;
          set({
            open: true,
            status: "failed",
            retry: () => {
              void get().signOut(queryClient, auth);
            },
          });
        },
      );
      inFlight = operation;
      void operation.finally(() => {
        if (inFlight === operation) inFlight = null;
      });
      return operation;
    },
  }),
);

useAuthStore.subscribe((state, previous) => {
  const sessionEnded =
    !admitsLocalPlane(state.status) ||
    state.profile?.userId !== previous.profile?.userId;
  if (sessionEnded) {
    sessionGeneration += 1;
    inFlight = null;
    useSignOutConfirmStore.setState({
      open: false,
      status: "idle",
      retry: null,
    });
  }
});
