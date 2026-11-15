import {
  useMutation,
  useQueryClient,
  type MutateOptions,
  type UseMutateFunction,
  type UseMutateAsyncFunction,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";

type CapturedPress<TVariables, TCapture> = { readonly variables: TVariables } & (
  | { readonly kind: "ready"; readonly captured: TCapture }
  | { readonly kind: "failed"; readonly error: unknown }
);

/**
 * Captures each press before TanStack awaits its mutation hooks. Each
 * invocation owns a separate envelope, including void or reused variables;
 * public callbacks and results still expose the caller's variables.
 */
export function usePressCapturedMutation<
  TData,
  TError,
  TVariables,
  TCapture,
  TContext = unknown,
>(
  capturePress: () => TCapture,
  args: Omit<
    UseMutationOptions<TData, TError, TVariables, TContext>,
    "mutationFn"
  > & {
    readonly mutationFn: (
      variables: TVariables,
      captured: TCapture,
    ) => Promise<TData>;
  },
): UseMutationResult<TData, TError, TVariables, TContext> {
  const queryClient = useQueryClient();
  const { mutationFn, ...provided } = args;
  const { onMutate, onSuccess, onError, onSettled, ...options } =
    queryClient.defaultMutationOptions(provided);
  const mutation = useMutation<
    TData,
    TError,
    CapturedPress<TVariables, TCapture>,
    TContext
  >({
    ...options,
    mutationFn: (press) =>
      press.kind === "failed"
        ? Promise.reject<TData>(press.error)
        : mutationFn(press.variables, press.captured),
    onMutate:
      onMutate === undefined
        ? undefined
        : (press, context) => onMutate(press.variables, context),
    onSuccess:
      onSuccess === undefined
        ? undefined
        : (data, press, result, context) =>
            onSuccess(data, press.variables, result, context),
    onError:
      onError === undefined
        ? undefined
        : (error, press, result, context) =>
            onError(error, press.variables, result, context),
    onSettled:
      onSettled === undefined
        ? undefined
        : (data, error, press, result, context) =>
            onSettled(data, error, press.variables, result, context),
  });
  const capture = (variables: TVariables): CapturedPress<TVariables, TCapture> => {
    try {
      return { kind: "ready", variables, captured: capturePress() };
    } catch (error) {
      // Capture failures still go through the mutation's error callbacks.
      return { kind: "failed", variables, error };
    }
  };
  const callbacks = (
    perCall: MutateOptions<TData, TError, TVariables, TContext> | undefined,
  ):
    | MutateOptions<TData, TError, CapturedPress<TVariables, TCapture>, TContext>
    | undefined =>
    perCall === undefined
      ? undefined
      : {
          ...perCall,
          onSuccess: (data, press, result, context) =>
            perCall.onSuccess?.(data, press.variables, result, context),
          onError: (error, press, result, context) =>
            perCall.onError?.(error, press.variables, result, context),
          onSettled: (data, error, press, result, context) =>
            perCall.onSettled?.(data, error, press.variables, result, context),
        };
  const mutate: UseMutateFunction<TData, TError, TVariables, TContext> = (
    variables,
    perCall,
  ) => mutation.mutate(capture(variables), callbacks(perCall));
  const mutateAsync: UseMutateAsyncFunction<
    TData,
    TError,
    TVariables,
    TContext
  > = (variables, perCall) =>
    mutation.mutateAsync(capture(variables), callbacks(perCall));
  if (mutation.isIdle) {
    return { ...mutation, variables: undefined, mutate, mutateAsync };
  }
  return {
    ...mutation,
    variables: mutation.variables.variables,
    mutate,
    mutateAsync,
  };
}
