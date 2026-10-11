// One-off script: renders the SVG icons in static/icons to the PNG sizes the manifest needs.
// Run with `pnpm --filter @clavis/web icons`. The PNGs are committed; rerun only when the SVGs change.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const dir = fileURLToPath(new URL("../static/icons/", import.meta.url));
const targets = [
  ["icon.svg", "icon-192.png", 192],
  ["icon.svg", "icon-512.png", 512],
  ["icon-maskable.svg", "icon-maskable-512.png", 512],
  // iOS ignores transparency and applies its own corner mask, so use the full-bleed variant.
  ["icon-maskable.svg", "apple-touch-icon.png", 180],
];

for (const [src, out, size] of targets) {
  const svg = await readFile(dir + src);
  const png = await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
  await writeFile(dir + out, png);
  console.log(`wrote ${out}`);
}
