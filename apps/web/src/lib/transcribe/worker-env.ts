/**
 * TensorFlow.js 3.x tests `!window` (not `typeof window`) before choosing how to schedule a
 * timeout, which throws a ReferenceError inside a worker. Declaring the global as undefined makes
 * it take the plain `setTimeout` path. Import this first in the worker, before any tfjs module.
 */
const scope = globalThis as { window?: unknown };
if (!("window" in scope)) scope.window = undefined;
