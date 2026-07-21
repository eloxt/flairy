// Generates every app/tray icon from the single source build/icon.svg.
// Run from apps/desktop: `node scripts/generate-icons.mjs`
//
// Each target is composed as a small wrapper SVG (optional rounded tile +
// the glyph nested at the right size) and rasterized with sharp — plain node,
// no Electron involved. Outputs:
//   build/icon.icns            macOS app icon (Apple-style margins + squircle
//                              tile, packaged via `iconutil`)
//   build/icon.png             1024px rounded tile, electron-builder win/linux
//   resources/tray/iconTemplate.png / @2x
//                              macOS menu-bar template (black glyph + alpha;
//                              tray.ts calls setTemplateImage(true))
//   resources/tray/icon.png    32px colored tray tile for Windows/Linux
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const glyphSvg = readFileSync(path.join(ROOT, "build/icon.svg"), "utf8");

/**
 * Wrapper SVG: optional white rounded tile behind the glyph.
 *   tile.margin — canvas fraction left transparent around the tile
 *   tile.radius — corner radius as a fraction of the tile edge
 *   glyph       — glyph edge as a fraction of the canvas
 * The glyph strokes with currentColor, which rasterizers resolve to black in a
 * standalone SVG — so the tray template comes out black-on-alpha for free.
 */
function composeSvg({ size, tile, glyph }) {
  let body = "";
  if (tile) {
    const m = size * tile.margin;
    const edge = size - m * 2;
    body += `<rect x="${m}" y="${m}" width="${edge}" height="${edge}" rx="${edge * tile.radius}" fill="${tile.color}"/>`;
  }
  const g = size * glyph;
  const o = (size - g) / 2;
  // Re-dimension the glyph's root <svg> tag and nest it (viewBox scales it).
  body += glyphSvg.replace(
    /<svg([^>]*?)width="[^"]*"\s+height="[^"]*"/,
    `<svg$1x="${o}" y="${o}" width="${g}" height="${g}"`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
}

const APPLE_TILE = { margin: 0.0977, radius: 0.2237, color: "#ffffff" };
const renders = [
  // macOS iconset: Apple margin (100/1024) and continuous-corner-ish radius.
  ...[16, 32, 128, 256, 512].flatMap((pt) => [
    { name: `iconset/icon_${pt}x${pt}.png`, size: pt, tile: APPLE_TILE, glyph: 0.52 },
    { name: `iconset/icon_${pt}x${pt}@2x.png`, size: pt * 2, tile: APPLE_TILE, glyph: 0.52 },
  ]),
  // Windows/Linux app icon: full-bleed rounded tile.
  {
    name: "build/icon.png",
    size: 1024,
    tile: { margin: 0, radius: 0.16, color: "#ffffff" },
    glyph: 0.62,
  },
  // macOS menu-bar template: glyph only, Electron tints it via template mode.
  { name: "resources/tray/iconTemplate.png", size: 16, glyph: 1 },
  { name: "resources/tray/iconTemplate@2x.png", size: 32, glyph: 1 },
  // Windows/Linux tray: mini tile so the mark reads on any taskbar shade.
  {
    name: "resources/tray/icon.png",
    size: 32,
    tile: { margin: 0, radius: 0.22, color: "#ffffff" },
    glyph: 0.66,
  },
];

const iconsetDir = path.join(ROOT, "build/icon.iconset");
rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });

for (const spec of renders) {
  const out = spec.name.startsWith("iconset/")
    ? path.join(iconsetDir, spec.name.slice("iconset/".length))
    : path.join(ROOT, spec.name);
  const png = await sharp(Buffer.from(composeSvg(spec))).png().toBuffer();
  writeFileSync(out, png);
  console.log("wrote", path.relative(ROOT, out));
}

// Package the iconset (macOS-only tool; the pngs above are cross-platform).
if (process.platform === "darwin") {
  execFileSync("iconutil", [
    "-c",
    "icns",
    iconsetDir,
    "-o",
    path.join(ROOT, "build/icon.icns"),
  ]);
  console.log("wrote build/icon.icns");
}
rmSync(iconsetDir, { recursive: true, force: true });
