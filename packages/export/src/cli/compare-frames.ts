#!/usr/bin/env tsx
import { compareFrameSequences } from "../index";

const actualDir = process.argv[2] ?? "artifacts/frames";
const baselineDir = process.argv[3] ?? "artifacts/baseline";
const diffDir = process.argv[4];
const thresholdArg = process.argv[5];
const threshold = typeof thresholdArg === "string" ? Number(thresholdArg) : undefined;

compareFrameSequences({ actualDir, baselineDir, diffDir, threshold })
  .then((summary) => {
    console.log(`Compared ${summary.totalCompared} frames.`);
    if (summary.missingInActual.length > 0) {
      console.warn(`Missing in actual: ${summary.missingInActual.join(", ")}`);
    }
    if (summary.missingInBaseline.length > 0) {
      console.warn(`Missing in baseline: ${summary.missingInBaseline.join(", ")}`);
    }
    const formatted = summary.diffs
      .filter((diff) => diff.mismatchRatio > 0)
      .map((diff) => `${diff.frame} mismatch ${(diff.mismatchRatio * 100).toFixed(3)}%`);
    if (formatted.length > 0) {
      console.log(formatted.join("\n"));
    }
    console.log(`Max mismatch ${(summary.maxMismatch * 100).toFixed(3)}%, average ${(summary.averageMismatch * 100).toFixed(3)}%`);
    if (threshold !== undefined && summary.maxMismatch > threshold) {
      console.error(
        `Frame mismatch ${summary.maxMismatch.toFixed(5)} exceeds threshold ${threshold.toFixed(5)}. Marking run as failed.`
      );
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error("Frame comparison failed", error);
    process.exitCode = 1;
  });
