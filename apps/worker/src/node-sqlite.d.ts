// Minimal types for Node's built-in `node:sqlite`, used only by tests. The worker tsconfig loads
// Workers types instead of `@types/node`, so the module is declared here.
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...bindings: unknown[]): Record<string, unknown>[];
      run(...bindings: unknown[]): unknown;
    };
    close(): void;
  }
}

// Vite raw imports, used by tests to load migration files.
declare module "*?raw" {
  const content: string;
  export default content;
}
