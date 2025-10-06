#!/usr/bin/env tsx
import { analyzeAudioFile } from "../index";

const path = process.argv[2] ?? "assets/audio/demo.mp3";

analyzeAudioFile(path).catch((error) => {
  console.error("Audio analysis failed", error);
  process.exitCode = 1;
});
