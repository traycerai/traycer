import { vi } from "vitest";

export function queryResultWithCode(nowMs: number) {
  return {
    isPending: false,
    isError: false,
    isRefetching: false,
    error: null,
    refetch: vi.fn(),
    data: {
      code: "ABCDE-FGHJK",
      expires_in: 60,
      expires_at: Math.floor(nowMs / 1000) + 60,
    },
  };
}

export function statusResult(data: unknown) {
  return {
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    data,
  };
}

export function claimedStatus(claimedAtMs: number, userAgent: string) {
  return {
    status: "claimed",
    claimant: {
      address: "192.168.29.87",
      userAgent,
      location: "Bengaluru, IN",
      claimedAt: claimedAtMs,
    },
  };
}

export function claimedStatusWithCode(
  claimedAtMs: number,
  userAgent: string,
  matchCode: string | null,
) {
  const status = claimedStatus(claimedAtMs, userAgent);
  return { ...status, claimant: { ...status.claimant, matchCode } };
}
