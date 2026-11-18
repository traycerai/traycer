import { useEffect } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import type { DesktopZoomBridge } from "@/lib/windows/types";

export function useRunnerZoomPercentQuery(
  zoom: DesktopZoomBridge | null,
): UseQueryResult<number> {
  const cacheScope = getZoomCacheScope(zoom);
  return useQuery(
    queryOptions<number>({
      queryKey: runnerQueryKeys.zoomPercent(cacheScope),
      queryFn: () => readZoomPercent(cacheScope),
      enabled: cacheScope !== null,
    }),
  );
}

export function useRunnerZoomChangeSubscription(
  zoom: DesktopZoomBridge | null,
): void {
  const queryClient = useQueryClient();
  const cacheScope = getZoomCacheScope(zoom);
  useEffect(() => {
    if (zoom === null) return;
    const subscription = zoom.onChange((percent) => {
      writeZoomPercent(queryClient, cacheScope, percent);
    });
    return () => {
      subscription.dispose();
    };
  }, [cacheScope, queryClient, zoom]);
}

export function useRunnerZoomSetMutation(
  zoom: DesktopZoomBridge | null,
): UseMutationResult<number, Error, number> {
  const queryClient = useQueryClient();
  const cacheScope = getZoomCacheScope(zoom);
  return useMutation<number, Error, number>({
    mutationKey: runnerMutationKeys.zoomSet(cacheScope),
    mutationFn: (percent) => {
      if (zoom === null) {
        throw new Error("Desktop zoom is unavailable");
      }
      return zoom.set(percent);
    },
    onSuccess: (percent) => {
      writeZoomPercent(queryClient, cacheScope, percent);
    },
    onError: (err) => toastFromRunnerError(err, "Couldn't update zoom"),
  });
}

export function useRunnerZoomStepInMutation(
  zoom: DesktopZoomBridge | null,
): UseMutationResult<number, Error, void> {
  const queryClient = useQueryClient();
  const cacheScope = getZoomCacheScope(zoom);
  return useMutation<number>({
    mutationKey: runnerMutationKeys.zoomStepIn(cacheScope),
    mutationFn: () => {
      if (zoom === null) {
        throw new Error("Desktop zoom is unavailable");
      }
      return zoom.stepIn();
    },
    onSuccess: (percent) => {
      writeZoomPercent(queryClient, cacheScope, percent);
    },
    onError: (err) => toastFromRunnerError(err, "Couldn't zoom in"),
  });
}

export function useRunnerZoomStepOutMutation(
  zoom: DesktopZoomBridge | null,
): UseMutationResult<number, Error, void> {
  const queryClient = useQueryClient();
  const cacheScope = getZoomCacheScope(zoom);
  return useMutation<number>({
    mutationKey: runnerMutationKeys.zoomStepOut(cacheScope),
    mutationFn: () => {
      if (zoom === null) {
        throw new Error("Desktop zoom is unavailable");
      }
      return zoom.stepOut();
    },
    onSuccess: (percent) => {
      writeZoomPercent(queryClient, cacheScope, percent);
    },
    onError: (err) => toastFromRunnerError(err, "Couldn't zoom out"),
  });
}

export function useRunnerZoomResetMutation(
  zoom: DesktopZoomBridge | null,
): UseMutationResult<number, Error, void> {
  const queryClient = useQueryClient();
  const cacheScope = getZoomCacheScope(zoom);
  return useMutation<number>({
    mutationKey: runnerMutationKeys.zoomReset(cacheScope),
    mutationFn: () => {
      if (zoom === null) {
        throw new Error("Desktop zoom is unavailable");
      }
      return zoom.reset();
    },
    onSuccess: (percent) => {
      writeZoomPercent(queryClient, cacheScope, percent);
    },
    onError: (err) => toastFromRunnerError(err, "Couldn't reset zoom"),
  });
}

let nextZoomCacheScopeId = 0;
const zoomCacheScopes = new WeakMap<DesktopZoomBridge, string>();
const zoomCacheBridges = new Map<string, DesktopZoomBridge>();

function getZoomCacheScope(zoom: DesktopZoomBridge | null): string | null {
  if (zoom === null) return null;
  const existingScope = zoomCacheScopes.get(zoom);
  if (existingScope !== undefined) return existingScope;
  const scope = `desktop-zoom-${nextZoomCacheScopeId}`;
  nextZoomCacheScopeId += 1;
  zoomCacheScopes.set(zoom, scope);
  zoomCacheBridges.set(scope, zoom);
  return scope;
}

function readZoomPercent(cacheScope: string | null): Promise<number> {
  if (cacheScope === null) {
    throw new Error("Desktop zoom is unavailable");
  }
  const zoom = zoomCacheBridges.get(cacheScope);
  if (zoom === undefined) {
    throw new Error("Desktop zoom cache scope is unavailable");
  }
  return zoom.get();
}

function writeZoomPercent(
  queryClient: QueryClient,
  cacheScope: string | null,
  percent: number,
): void {
  if (cacheScope === null) return;
  queryClient.setQueryData(runnerQueryKeys.zoomPercent(cacheScope), percent);
}
