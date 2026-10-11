/** Minimal WAV reader for fixtures: 16-bit PCM and 32-bit float, any channel count. */

export interface WavData {
  sampleRate: number;
  channels: number;
  /** Channel-averaged mono samples in [-1, 1]. */
  samples: Float32Array;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export function readWav(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataLength = 0;

  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      if (size < 16) throw new Error("Malformed fmt chunk");
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === FORMAT_EXTENSIBLE && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      dataStart = body;
      // Streamed files may declare a bogus length; clamp to what is there.
      dataLength = Math.min(size, bytes.byteLength - body);
      break;
    }
    pos = body + size + (size % 2);
  }
  if (format === 0 || dataStart < 0) throw new Error("WAV file is missing fmt or data chunk");
  if (channels < 1) throw new Error("WAV file has no channels");

  const bytesPerSample = bits / 8;
  const isPcm16 = format === FORMAT_PCM && bits === 16;
  const isFloat32 = format === FORMAT_FLOAT && bits === 32;
  if (!isPcm16 && !isFloat32) {
    throw new Error(`Unsupported WAV encoding (format ${String(format)}, ${String(bits)} bits)`);
  }

  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataLength / frameBytes);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = dataStart + i * frameBytes + c * bytesPerSample;
      sum += isPcm16 ? view.getInt16(at, true) / 32768 : view.getFloat32(at, true);
    }
    samples[i] = sum / channels;
  }
  return { sampleRate, channels, samples };
}

/** Encode mono or interleaved samples as a WAV file. Used by tests and fixture tooling. */
export function writeWav(
  samples: Float32Array,
  sampleRate: number,
  options: { channels?: number; encoding?: "pcm16" | "float32" } = {},
): Uint8Array {
  const channels = options.channels ?? 1;
  const float = options.encoding === "float32";
  const bytesPer = float ? 4 : 2;
  const dataLength = samples.length * bytesPer;
  const out = new Uint8Array(44 + dataLength);
  const view = new DataView(out.buffer);
  const put = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  put(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, float ? FORMAT_FLOAT : FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPer, true);
  view.setUint16(32, channels * bytesPer, true);
  view.setUint16(34, bytesPer * 8, true);
  put(36, "data");
  view.setUint32(40, dataLength, true);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    if (float) view.setFloat32(44 + i * 4, v, true);
    else view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true);
  }
  return out;
}
