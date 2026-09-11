/**
 * A typed-array constructor that counts how often it is constructed, and is
 * otherwise the constructor it stands in for.
 *
 * THE COUNTING IS THE POINT. The office's path scratch and the plan scratches
 * keep their own capacity and growth counters, and a version that allocated a
 * fresh pair of buffers per search would leave that bookkeeping perfectly
 * intact - so a guard reading only those counters passes the very regression it
 * exists to catch. This watches the constructor itself, which is the thing the
 * guarantee is actually about.
 *
 * TRANSPARENCY IS ALSO THE POINT, and the harder half. A stand-in that counted
 * but quietly dropped every constructor form except `new Ctor(length)` would
 * count correctly today and silently corrupt the first test that built a view
 * over a buffer - `new Int32Array(buffer, 4, 2)` coming back empty, with no
 * failure that names the stub. So the trap forwards the arguments it was given
 * and the `new.target` it was called with, unread and unaltered, and everything
 * that is not construction falls through the proxy untouched, statics included.
 *
 * The `instanceof` is not a formality: it is what lets the trap hand back a
 * value typed as the constructor's own instance rather than the `any` that
 * `Reflect.construct` is declared to return, and it would throw if a forward
 * ever stopped producing one.
 */
export function countingArrayCtor<T extends object>(
  ctor: new (length: number) => T,
  onConstruct: () => void,
): new (length: number) => T {
  return new Proxy(ctor, {
    construct(target, argArray, newTarget) {
      onConstruct();
      const made: unknown = Reflect.construct(target, argArray, newTarget);
      if (!(made instanceof target)) {
        throw new TypeError("the counted constructor returned a stranger");
      }
      return made;
    },
  });
}
