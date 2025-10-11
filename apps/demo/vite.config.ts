import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const packagesRoot = path.resolve(repoRoot, "packages");

const resolvePackageEntry = (pkg: string) =>
  path.resolve(packagesRoot, pkg, "src", "index.ts");

const visAliases = [
  "core",
  "renderer-pixi",
  "audio",
  "timeline",
  "presets",
  "physics",
  "export",
].reduce<Record<string, string>>((aliases, pkg) => {
  aliases[`@vis/${pkg}`] = resolvePackageEntry(pkg);
  return aliases;
}, {});

export default defineConfig({
  root: "./",
  resolve: {
    alias: {
      ...visAliases,
    },
    preserveSymlinks: true,
  },
  optimizeDeps: {
    exclude: Object.keys(visAliases),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
