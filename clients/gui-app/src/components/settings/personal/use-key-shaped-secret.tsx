import { useConfigurationKey } from "@/components/settings/environment/use-configuration-key";
import { useState, type ReactNode } from "react";
import type { KeyRefusal } from "@/components/settings/panels/env-override-editor";
import {
  AddSecretDialog,
  type SecretPrefill,
} from "@/components/settings/secrets/add-secret-dialog";
import { usePersonalHostState } from "@/components/settings/personal/personal-page-context";
import { useHostClient } from "@/lib/host";

/**
 * A value that looks like a key, typed where every computer running Personal
 * would get it as a plain variable, is refused there so a secret has one
 * home. `refusal` is "This looks like a key. Add it as a secret.", whose link
 * opens Add a secret with the name and value filled in; `null` where no such
 * value is refused (outside a Personal page, or on a host not running
 * Personal). `dialog` is that Add a secret, rendered by the page.
 */
export function useKeyShapedSecret(): {
  readonly refusal: KeyRefusal | null;
  readonly dialog: ReactNode;
} {
  const client = useHostClient();
  const state = usePersonalHostState();
  const configurationKey = useConfigurationKey();
  const [prefill, setPrefill] = useState<SecretPrefill | null>(null);
  // While the host's status is not known yet it may run Personal, so the
  // value is refused then too rather than stored first.
  const refuses = state?.kind === "ready" || state?.kind === "unknown";
  return {
    refusal: refuses
      ? {
          before: "This looks like a key. ",
          link: "Add it as a secret.",
          after: "",
          clearsValue: false,
          onLink: (name, value) => setPrefill({ name, value }),
        }
      : null,
    dialog:
      prefill === null ? null : (
        <AddSecretDialog
          // Keyed by configuration: a half-filled form stays with the
          // configuration it was started in.
          key={configurationKey}
          open
          prefill={prefill}
          client={client}
          onOpenChange={(open) => {
            if (!open) setPrefill(null);
          }}
        />
      ),
  };
}
