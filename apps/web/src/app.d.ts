// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {}

  /** Short commit and build day, replaced at build time (vite.config.ts). */
  const __BUILD_ID__: string;
}

export {};
