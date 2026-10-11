/** Vite import suffixes used by `web.ts`. Declared here so the package type-checks without vite/client. */
declare module "*?worker&url" {
  const url: string;
  export default url;
}

declare module "*?worker" {
  const WorkerConstructor: new (options?: { name?: string }) => Worker;
  export default WorkerConstructor;
}
