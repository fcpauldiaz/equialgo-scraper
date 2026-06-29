import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import toIco from "to-ico";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const svgPath = path.join(publicDir, "favicon.svg");

const svg = await fs.readFile(svgPath);

async function pngBuffer(size) {
  return sharp(svg).resize(size, size).png().toBuffer();
}

const png16 = await pngBuffer(16);
const png32 = await pngBuffer(32);
const png180 = await pngBuffer(180);

await fs.writeFile(path.join(publicDir, "favicon-16x16.png"), png16);
await fs.writeFile(path.join(publicDir, "favicon-32x32.png"), png32);
await fs.writeFile(path.join(publicDir, "apple-touch-icon.png"), png180);
await fs.writeFile(path.join(publicDir, "favicon.ico"), await toIco([png16, png32]));

console.log("Generated favicon PNG/ICO files in ui/public/");
