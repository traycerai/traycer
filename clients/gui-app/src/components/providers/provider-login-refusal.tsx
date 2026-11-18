import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderId,
  type ProviderLoginRefusal,
} from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { useOpenLink } from "@/lib/links/open-link";

/**
 * A provider's refusal of a sign-in (`providers.awaitLogin@2.2`): the consent
 * page can succeed and the provider still turn the sign-in down. Antigravity
 * does this for an account Google wants verified first. The headline says
 * which side ended it, without claiming more than the host knows about why;
 * the reason is the provider's own words, rendered as text.
 */
export function ProviderLoginRefusalMessage({
  providerId,
  refusal,
}: {
  readonly providerId: ProviderId;
  readonly refusal: ProviderLoginRefusal;
}): ReactNode {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="font-medium">
        {PROVIDER_DISPLAY_NAMES[providerId]} turned down this sign-in.
      </span>
      <span className="whitespace-pre-line break-words">{refusal.reason}</span>
    </span>
  );
}

/**
 * Opens the link the provider sends the user to (the host has already held it
 * to the provider's own sign-in hosts). Nothing when it offered none.
 */
export function ProviderLoginRefusalAction({
  refusal,
}: {
  readonly refusal: ProviderLoginRefusal | null;
}): ReactNode {
  const openLink = useOpenLink();
  const actionUrl = refusal?.actionUrl ?? null;
  if (actionUrl === null) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={(event) => {
        void openLink(actionUrl, "auth", event);
      }}
    >
      <ExternalLink className="size-3.5" />
      Verify account
    </Button>
  );
}
