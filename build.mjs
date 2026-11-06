// Builds the addon into dist/. Output isn't minified, so store reviewers can read it.
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const options = {
  entryPoints: {
    background: "src/background/index.ts",
    content: "src/content/index.ts",
    "pages/welcome": "src/pages/welcome.ts",
    "pages/options": "src/pages/options.ts",
    "pages/unlock": "src/pages/unlock.ts",
  },
  bundle: true,
  format: "iife",
  target: "firefox140",
  outdir: "dist",
  minify: false,
  // Lets the content script's stylesheet be bundled as a string for its Shadow DOM.
  loader: { ".css": "text" },
  logLevel: "info",
};

await rm("dist", { recursive: true, force: true });
await mkdir("dist/pages", { recursive: true });
await cp("static", "dist", { recursive: true });

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
