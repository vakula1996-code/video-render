#!/usr/bin/env tsx
import { renderDeterministicFrames } from "../index";

const entry = process.argv[2] ?? "apps/demo/dist/index.html";
const outDir = process.argv[3] ?? "artifacts/frames";
const totalFrames = Number(process.argv[4] ?? 360);
const fps = Number(process.argv[5] ?? 60);

renderDeterministicFrames({
  entry,
  outDir,
  totalFrames,
  fps,
  width: 1080,
  height: 1920,
}).catch((error) => {
  console.error("Offline render failed", error);
  process.exitCode = 1;
});
