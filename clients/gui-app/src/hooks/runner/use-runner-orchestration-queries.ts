import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ITraycerCli,
  TraycerOrchestration,
  TraycerOrchestrationRole,
  TraycerRoleModelInfo,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

// ─── Orchestration list ─────────────────────────────────────────────────────

function orchestrationListQueryOptions(traycerCli: ITraycerCli | null) {
  return queryOptions<readonly string[]>({
    queryKey:
      traycerCli !== null
        ? runnerQueryKeys.traycerOrchestrationList(traycerCli)
        : ["runner.traycer.orchestrationList", "disabled"],
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.orchestrationList();
    },
    enabled: traycerCli !== null,
  });
}

export function useRunnerOrchestrationListQuery(): UseQueryResult<
  readonly string[]
> {
  const runnerHost = useRunnerHost();
  return useQuery(orchestrationListQueryOptions(runnerHost.traycerCli));
}

// ─── Orchestration show ─────────────────────────────────────────────────────

function orchestrationShowQueryOptions(
  traycerCli: ITraycerCli | null,
  name: string,
) {
  return queryOptions<TraycerOrchestration | null>({
    queryKey:
      traycerCli !== null
        ? runnerQueryKeys.traycerOrchestrationShow(traycerCli, name)
        : ["runner.traycer.orchestrationShow", "disabled", name],
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.orchestrationShow({ name });
    },
    enabled: traycerCli !== null && name.length > 0,
  });
}

export function useRunnerOrchestrationShowQuery(
  name: string,
): UseQueryResult<TraycerOrchestration | null> {
  const runnerHost = useRunnerHost();
  return useQuery(orchestrationShowQueryOptions(runnerHost.traycerCli, name));
}

// ─── Orchestration roles ────────────────────────────────────────────────────

function orchestrationRolesQueryOptions(
  traycerCli: ITraycerCli | null,
  name: string,
) {
  return queryOptions<readonly TraycerOrchestrationRole[]>({
    queryKey:
      traycerCli !== null
        ? runnerQueryKeys.traycerOrchestrationRoles(traycerCli, name)
        : ["runner.traycer.orchestrationRoles", "disabled", name],
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.orchestrationRoles({ name });
    },
    enabled: traycerCli !== null && name.length > 0,
  });
}

export function useRunnerOrchestrationRolesQuery(
  name: string,
): UseQueryResult<readonly TraycerOrchestrationRole[]> {
  const runnerHost = useRunnerHost();
  return useQuery(orchestrationRolesQueryOptions(runnerHost.traycerCli, name));
}

// ─── Orchestration models ───────────────────────────────────────────────────

function orchestrationModelsQueryOptions(
  traycerCli: ITraycerCli | null,
  name: string,
  roleId: string,
  group: string | undefined,
) {
  return queryOptions<TraycerRoleModelInfo | null>({
    queryKey:
      traycerCli !== null
        ? runnerQueryKeys.traycerOrchestrationModels(
            traycerCli,
            name,
            roleId,
            group,
          )
        : ["runner.traycer.orchestrationModels", "disabled", name, roleId],
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.orchestrationModels({ name, roleId, group });
    },
    enabled: traycerCli !== null && name.length > 0 && roleId.length > 0,
  });
}

export function useRunnerOrchestrationModelsQuery(
  name: string,
  roleId: string,
  group: string | undefined,
): UseQueryResult<TraycerRoleModelInfo | null> {
  const runnerHost = useRunnerHost();
  return useQuery(
    orchestrationModelsQueryOptions(runnerHost.traycerCli, name, roleId, group),
  );
}

// ─── Orchestration responsibility ───────────────────────────────────────────

function orchestrationResponsibilityQueryOptions(
  traycerCli: ITraycerCli | null,
  name: string,
  roleId: string,
) {
  return queryOptions<string | null>({
    queryKey:
      traycerCli !== null
        ? runnerQueryKeys.traycerOrchestrationResponsibility(
            traycerCli,
            name,
            roleId,
          )
        : [
            "runner.traycer.orchestrationResponsibility",
            "disabled",
            name,
            roleId,
          ],
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.orchestrationResponsibility({ name, roleId });
    },
    enabled: traycerCli !== null && name.length > 0 && roleId.length > 0,
  });
}

export function useRunnerOrchestrationResponsibilityQuery(
  name: string,
  roleId: string,
): UseQueryResult<string | null> {
  const runnerHost = useRunnerHost();
  return useQuery(
    orchestrationResponsibilityQueryOptions(
      runnerHost.traycerCli,
      name,
      roleId,
    ),
  );
}

// ─── Orchestration groups ───────────────────────────────────────────────────

function orchestrationGroupsQueryOptions(traycerCli: ITraycerCli | null) {
  return queryOptions<readonly string[]>({
    queryKey:
      traycerCli !== null
        ? runnerQueryKeys.traycerOrchestrationGroups(traycerCli)
        : ["runner.traycer.orchestrationGroups", "disabled"],
    queryFn: () => {
      if (traycerCli === null) {
        throw new Error("traycerCli unavailable on this runner host");
      }
      return traycerCli.orchestrationGroups();
    },
    enabled: traycerCli !== null,
  });
}

export function useRunnerOrchestrationGroupsQuery(): UseQueryResult<
  readonly string[]
> {
  const runnerHost = useRunnerHost();
  return useQuery(orchestrationGroupsQueryOptions(runnerHost.traycerCli));
}

// ─── Mutations ──────────────────────────────────────────────────────────────

function useInvalidateOrchestrations() {
  const queryClient = useQueryClient();
  const runnerHost = useRunnerHost();
  return () => {
    if (runnerHost.traycerCli !== null) {
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerOrchestrationList(
          runnerHost.traycerCli,
        ),
      });
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerOrchestrationGroups(
          runnerHost.traycerCli,
        ),
      });
    }
  };
}

export function useRunnerOrchestrationCreateMutation() {
  const runnerHost = useRunnerHost();
  const invalidate = useInvalidateOrchestrations();
  return useMutation({
    mutationFn: (input: {
      name: string;
      description: string | undefined;
      from: string | undefined;
    }) => {
      if (runnerHost.traycerCli === null) {
        throw new Error("traycerCli unavailable");
      }
      return runnerHost.traycerCli.orchestrationCreate(input);
    },
    onSuccess: invalidate,
  });
}

export function useRunnerOrchestrationDeleteMutation() {
  const runnerHost = useRunnerHost();
  const invalidate = useInvalidateOrchestrations();
  return useMutation({
    mutationFn: (input: { name: string }) => {
      if (runnerHost.traycerCli === null) {
        throw new Error("traycerCli unavailable");
      }
      return runnerHost.traycerCli.orchestrationDelete(input);
    },
    onSuccess: invalidate,
  });
}

export function useRunnerOrchestrationGroupSaveMutation() {
  const runnerHost = useRunnerHost();
  const invalidate = useInvalidateOrchestrations();
  return useMutation({
    mutationFn: (input: { name: string; group: unknown }) => {
      if (runnerHost.traycerCli === null) {
        throw new Error("traycerCli unavailable");
      }
      return runnerHost.traycerCli.orchestrationGroupSave(
        input as Parameters<
          typeof runnerHost.traycerCli.orchestrationGroupSave
        >[0],
      );
    },
    onSuccess: invalidate,
  });
}

export function useRunnerOrchestrationGroupDeleteMutation() {
  const runnerHost = useRunnerHost();
  const invalidate = useInvalidateOrchestrations();
  return useMutation({
    mutationFn: (input: { name: string }) => {
      if (runnerHost.traycerCli === null) {
        throw new Error("traycerCli unavailable");
      }
      return runnerHost.traycerCli.orchestrationGroupDelete(input);
    },
    onSuccess: invalidate,
  });
}

export function useRunnerOrchestrationRoleSaveMutation() {
  const runnerHost = useRunnerHost();
  const invalidate = useInvalidateOrchestrations();
  return useMutation({
    mutationFn: (input: {
      name: string;
      role: {
        id: string;
        label: string;
        description: string;
        tier: string;
        isRoot: boolean;
        responsibility: string;
      };
    }) => {
      if (runnerHost.traycerCli === null) {
        throw new Error("traycerCli unavailable");
      }
      return runnerHost.traycerCli.orchestrationRoleSave(input);
    },
    onSuccess: invalidate,
  });
}

export function useRunnerOrchestrationRoleDeleteMutation() {
  const runnerHost = useRunnerHost();
  const invalidate = useInvalidateOrchestrations();
  return useMutation({
    mutationFn: (input: { name: string; roleId: string }) => {
      if (runnerHost.traycerCli === null) {
        throw new Error("traycerCli unavailable");
      }
      return runnerHost.traycerCli.orchestrationRoleDelete(input);
    },
    onSuccess: invalidate,
  });
}
