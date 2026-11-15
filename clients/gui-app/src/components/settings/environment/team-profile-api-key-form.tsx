import { useSubmittedSecretInput } from "@/hooks/use-submitted-secret-input";
import { useId, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ENVIRONMENT_API_KEY_REPLACE_HARNESSES,
  type EnvironmentApiKeyReplaceResult,
} from "@traycer-clients/shared/host-client/sandbox-secrets";
import type {
  ProviderProfile,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useHostBinding } from "@/lib/host";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { environmentMutationKeys } from "@/lib/query-keys";

const RESULT_COPY: Record<
  Exclude<EnvironmentApiKeyReplaceResult["kind"], "ok">,
  string
> = {
  "binding-changed": "This connection changed. Refresh and try again.",
  "malformed-key": "Couldn't save the API key.",
  unauthorized: "Please sign in again.",
  forbidden: "You don't have permission to do that.",
  "account-unproven": "Couldn't save the API key.",
  removed: "Was removed",
  failed: "Couldn't save the API key.",
};

export function TeamProfileApiKeyForm(props: {
  readonly providerId: ProviderId;
  readonly profile: ProviderProfile;
  readonly environmentId: string;
  readonly reread: () => Promise<unknown>;
}): ReactNode {
  const inputId = useId();
  const auth = useHostBinding()?.auth ?? null;
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<EnvironmentApiKeyReplaceResult | null>(
    null,
  );
  const harnessId = providerIdToGuiHarnessId(props.providerId);
  const submittedKey = useSubmittedSecretInput<string>(
    "Profile key input is unavailable.",
  );
  const replace = useMutation({
    mutationKey: environmentMutationKeys.providersReplaceKey(),
    mutationFn: async (): Promise<EnvironmentApiKeyReplaceResult> => {
      if (auth === null) return { kind: "unauthorized" };
      const key = submittedKey.read();
      try {
        return await auth.replaceEnvironmentApiKey({
          environmentId: props.environmentId,
          profileId: props.profile.profileId,
          harnessId,
          key,
        });
      } catch {
        return { kind: "failed" };
      }
    },
    onMutate: () => setResult(null),
    onSuccess: (answer) => {
      setResult(answer);
      if (answer.kind === "ok") setDraft("");
    },
    onSettled: async () => {
      submittedKey.clear();
      try {
        await props.reread();
      } catch {
        // The page presents its read failure.
      }
    },
  });
  const pending = replace.isPending;
  if (
    props.profile.apiKey?.configured !== true ||
    !ENVIRONMENT_API_KEY_REPLACE_HARNESSES.some((id) => id === harnessId)
  )
    return null;
  const save = (): void => {
    if (pending || draft.trim().length === 0) return;
    submittedKey.set(draft.trim());
    replace.mutate();
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={inputId}
          className="text-ui-sm font-medium text-foreground"
        >
          API key
        </label>
        <span className="text-ui-xs text-muted-foreground">Key set</span>
      </div>
      <div className="flex w-full flex-wrap items-center gap-2">
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          className="w-full min-w-0 flex-1 basis-48"
          placeholder="Replace stored key…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={pending}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
          font="mono"
          size="sm"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pending || draft.trim().length === 0}
          onClick={save}
        >
          {pending ? <MutedAgentSpinner /> : null}Replace key
        </Button>
      </div>
      {result === null || result.kind === "ok" ? null : (
        <p role="status" className="text-ui-xs text-destructive">
          {RESULT_COPY[result.kind]}
        </p>
      )}
    </div>
  );
}
