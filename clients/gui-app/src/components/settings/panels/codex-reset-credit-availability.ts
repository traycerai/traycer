import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { createElement, type ReactNode } from "react";
import { CodexResetCreditAction } from "@/components/settings/panels/codex-reset-credit-action";

export function resolveCodexResetCreditAction(
  providerId: ProviderId,
  profileId: string | null,
  enabled: boolean,
): ReactNode {
  if (!enabled || providerId !== "codex") return null;
  return createElement(CodexResetCreditAction, { profileId });
}
