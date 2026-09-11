import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const dist = resolve(root, "dist");
await mkdir(dist, { recursive: true });
for (const entry of ["background", "content", "popup", "offscreen-auth"]) {
  await build({
    entryPoints: [resolve(root, "src", `${entry}.ts`)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome109",
    outfile: resolve(dist, `${entry}.js`),
    sourcemap: true,
    define: { "process.env.NODE_ENV": "\"production\"" },
  });
}
await cp(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
await cp(resolve(root, "popup.html"), resolve(dist, "popup.html"));
await cp(resolve(root, "popup.css"), resolve(dist, "popup.css"));
await cp(resolve(root, "src", "offscreen.html"), resolve(dist, "offscreen.html"));
console.log(`AnswerFrame extension built at ${dist}`);
