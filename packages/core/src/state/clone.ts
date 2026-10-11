/** Deep copy of plain JSON data (the state contains nothing else). */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
