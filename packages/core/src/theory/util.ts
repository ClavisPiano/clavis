/** Indexed access that throws instead of returning undefined (for noUncheckedIndexedAccess). */
export function at<T>(arr: readonly T[], index: number): T {
  const v = arr[index];
  if (v === undefined) throw new RangeError(`index ${String(index)} out of bounds`);
  return v;
}
