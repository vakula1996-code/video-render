#!/usr/bin/env tsx
import { encodeVideo } from "../index";

const inputPattern = process.argv[2] ?? "artifacts/frames/frame-%05d.png";
const outputFile = process.argv[3] ?? "artifacts/output.mp4";
const fps = Number(process.argv[4] ?? 60);

encodeVideo({
  inputPattern,
  outputFile,
  fps,
}).catch((error) => {
  console.error("ffmpeg export failed", error);
  process.exitCode = 1;
});
