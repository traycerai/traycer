import { create } from "zustand";
import type { HostCredentialState } from "@traycer/protocol/framework/stream-ws-protocol";

interface HostCredentialStatusDisplay {
  readonly reports: Readonly<Record<string, HostCredentialState | undefined>>;
  readonly report: (hostId: string, state: HostCredentialState) => void;
}

/** Last reported status for presentation only; it never authorizes a mint. */
export const useHostCredentialStatusStore = create<HostCredentialStatusDisplay>(
  (set) => ({
    reports: {},
    report: (hostId, report) =>
      set((state) =>
        state.reports[hostId] === report
          ? state
          : { reports: { ...state.reports, [hostId]: report } },
      ),
  }),
);
