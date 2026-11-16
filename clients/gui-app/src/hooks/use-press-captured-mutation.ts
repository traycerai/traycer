import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  MutationObserver as QueryMutationObserver,
  hashKey,
  notifyManager,
  shouldThrowError,
  useQueryClient,
  type MutationFunctionContext,
  type UseMutateFunction,
  type UseMutateAsyncFunction,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";

type PressCapture<TCapture> =
  | { readonly kind: "ready"; readonly captured: TCapture }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * Each press owns its execution and options before TanStack yields. The
 * capture stays in that mutation's function, never in its cached variables.
 */
export function usePressCapturedMutation<
  TData,
  TError,
  TVariables,
  TCapture,
  TContext = unknown,
>(
  capturePress: (variables: TVariables) => TCapture,
  args: Omit<
    UseMutationOptions<TData, TError, TVariables, TContext>,
    "mutationFn"
  > & {
    readonly mutationFn: (
      variables: TVariables,
      captured: TCapture,
      context: MutationFunctionContext,
    ) => Promise<TData>;
  },
): UseMutationResult<TData, TError, TVariables, TContext> {
  const queryClient = useQueryClient();
  const { mutationFn, ...provided } = args;
  const options = queryClient.defaultMutationOptions(provided);
  const [observer] = useState(
    () =>
      new QueryMutationObserver<TData, TError, TVariables, TContext>(
        queryClient,
        options,
      ),
  );
  useEffect(() => {
    const previousKey = observer.options.mutationKey;
    const nextKey = options.mutationKey;
    if (
      previousKey !== undefined &&
      nextKey !== undefined &&
      hashKey(previousKey) !== hashKey(nextKey)
    ) {
      // A new key drops the old view, but must not rewrite pending work.
      observer.reset();
      observer.setOptions(options);
    }
  }, [observer, options]);
  const result = useSyncExternalStore(
    useCallback(
      (onStoreChange) =>
        observer.subscribe(notifyManager.batchCalls(onStoreChange)),
      [observer],
    ),
    () => observer.getCurrentResult(),
    () => observer.getCurrentResult(),
  );
  const mutateAsync: UseMutateAsyncFunction<
    TData,
    TError,
    TVariables,
    TContext
  > = (variables, perCall) => {
    let capture: PressCapture<TCapture>;
    try {
      capture = { kind: "ready", captured: capturePress(variables) };
    } catch (error) {
      capture = { kind: "failed", error };
    }
    return notifyManager.batch(() => {
      // setOptions rewrites an observed pending mutation. Detach first:
      // its work and hook callbacks continue, with their own press snapshot.
      observer.reset();
      observer.setOptions({
        ...options,
        mutationFn: (request, context) =>
          capture.kind === "failed"
            ? Promise.reject<TData>(capture.error)
            : mutationFn(request, capture.captured, context),
      });
      return observer.mutate(variables, perCall);
    });
  };
  const mutate: UseMutateFunction<TData, TError, TVariables, TContext> = (
    variables,
    perCall,
  ) => {
    void mutateAsync(variables, perCall).catch(() => undefined);
  };
  if (result.error && shouldThrowError(options.throwOnError, [result.error])) {
    throw result.error;
  }
  return { ...result, mutate, mutateAsync };
}
