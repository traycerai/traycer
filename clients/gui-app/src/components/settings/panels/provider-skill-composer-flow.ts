import type {
  ProviderNativeScope,
  ProviderSkillInspectCandidate,
  ProvidersSkillsMutateAction,
} from "@traycer/protocol/host/provider-native-schemas";
import type { SkillsMutateData } from "@/hooks/providers/native-response-map";
import {
  composerErrorMessage,
  isExternalDriftError,
  preselectSkillNames,
  skillNamesFromSourceFlags,
  type SkillComposerStep,
} from "./provider-skill-composer-model";

export type ComposerInspectSession = {
  readonly token: string;
  readonly candidates: readonly ProviderSkillInspectCandidate[];
};

export type ComposerFlowState = {
  readonly source: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly providerScoped: boolean;
  readonly selectedNames: readonly string[];
  readonly inspectSession: ComposerInspectSession | null;
  readonly canInspect: boolean;
  readonly listScope: ProviderNativeScope;
};

export type ComposerFlowSink = {
  readonly onMutate: (
    mutation: ProvidersSkillsMutateAction,
  ) => Promise<SkillsMutateData>;
  readonly onClose: () => void;
  readonly setError: (value: string | null) => void;
  readonly setInspectSession: (value: ComposerInspectSession | null) => void;
  readonly setSelectedNames: (value: readonly string[]) => void;
  readonly setPickerNote: (value: string | null) => void;
};

export const SHA_MISMATCH_NOTE =
  "The source changed since the last look. Pick again from the updated list.";

export async function submitComposer(args: {
  readonly step: SkillComposerStep;
  readonly pending: boolean;
  readonly blocker: string | null;
  readonly state: ComposerFlowState;
  readonly sink: ComposerFlowSink;
}): Promise<void> {
  if (args.blocker !== null || args.pending) return;
  args.sink.setError(null);

  if (args.step === "write") {
    await submitWrite(args.state, args.sink);
    return;
  }
  if (args.step === "picker") {
    if (args.state.inspectSession === null) return;
    try {
      await installWithToken(
        args.state.inspectSession.token,
        args.state.selectedNames,
        args.state,
        args.sink,
      );
    } catch (err) {
      await handleInstallError(err, args.state, args.sink);
    }
    return;
  }
  if (args.state.canInspect) {
    await submitInspect(args.state, args.sink);
    return;
  }
  await submitLegacyImport(args.state, args.sink);
}

async function submitWrite(
  state: ComposerFlowState,
  sink: ComposerFlowSink,
): Promise<void> {
  try {
    await sink.onMutate({
      action: "create",
      name: state.name.trim(),
      description: state.description.trim(),
      body: state.body,
      providerScoped: state.providerScoped,
    });
    sink.onClose();
  } catch (err) {
    sink.setError(composerErrorMessage(err));
  }
}

async function submitLegacyImport(
  state: ComposerFlowState,
  sink: ComposerFlowSink,
): Promise<void> {
  try {
    await sink.onMutate({
      action: "import",
      source: state.source.trim(),
      providerScoped: state.providerScoped,
    });
    sink.onClose();
  } catch (err) {
    sink.setError(composerErrorMessage(err));
  }
}

async function submitInspect(
  state: ComposerFlowState,
  sink: ComposerFlowSink,
): Promise<void> {
  try {
    const data = await sink.onMutate({
      action: "inspect",
      source: state.source.trim(),
      scope: state.listScope,
    });
    await applyInspect(data, "fresh", state, sink);
  } catch (err) {
    sink.setError(composerErrorMessage(err));
  }
}

async function installWithToken(
  token: string,
  names: readonly string[],
  state: ComposerFlowState,
  sink: ComposerFlowSink,
): Promise<void> {
  const data = await sink.onMutate({
    action: "import",
    source: state.source.trim(),
    providerScoped: state.providerScoped,
    token,
    names: [...names],
  });
  if (data.kind === "inspect") {
    await applyInspect(data, "fresh", state, sink);
    return;
  }
  sink.onClose();
}

async function applyInspect(
  data: SkillsMutateData,
  inspectMode: "fresh" | "sha-refresh",
  state: ComposerFlowState,
  sink: ComposerFlowSink,
): Promise<void> {
  if (data.kind !== "inspect") {
    sink.onClose();
    return;
  }
  if (data.candidates.length === 0) {
    sink.setInspectSession(null);
    sink.setSelectedNames([]);
    sink.setError("No SKILL.md found in that source.");
    return;
  }
  const only = data.candidates[0];
  // An uninstalled singleton is unambiguous and safe to land immediately.
  // An installed singleton is an overwrite - send it through the picker so
  // the badge and the "this replaces what is on disk" copy are visible
  // before Install commits.
  if (
    inspectMode === "fresh" &&
    data.candidates.length === 1 &&
    !only.installed
  ) {
    try {
      await installWithToken(data.token, [only.name], state, sink);
    } catch (err) {
      await handleInstallError(err, state, sink);
    }
    return;
  }
  sink.setInspectSession({
    token: data.token,
    candidates: data.candidates,
  });
  if (data.candidates.length === 1) {
    sink.setSelectedNames([only.name]);
  } else {
    sink.setSelectedNames(
      preselectSkillNames(
        data.candidates,
        skillNamesFromSourceFlags(state.source),
      ),
    );
  }
}

async function handleInstallError(
  err: unknown,
  state: ComposerFlowState,
  sink: ComposerFlowSink,
): Promise<void> {
  if (!isExternalDriftError(err) || !state.canInspect) {
    sink.setError(composerErrorMessage(err));
    return;
  }
  sink.setPickerNote(SHA_MISMATCH_NOTE);
  try {
    const data = await sink.onMutate({
      action: "inspect",
      source: state.source.trim(),
      scope: state.listScope,
    });
    await applyInspect(data, "sha-refresh", state, sink);
  } catch (inspectErr) {
    sink.setError(composerErrorMessage(inspectErr));
  }
}
