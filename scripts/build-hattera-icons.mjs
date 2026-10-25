// Generate every desktop icon from the same original vector as the web app.
import { Resvg } from "@resvg/resvg-js";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "public/hattera-mark.svg"), "utf8");
const png = new Map([16, 32, 64, 128, 256, 512, 1024].map(size => [size,
  new Resvg(source, { fitTo: { mode: "width", value: size } }).render().asPng(),
]));
mkdirSync(join(root, "build/icon.iconset"), { recursive: true });
copyFileSync(join(root, "public/hattera-mark.svg"), join(root, "build/icon.svg"));
copyFileSync(join(root, "public/hattera-mark.svg"), join(root, "public/app-icon.svg"));
writeFileSync(join(root, "build/icon-1024.png"), png.get(1024));
for (const size of [16, 32, 64, 128, 256, 512]) {
  for (const scale of [1, 2]) writeFileSync(join(root, `build/icon.iconset/icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`), png.get(size * scale));
}
const entries = [...png].filter(([size]) => size <= 256);
const header = Buffer.alloc(6 + entries.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
let offset = header.length;
for (const [index, [size, data]] of entries.entries()) {
  const at = 6 + index * 16;
  header[at] = size === 256 ? 0 : size; header[at + 1] = header[at];
  header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(data.length, at + 8); header.writeUInt32LE(offset, at + 12);
  offset += data.length;
}
writeFileSync(join(root, "build/icon.ico"), Buffer.concat([header, ...entries.map(([, data]) => data)]));
const chunks = [["ic11",32],["ic12",64],["ic07",128],["ic08",256],["ic09",512],["ic10",1024]].map(([type,size]) => {
  const data = png.get(size), chunk = Buffer.alloc(8);
  chunk.write(type); chunk.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([chunk, data]);
});
const icns = Buffer.alloc(8); icns.write("icns"); icns.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
writeFileSync(join(root, "build/icon.icns"), Buffer.concat([icns, ...chunks]));
writeFileSync(join(root, "build/icon.html"), '<!doctype html><title>Hattera icon</title><img src="icon.svg" alt="Hattera" width="256" height="256">\n');
console.log("Hattera SVG, PNG, ICO, ICNS and iconset generated from public/hattera-mark.svg");
