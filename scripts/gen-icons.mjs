// Rasterize build/icon.svg into the platform icons electron-builder expects:
//   build/icon.png  (1024×1024, used by Linux + as macOS/Windows fallback)
//   build/icon.ico  (Windows, multi-size)
//   build/icon.icns (macOS)
//
// Run with: pnpm icons
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";
import png2icons from "png2icons";

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const svg = readFileSync(join(buildDir, "icon.svg"));

const basePng = await sharp(svg, { density: 384 })
  .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

writeFileSync(join(buildDir, "icon.png"), basePng);

// png2icons builds multi-resolution ICO/ICNS from the 1024px master.
const ico = png2icons.createICO(basePng, png2icons.BILINEAR, 0, false);
if (ico) writeFileSync(join(buildDir, "icon.ico"), ico);

const icns = png2icons.createICNS(basePng, png2icons.BILINEAR, 0);
if (icns) writeFileSync(join(buildDir, "icon.icns"), icns);

console.log("icons written: icon.png, icon.ico, icon.icns");
