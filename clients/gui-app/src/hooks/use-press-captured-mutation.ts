import {
  useMutation,
  useQueryClient,
  type MutateOptions,
  type MutationFunctionContext,
  type UseMutateFunction,
  type UseMutateAsyncFunction,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";

type PressOptions<TData, TError, TVariables, TContext> = Omit<
  UseMutationOptions<TData, TError, TVariables, TContext>,
  "mutationFn"
>;

type PressExecution<TData, TVariables, TCapture> = (
  variables: TVariables,
  captured: TCapture,
  context: MutationFunctionContext,
) => Promise<TData>;

type CapturedPress<TData, TError, TVariables, TCapture, TContext> = {
  readonly variables: TVariables;
  readonly options: PressOptions<TData, TError, TVariables, TContext>;
  readonly execute: PressExecution<TData, TVariables, TCapture>;
} & (
  | { readonly kind: "ready"; readonly captured: TCapture }
  | { readonly kind: "failed"; readonly error: unknown }
);

/**
 * Captures each press before TanStack awaits its mutation hooks. Each
 * invocation owns a separate envelope, including void or reused variables;
 * public callbacks and results still expose the caller's variables. The
 * execution and callbacks stay with the render that received that press.
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
  const mutation = useMutation<
    TData,
    TError,
    CapturedPress<TData, TError, TVariables, TCapture, TContext>,
    TContext
  >({
    ...options,
    mutationFn: (press, context) =>
      press.kind === "failed"
        ? Promise.reject<TData>(press.error)
        : press.execute(press.variables, press.captured, context),
    // An omitted onMutate produces no context, exactly as useMutation does.
    onMutate: (press, context) =>
      press.options.onMutate === undefined
        ? (undefined as TContext)
        : press.options.onMutate(press.variables, context),
    onSuccess: (data, press, result, context) =>
      press.options.onSuccess?.(data, press.variables, result, context),
    onError: (error, press, result, context) =>
      press.options.onError?.(error, press.variables, result, context),
    onSettled: (data, error, press, result, context) =>
      press.options.onSettled?.(data, error, press.variables, result, context),
  });
  const capture = (
    variables: TVariables,
  ): CapturedPress<TData, TError, TVariables, TCapture, TContext> => {
    try {
      return {
        kind: "ready",
        variables,
        options,
        execute: mutationFn,
        captured: capturePress(variables),
      };
    } catch (error) {
      // Capture failures still go through the mutation's error callbacks.
      return { kind: "failed", variables, options, execute: mutationFn, error };
    }
  };
  const callbacks = (
    perCall: MutateOptions<TData, TError, TVariables, TContext> | undefined,
  ):
    | MutateOptions<
        TData,
        TError,
        CapturedPress<TData, TError, TVariables, TCapture, TContext>,
        TContext
      >
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
