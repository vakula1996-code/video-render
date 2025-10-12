#!/usr/bin/env tsx
import { join } from "path";
import { runRenderAndEncode, writeReleaseManifest } from "../index";

const entry = process.argv[2] ?? "apps/demo/dist/index.html";
const outDir = process.argv[3] ?? "artifacts/frames";
const totalFrames = Number(process.argv[4] ?? 360);
const fps = Number(process.argv[5] ?? 60);
const width = Number(process.argv[6] ?? 1080);
const height = Number(process.argv[7] ?? 1920);
const videoFile = process.argv[8] ?? join(outDir, "loop.mp4");
const seed = process.argv[9] ?? "demo";

runRenderAndEncode({ entry, outDir, totalFrames, fps, width, height, videoFile })
  .then(async ({ frames, videoFile: renderedVideo }) => {
    const manifestPath = join(outDir, "manifest.json");
    await writeReleaseManifest({
      frames,
      videoFile: renderedVideo,
      fps,
      durationMs: (totalFrames / fps) * 1000,
      seed,
      outputPath: manifestPath,
      plugins: ["@vis/renderer-pixi", "@vis/audio", "@vis/timeline"],
    });
    console.log(
      `Rendered ${frames.length} frames to ${outDir}, encoded video at ${renderedVideo}, manifest saved to ${manifestPath}.`
    );
  })
  .catch((error) => {
    console.error("Pipeline run failed", error);
    process.exitCode = 1;
  });
