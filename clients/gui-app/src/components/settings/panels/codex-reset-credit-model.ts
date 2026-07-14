import type { ReactNode } from "react";
import type { ProviderRateLimits } from "@traycer/protocol/host";

type CodexRateLimits = Extract<ProviderRateLimits, { provider: "codex" }>;

export type CodexResetCredits = NonNullable<CodexRateLimits["resetCredits"]>;

export type CodexResetCredit = NonNullable<
  CodexResetCredits["credits"]
>[number];

export interface CodexResetCreditActionDetails {
  readonly selectedCredit: CodexResetCredit | null;
  readonly availableCount: number;
}

export type CodexResetCreditActionRenderer = (
  details: CodexResetCreditActionDetails,
) => ReactNode;

function compareResetCreditExpiry(
  left: CodexResetCredit,
  right: CodexResetCredit,
): number {
  if (left.expiresAt === null && right.expiresAt === null) return 0;
  if (left.expiresAt === null) return 1;
  if (right.expiresAt === null) return -1;
  return left.expiresAt - right.expiresAt;
}

export function visibleCodexResetCredits(
  credits: ReadonlyArray<CodexResetCredit>,
): ReadonlyArray<CodexResetCredit> {
  return credits
    .filter((credit) => credit.status !== "redeemed")
    .slice()
    .sort(compareResetCreditExpiry);
}

export function selectEarliestExpiringCodexResetCredit(
  credits: ReadonlyArray<CodexResetCredit>,
  now: number,
): CodexResetCredit | null {
  return (
    credits
      .filter(
        (credit) =>
          credit.status === "available" &&
          (credit.expiresAt === null || credit.expiresAt > now),
      )
      .slice()
      .sort(compareResetCreditExpiry)[0] ?? null
  );
}
