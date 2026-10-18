/** Half-width of the sinc kernel, in input samples at the lower of the two rates. */
const KERNEL_HALF_WIDTH = 16;

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

/** Hann-windowed sinc, `x` in kernel units (zero outside +-KERNEL_HALF_WIDTH). */
function kernel(x: number): number {
  if (Math.abs(x) >= KERNEL_HALF_WIDTH) return 0;
  return sinc(x) * (0.5 + 0.5 * Math.cos((Math.PI * x) / KERNEL_HALF_WIDTH));
}

/**
 * Resample mono audio with a windowed-sinc low-pass, so that going down does not alias. Pure and
 * deterministic. The same rate returns a copy.
 */
export function resampleMono(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  if (input.length === 0) return new Float32Array(0);
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  // Cutoff at the lower Nyquist; the kernel is stretched when downsampling.
  const scale = Math.min(1, toRate / fromRate);
  const reach = Math.ceil(KERNEL_HALF_WIDTH / scale);
  for (let i = 0; i < outLength; i++) {
    const centre = i * ratio;
    const first = Math.max(0, Math.ceil(centre - reach));
    const last = Math.min(input.length - 1, Math.floor(centre + reach));
    let sum = 0;
    let weight = 0;
    for (let j = first; j <= last; j++) {
      const k = kernel((j - centre) * scale);
      sum += (input[j] ?? 0) * k;
      weight += k;
    }
    out[i] = weight === 0 ? 0 : sum / weight;
  }
  return out;
}
