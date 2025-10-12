import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { mkdirp, pathExists } from "fs-extra";
import { readdir, stat, writeFile, mkdir, readFile } from "fs/promises";
import { join, resolve, relative, dirname } from "path";
import { pathToFileURL } from "url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import puppeteer from "puppeteer";
import type { PuppeteerLaunchOptions } from "puppeteer";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import type { Buffer } from "buffer";
import type { Duplex } from "stream";
import { spawn, type SpawnOptionsWithoutStdio } from "child_process";

interface PngOptions {
  width?: number;
  height?: number;
  fill?: boolean;
}

type PngInstance = Duplex & {
  width: number;
  height: number;
  data: Buffer;
  pack(): NodeJS.ReadableStream;
  on(event: "parsed", callback: (this: PngInstance) => void): PngInstance;
  on(event: "error", callback: (error: Error) => void): PngInstance;
};

type PngCtor = new (options?: PngOptions) => PngInstance;

interface PngModule {
  PNG: PngCtor;
}
type PixelmatchFn = typeof import("pixelmatch");

let pngModulePromise: Promise<PngModule> | null = null;
function loadPngModule(): Promise<PngModule> {
  if (!pngModulePromise) {
    pngModulePromise = import("pngjs").then((module) => module as unknown as PngModule);
  }
  return pngModulePromise;
}

let pixelmatchPromise: Promise<PixelmatchFn> | null = null;
async function loadPixelmatch(): Promise<PixelmatchFn> {
  if (!pixelmatchPromise) {
    pixelmatchPromise = import("pixelmatch").then((module) => {
      const asUnknown = module as unknown;
      if (typeof asUnknown === "function") {
        return asUnknown as PixelmatchFn;
      }
      const withDefault = asUnknown as { default?: PixelmatchFn };
      return (withDefault.default ?? withDefault) as PixelmatchFn;
    });
  }
  return pixelmatchPromise;
}

export interface OfflineRendererOptions {
  entry: string;
  outDir: string;
  totalFrames: number;
  fps: number;
  width: number;
  height: number;
}

export interface FrameRenderResult {
  frame: number;
  path: string;
}

export interface RenderAndEncodeOptions extends OfflineRendererOptions {
  videoFile?: string;
  codec?: "libx264" | "prores_ks";
  pixelFormat?: string;
  framePattern?: string;
}

export interface RenderAndEncodeResult {
  frames: FrameRenderResult[];
  videoFile: string;
  framePattern: string;
}

/**
 * Renders a deterministic PNG sequence by asking the page to render a specific frame.
 * The page must expose `window.__vis_renderFrame(timeMs)` for Puppeteer to call.
 */
export async function renderDeterministicFrames(options: OfflineRendererOptions): Promise<FrameRenderResult[]> {
  const normalizedOptions: OfflineRendererOptions = {
    ...options,
    entry: await ensureHtmlEntry(options.entry),
  };
  const headlessPreferences = resolveHeadlessPreference();
  let lastError: unknown;
  for (const [index, headless] of headlessPreferences.entries()) {
    try {
      return await renderWithHeadless(normalizedOptions, headless);
    } catch (error) {
      lastError = error;
      const isShell = headless === "shell";
      const hasNext = index < headlessPreferences.length - 1;
      const isRecoverableShellError =
        isShell &&
        error instanceof Error &&
        (/Network\.enable timed out/i.test(error.message) ||
          /Page\.addScriptToEvaluateOnNewDocument timed out/i.test(error.message) ||
          /Performance\.enable timed out/i.test(error.message) ||
          /Failed to launch the browser process/i.test(error.message));
      if (!hasNext || !isRecoverableShellError) {
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Offline render failed");
}

type LaunchOptions = NonNullable<PuppeteerLaunchOptions>;
type HeadlessMode = LaunchOptions["headless"];

function resolveHeadlessPreference(): HeadlessMode[] {
  const env = process.env.VIS_HEADLESS?.toLowerCase();
  if (env === "shell") {
    return ["shell"];
  }
  if (env === "new" || env === "true") {
    return [true];
  }
  if (env === "false") {
    return [false];
  }
  return process.platform === "win32" ? [true, "shell"] : ["shell", true];
}

async function renderWithHeadless(
  options: OfflineRendererOptions,
  headless: HeadlessMode
): Promise<FrameRenderResult[]> {
  const results: FrameRenderResult[] = [];
  await mkdirp(options.outDir);
  const browser = await puppeteer.launch({
    headless,
    protocolTimeout: 120_000,
    args: [
      ...(headless === "shell" || headless === false ? [] : ["--headless=new"]),
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=opengl",
      "--disable-software-rasterizer",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: options.width, height: options.height, deviceScaleFactor: 1 });
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(120_000);

    const url = options.entry.startsWith("http")
      ? options.entry
      : pathToFileURL(resolve(options.entry)).toString();
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.waitForFunction(
      () => {
        const bridge = window as unknown as {
          __vis_ready?: boolean;
          __vis_renderFrame?: unknown;
        };
        return bridge.__vis_ready || typeof bridge.__vis_renderFrame === "function";
      },
      { timeout: 120_000 }
    );

    for (let frame = 0; frame < options.totalFrames; frame++) {
      const time = (frame / options.fps) * 1000;
      await page.evaluate((ms) => {
        return (window as unknown as { __vis_renderFrame?: (ms: number) => Promise<void> }).__vis_renderFrame?.(ms);
      }, time);
      const outPath = join(options.outDir, `frame-${frame.toString().padStart(5, "0")}.png`);
      await page.screenshot({ path: outPath });
      results.push({ frame, path: outPath });
    }
  } finally {
    await browser.close();
  }
  return results;
}

export async function runRenderAndEncode(options: RenderAndEncodeOptions): Promise<RenderAndEncodeResult> {
  await ensureOutDir(options.outDir);
  const frames = await renderDeterministicFrames(options);
  const framePattern =
    options.framePattern ?? inferFramePattern(frames, options.outDir) ?? join(options.outDir, "frame-%05d.png");
  const videoFile = options.videoFile ?? join(options.outDir, "output.mp4");
  await encodeVideo({
    inputPattern: framePattern,
    outputFile: videoFile,
    fps: options.fps,
    codec: options.codec,
    pixelFormat: options.pixelFormat,
  });
  return { frames, videoFile, framePattern };
}

export interface ExportVideoOptions {
  inputPattern: string;
  outputFile: string;
  fps: number;
  codec?: "libx264" | "prores_ks";
  pixelFormat?: string;
}

/**
 * Wraps ffmpeg invocation to build perfect mp4/prores loops from PNG sequences.
 */
export async function encodeVideo(options: ExportVideoOptions): Promise<void> {
  const binaryPath = ffmpegStatic;
  if (binaryPath == null) {
    throw new Error("ffmpeg-static binary not found");
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    ffmpeg()
      .setFfmpegPath(binaryPath)
      .input(options.inputPattern)
      .inputOptions(["-framerate", options.fps.toString()])
      .videoCodec(options.codec ?? "libx264")
      .outputOptions([
        "-pix_fmt",
        options.pixelFormat ?? "yuv420p",
        "-y",
      ])
      .output(options.outputFile)
      .on("end", () => resolvePromise())
      .on("error", (error: Error) => rejectPromise(error))
      .run();
  });
}

export async function ensureOutDir(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    await mkdirp(path);
  }
}

async function ensureHtmlEntry(entry: string): Promise<string> {
  if (/^https?:\/\//i.test(entry)) {
    return entry;
  }

  const resolvedEntry = resolve(entry);
  if (await pathExists(resolvedEntry)) {
    return resolvedEntry;
  }

  const distDir = dirname(resolvedEntry);
  const workspaceDir = dirname(distDir);
  const packageJsonPath = join(workspaceDir, "package.json");

  if (!(await pathExists(packageJsonPath))) {
    throw new Error(
      `Entry HTML not found at ${resolvedEntry}. Provide an accessible URL or build the project containing this entry point.`
    );
  }

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8")) as {
    name?: string;
    scripts?: Record<string, string>;
  };

  if (!packageJson.scripts?.build) {
    throw new Error(
      `Entry HTML not found at ${resolvedEntry} and workspace ${workspaceDir} has no build script. Add a build script or provide a prebuilt entry.`
    );
  }

  const workspaceName = typeof packageJson.name === "string" ? packageJson.name : undefined;
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  const buildArgs = workspaceName ? ["run", "build", "--workspace", workspaceName] : ["run", "build"];
  const spawnOptions: SpawnOptionsWithoutStdio = workspaceName ? {} : { cwd: workspaceDir };

  console.log(
    `[vis-export] Entry ${resolvedEntry} is missing. Running ${npmExecutable} ${buildArgs.join(" ")} to build the workspace.`
  );

  await runCommand(npmExecutable, buildArgs, spawnOptions);

  if (!(await pathExists(resolvedEntry))) {
    throw new Error(
      `Entry HTML still not found at ${resolvedEntry} after running the build. Ensure the build outputs the expected file.`
    );
  }

  return resolvedEntry;
}

async function runCommand(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", (error) => rejectPromise(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

export interface CompareFrameSequencesOptions {
  actualDir: string;
  baselineDir: string;
  diffDir?: string;
  threshold?: number;
}

export interface FrameMismatch {
  frame: string;
  diffPixels: number;
  totalPixels: number;
  mismatchRatio: number;
  diffPath?: string;
}

export interface RegressionSummary {
  diffs: FrameMismatch[];
  totalCompared: number;
  maxMismatch: number;
  averageMismatch: number;
  missingInActual: string[];
  missingInBaseline: string[];
}

export async function compareFrameSequences(options: CompareFrameSequencesOptions): Promise<RegressionSummary> {
  const [{ PNG }, pixelmatchFn] = await Promise.all([loadPngModule(), loadPixelmatch()]);
  const [actualFiles, baselineFiles] = await Promise.all([
    collectPngs(options.actualDir),
    collectPngs(options.baselineDir),
  ]);

  const actualSet = new Set(actualFiles);
  const baselineSet = new Set(baselineFiles);
  const intersection = baselineFiles.filter((file) => actualSet.has(file));
  const missingInActual = baselineFiles.filter((file) => !actualSet.has(file));
  const missingInBaseline = actualFiles.filter((file) => !baselineSet.has(file));

  const diffs: FrameMismatch[] = [];
  if (options.diffDir) {
    await mkdir(options.diffDir, { recursive: true });
  }

  for (const file of intersection) {
    const baselinePath = join(options.baselineDir, file);
    const actualPath = join(options.actualDir, file);
    const [baselinePng, actualPng] = await Promise.all([readPng(baselinePath, PNG), readPng(actualPath, PNG)]);
    if (baselinePng.width !== actualPng.width || baselinePng.height !== actualPng.height) {
      throw new Error(`Frame size mismatch for ${file}`);
    }
    const diffPng = new PNG({ width: baselinePng.width, height: baselinePng.height });
    const diffPixels = pixelmatchFn(
      actualPng.data,
      baselinePng.data,
      diffPng.data,
      baselinePng.width,
      baselinePng.height,
      {
        threshold: options.threshold ?? 0.1,
        includeAA: false,
      }
    );
    let diffPath: string | undefined;
    if (options.diffDir && diffPixels > 0) {
      diffPath = join(options.diffDir, file);
      await writePng(diffPng, diffPath);
    }
    const totalPixels = baselinePng.width * baselinePng.height;
    diffs.push({
      frame: file,
      diffPixels,
      totalPixels,
      mismatchRatio: diffPixels / totalPixels,
      diffPath,
    });
  }

  const totalCompared = diffs.length;
  const maxMismatch = totalCompared === 0 ? 0 : Math.max(...diffs.map((d) => d.mismatchRatio));
  const averageMismatch =
    totalCompared === 0 ? 0 : diffs.reduce((sum, diff) => sum + diff.mismatchRatio, 0) / totalCompared;

  return { diffs, totalCompared, maxMismatch, averageMismatch, missingInActual, missingInBaseline };
}

export interface ReleaseManifestOptions {
  frames: FrameRenderResult[];
  videoFile: string;
  fps: number;
  durationMs: number;
  seed: string;
  outputPath: string;
  plugins?: string[];
  extra?: Record<string, unknown>;
}

export interface ReleaseManifest {
  version: string;
  generatedAt: string;
  fps: number;
  durationMs: number;
  totalFrames: number;
  seed: string;
  video: {
    path: string;
    hash: string;
    size: number;
  };
  frames: {
    frame: number;
    path: string;
    hash: string;
    size: number;
  }[];
  plugins?: string[];
  extra?: Record<string, unknown>;
}

export async function writeReleaseManifest(options: ReleaseManifestOptions): Promise<ReleaseManifest> {
  await ensureOutDir(dirname(options.outputPath));
  const manifestDir = dirname(options.outputPath);
  const frameEntries = [] as ReleaseManifest["frames"];
  for (const frame of options.frames) {
    const [hash, info] = await Promise.all([computeFileHash(frame.path), stat(frame.path)]);
    frameEntries.push({
      frame: frame.frame,
      path: relative(manifestDir, frame.path),
      hash,
      size: info.size,
    });
  }
  const videoInfo = await stat(options.videoFile);
  const videoHash = await computeFileHash(options.videoFile);
  const manifest: ReleaseManifest = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    fps: options.fps,
    durationMs: options.durationMs,
    totalFrames: options.frames.length,
    seed: options.seed,
    video: {
      path: relative(manifestDir, options.videoFile),
      hash: videoHash,
      size: videoInfo.size,
    },
    frames: frameEntries,
    plugins: options.plugins,
    extra: options.extra,
  };
  await writeFile(options.outputPath, JSON.stringify(manifest, null, 2), "utf-8");
  return manifest;
}

async function collectPngs(dir: string): Promise<string[]> {
  const files = await readdir(dir);
  return files
    .filter((file) => file.toLowerCase().endsWith(".png"))
    .sort();
}

async function readPng(path: string, PngConstructor: PngCtor): Promise<PngInstance> {
  return await new Promise<PngInstance>((resolve, reject) => {
    createReadStream(path)
      .pipe(new PngConstructor())
      .on("parsed", function (this: PngInstance) {
        resolve(this);
      })
      .on("error", reject);
  });
}

async function writePng(png: PngInstance, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    png
      .pack()
      .pipe(createWriteStream(path))
      .on("finish", resolve)
      .on("error", reject);
  });
}

function inferFramePattern(frames: FrameRenderResult[], outDir: string): string | undefined {
  const first = frames[0];
  if (!first) return undefined;
  const basename = first.path.startsWith(outDir) ? first.path.slice(outDir.length + 1) : relative(outDir, first.path);
  const match = basename.match(/^(.*?)(\d+)(\.png)$/);
  if (!match) return undefined;
  const [, prefix, digits, suffix] = match;
  return join(outDir, `${prefix}%0${digits.length}d${suffix}`);
}

async function computeFileHash(path: string, algorithm: string = "sha256"): Promise<string> {
  const hash = createHash(algorithm);
  return await new Promise<string>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
