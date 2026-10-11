// Verovio ships no type declarations. These cover only what the T3.2 spike worker uses.
declare module "verovio/wasm" {
  /** Emscripten module instance. Only the heap view is read, for diagnostics. */
  export interface VerovioModule {
    HEAPU8?: Uint8Array;
  }
  const createVerovioModule: () => Promise<VerovioModule>;
  export default createVerovioModule;
}

declare module "verovio/esm" {
  import type { VerovioModule } from "verovio/wasm";
  export class VerovioToolkit {
    constructor(module: VerovioModule);
    setOptions(options: Record<string, unknown>): void;
    loadData(data: string): boolean;
    renderToSVG(page?: number): string;
    getVersion(): string;
    destroy(): void;
  }
}
