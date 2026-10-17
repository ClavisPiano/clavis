// Minimal types for Node's built-in `node:sqlite`, used only by tests. The worker tsconfig loads
// Workers types instead of `@types/node`, so the module is declared here.
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): { all(...bindings: unknown[]): Record<string, unknown>[] };
    close(): void;
  }
}
