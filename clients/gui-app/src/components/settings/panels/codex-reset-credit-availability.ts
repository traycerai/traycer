import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { createElement } from "react";
import { CodexResetCreditAction } from "@/components/settings/panels/codex-reset-credit-action";
import type { CodexResetCreditActionRenderer } from "@/components/settings/panels/codex-reset-credit-model";

export function resolveCodexResetCreditAction(
  providerId: ProviderId,
  profileId: string | null,
  enabled: boolean,
): CodexResetCreditActionRenderer | null {
  if (!enabled || providerId !== "codex") return null;
  return (details) =>
    createElement(CodexResetCreditAction, {
      profileId,
      selectedCredit: details.selectedCredit,
      availableCount: details.availableCount,
    });
}
