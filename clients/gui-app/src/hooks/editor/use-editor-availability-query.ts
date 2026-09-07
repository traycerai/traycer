import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { EDITORS, type EditorId } from "@traycer/protocol/host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { editorQueryKeys } from "@/lib/query-keys";

// Editor installs change rarely; a long stale time keeps the open-in-editor
// dropdown from re-probing the OS scheme registry on every panel mount.
const EDITOR_AVAILABILITY_STALE_MS = 5 * 60 * 1000;

function getRunnerHostAvailabilityScope(runnerHost: IRunnerHost): string {
  const hostScope = runnerHost.hasLocalHost ? "local-host" : "no-local-host";
  return `${hostScope}:${runnerHost.authnBaseUrl}:${runnerHost.signInUrl}`;
}

function buildEditorAvailabilityQueryFn(runnerHost: IRunnerHost) {
  return async (): Promise<readonly EditorId[]> => {
    const registered = new Set(
      await runnerHost.getRegisteredUrlSchemes(
        EDITORS.map((editor) => editor.urlScheme),
      ),
    );
    return EDITORS.filter((editor) => registered.has(editor.urlScheme)).map(
      (editor) => editor.id,
    );
  };
}

function editorAvailabilityQueryOptions(runnerHost: IRunnerHost) {
  const runnerHostScope = getRunnerHostAvailabilityScope(runnerHost);
  return queryOptions<readonly EditorId[]>({
    queryKey: editorQueryKeys.availability(runnerHostScope),
    queryFn: buildEditorAvailabilityQueryFn(runnerHost),
    staleTime: EDITOR_AVAILABILITY_STALE_MS,
  });
}

/**
 * OS scheme-handler registry by scheme, never app name or bundle path. The shell answers for the local machine, where `editor.openPaths` opens.
 */
export function useEditorAvailability(): UseQueryResult<readonly EditorId[]> {
  const runnerHost = useRunnerHost();
  return useQuery(editorAvailabilityQueryOptions(runnerHost));
}
