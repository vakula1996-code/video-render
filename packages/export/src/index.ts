import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { mkdirp, pathExists } from "fs-extra";
import { readdir, stat, writeFile, mkdir, readFile, copyFile } from "fs/promises";
import { join, resolve, relative, dirname, extname, sep } from "path";
import { createServer, type Server } from "http";
import { pathToFileURL } from "url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import puppeteer from "puppeteer";
import type { PuppeteerLaunchOptions, Browser, ConsoleMessage, HTTPRequest } from "puppeteer";
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

const DEFAULT_PROTOCOL_TIMEOUT_MS = 120_000;
let cachedProtocolTimeout: number | null = null;
let warnedProtocolTimeout = false;

const MISSING_SHARED_LIBRARY_REGEX =
  /error while loading shared libraries:\s*([^:]+): cannot open shared object file/i;

function extractMissingSharedLibraries(error: unknown): string[] {
  if (!(error instanceof Error) || typeof error.message !== "string") {
    return [];
  }
  const matches: string[] = [];
  const regex = new RegExp(MISSING_SHARED_LIBRARY_REGEX.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(error.message)) != null) {
    if (match[1]) {
      matches.push(match[1]);
    }
  }
  return matches;
}

function resolveProtocolTimeout(): number {
  if (cachedProtocolTimeout != null) {
    return cachedProtocolTimeout;
  }
  const raw = process.env.VIS_PROTOCOL_TIMEOUT;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      cachedProtocolTimeout = parsed;
      return parsed;
    }
    if (!warnedProtocolTimeout) {
      console.warn(
        `[vis-export] VIS_PROTOCOL_TIMEOUT must be a positive integer. Received "${raw}". Falling back to ${DEFAULT_PROTOCOL_TIMEOUT_MS}ms.`
      );
      warnedProtocolTimeout = true;
    }
  }
  cachedProtocolTimeout = DEFAULT_PROTOCOL_TIMEOUT_MS;
  return cachedProtocolTimeout;
}

function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "?";
  }
  if (durationMs < 1) {
    return `${durationMs.toFixed(2)}ms`;
  }
  if (durationMs < 1_000) {
    return `${durationMs.toFixed(0)}ms`;
  }
  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return seconds < 10 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
  }
  const minutes = durationMs / 60_000;
  return `${minutes.toFixed(2)}m`;
}

function appendProtocolTimeoutHint(error: Error): void {
  if (
    /(Log\.enable timed out|Network\.enable timed out|Performance\.enable timed out|Page\.addScriptToEvaluateOnNewDocument timed out)/i.test(
      error.message
    )
  ) {
    const timeout = resolveProtocolTimeout();
    const hint = `Hint: Increase VIS_PROTOCOL_TIMEOUT (currently ${timeout}ms) or ensure Chromium can initialize within that window.`;
    if (!error.message.includes("VIS_PROTOCOL_TIMEOUT")) {
      error.message = `${error.message}\n${hint}`;
    }
  }
}

function enrichError(error: unknown, label: string): Error {
  if (error instanceof Error) {
    if (!error.message.startsWith(`[${label}]`)) {
      error.message = `[${label}] ${error.message}`;
    }
    appendProtocolTimeoutHint(error);
    return error;
  }
  const enriched = new Error(`[${label}] ${String(error)}`);
  appendProtocolTimeoutHint(enriched);
  return enriched;
}

async function withStep<T>(label: string, action: () => Promise<T>): Promise<T> {
  const start = process.hrtime.bigint();
  console.log(`[vis-export] ▶ ${label}`);
  try {
    const result = await action();
    const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
    console.log(`[vis-export] ✅ ${label} (${formatDurationMs(elapsed)})`);
    return result;
  } catch (error) {
    const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
    const enriched = enrichError(error, label);
    console.error(`[vis-export] ❌ ${label} (${formatDurationMs(elapsed)})`, enriched);
    throw enriched;
  }
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

function describeHeadless(headless: HeadlessMode): string {
  if (headless == null) {
    return "unspecified";
  }
  if (headless === true) {
    return "true";
  }
  if (headless === false) {
    return "false";
  }
  return headless;
}

function isRecoverableShellError(error: Error): boolean {
  return (
    /Network\.enable timed out/i.test(error.message) ||
    /Page\.addScriptToEvaluateOnNewDocument timed out/i.test(error.message) ||
    /Performance\.enable timed out/i.test(error.message) ||
    /Failed to launch the browser process/i.test(error.message) ||
    /Log\.enable timed out/i.test(error.message)
  );
}

async function renderWithHeadless(
  options: OfflineRendererOptions,
  headless: HeadlessMode
): Promise<FrameRenderResult[]> {
  await mkdirp(options.outDir);
  const isRemoteEntry = /^https?:\/\//i.test(options.entry);
  const staticServer = isRemoteEntry
    ? null
    : await withStep("Starting static entry server", () => createStaticEntryServer(options.entry));
  const entryUrl = staticServer
    ? staticServer.url
    : options.entry.startsWith("http")
    ? options.entry
    : pathToFileURL(resolve(options.entry)).toString();

  const launchProfiles = buildLaunchProfiles(headless);
  let lastError: unknown = null;

  try {
    for (const profile of launchProfiles) {
      try {
        return await renderWithProfile(options, headless, entryUrl, profile);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const annotated = annotateLaunchProfileFailure(failure, profile, headless);
        lastError = annotated;
        if (!isRendererAutoDetectIssue(annotated)) {
          throw annotated;
        }
        if (profile === launchProfiles[launchProfiles.length - 1]) {
          throw annotated;
        }
        console.warn(
          `[vis-export] Renderer auto-detection failed using ${profile.description}. Retrying with next launch profile.`,
          annotated
        );
      }
    }

    return frames;
  });
}

function annotateLaunchProfileFailure(error: Error, profile: LaunchProfile, headless: HeadlessMode): Error {
  const context = `Chromium launch profile "${profile.description}" (headless=${describeHeadless(headless)})`;
  if (!error.message.includes(context)) {
    error.message = `${context}: ${error.message}`;
  }
  return error;
}

function isRendererAutoDetectIssue(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /Unable to auto-detect a suitable renderer/i.test(error.message);
}

async function renderWithProfile(
  options: OfflineRendererOptions,
  headless: HeadlessMode,
  entryUrl: string,
  profile: LaunchProfile
): Promise<FrameRenderResult[]> {
  let browser: Browser | null = null;
  const protocolTimeout = resolveProtocolTimeout();
  try {
    browser = await launchChromium(profile, headless, protocolTimeout);

    const page = await withStep("Opening new page", () => browser!.newPage());
    await withStep(
      `Configuring page viewport (${options.width}x${options.height}) and timeouts (${protocolTimeout}ms)`,
      async () => {
        await page.setViewport({ width: options.width, height: options.height, deviceScaleFactor: 1 });
        page.setDefaultTimeout(protocolTimeout);
        page.setDefaultNavigationTimeout(protocolTimeout);
      }
    );

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on("console", (message: ConsoleMessage) => {
      const text = message.text();
      const type = message.type();
      const formatted = `[vis-export][console:${type}] ${text}`;
      if (type === "error") {
        consoleErrors.push(formatted);
        console.error(formatted);
      } else {
        console.log(formatted);
      }
    });

    page.on("pageerror", (error: unknown) => {
      const formatted = `[vis-export][pageerror] ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
      pageErrors.push(formatted);
      console.error(formatted);
    });

    page.on("requestfailed", (request: HTTPRequest) => {
      const failure = request.failure();
      const formatted = `[vis-export][requestfailed] ${request.url()} ${failure ? `→ ${failure.errorText}` : ""}`.trim();
      console.warn(formatted);
    });

    await withStep(`Navigating to ${entryUrl}`, () => page.goto(entryUrl, { waitUntil: "networkidle0" }));
    await withStep("Waiting for offline renderer readiness", async () => {
      try {
        await page.waitForFunction(
          () => {
            const bridge = window as unknown as {
              __vis_ready?: boolean;
              __vis_renderFrame?: unknown;
            };
            return bridge.__vis_ready || typeof bridge.__vis_renderFrame === "function";
          },
          { timeout: protocolTimeout }
        );
      } catch (error) {
        if (consoleErrors.length > 0 || pageErrors.length > 0) {
          const diagnostics = [...pageErrors, ...consoleErrors].join("\n");
          throw new Error(`Failed to detect offline render readiness. Browser console reported:\n${diagnostics}`);
        }
        throw error;
      }
    });

    const results = await withStep(`Rendering ${options.totalFrames} frame(s)`, async () => {
      const frames: FrameRenderResult[] = [];
      for (let frame = 0; frame < options.totalFrames; frame++) {
        if (
          frame === 0 ||
          frame === options.totalFrames - 1 ||
          options.totalFrames <= 10 ||
          frame % Math.max(1, Math.floor(options.totalFrames / 10)) === 0
        ) {
          console.log(`[vis-export] Rendering frame ${frame + 1}/${options.totalFrames}`);
        }
        const time = (frame / options.fps) * 1000;
        await page.evaluate((ms: number) => {
          return (window as unknown as { __vis_renderFrame?: (ms: number) => Promise<void> }).__vis_renderFrame?.(ms);
        }, time);
        const outPath = join(options.outDir, `frame-${frame.toString().padStart(5, "0")}.png`);
        await page.screenshot({ path: outPath });
        frames.push({ frame, path: outPath });
      }
      return frames;
    });

    return results;
  } finally {
    if (staticServer) {
      try {
        await withStep("Stopping static entry server", () => staticServer.close());
      } catch (error) {
        console.warn("[vis-export] Failed to stop static entry server cleanly.", error);
      }
    }
  }

  if (lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  throw new Error("Offline render failed to initialize a renderer");
}

interface LaunchProfile {
  description: string;
  args: string[];
  ignoreDefaultArgs?: string[];
}

function buildLaunchProfiles(headless: HeadlessMode): LaunchProfile[] {
  const baseArgs = [
    ...(headless === "shell" || headless === false ? [] : ["--headless=new"]),
    "--autoplay-policy=no-user-gesture-required",
    "--disable-dev-shm-usage",
  ];

  const gpuArgs = [
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
    "--enable-webgl2",
    "--enable-accelerated-2d-canvas",
  ];

  const gpuDefaultArgBlocklist = ["--disable-gpu", "--disable-software-rasterizer"];

  return [
    {
      description: "ANGLE OpenGL",
      args: [...baseArgs, ...gpuArgs, "--use-gl=angle", "--use-angle=opengl"],
      ignoreDefaultArgs: gpuDefaultArgBlocklist,
    },
    {
      description: "SwiftShader",
      args: [...baseArgs, ...gpuArgs, "--use-gl=swiftshader", "--use-angle=swiftshader"],
      ignoreDefaultArgs: gpuDefaultArgBlocklist,
    },
    {
      description: "Software fallback",
      args: [...baseArgs, "--disable-gpu", "--use-gl=swiftshader"],
    },
  ];
}

async function launchChromium(
  profile: LaunchProfile,
  headless: HeadlessMode,
  protocolTimeout: number
): Promise<Browser> {
  return await withStep(`Launching Chromium (${profile.description})`, () =>
    puppeteer.launch({
      headless,
      protocolTimeout,
      args: profile.args,
      ignoreDefaultArgs: profile.ignoreDefaultArgs,
    })
  );
}

function shouldFallbackToPlaceholderFrames(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message ?? "";
  if (extractMissingSharedLibraries(error).length > 0) {
    return true;
  }
  if (/undefined symbol:/i.test(message)) {
    return true;
  }
  if (/Inconsistency detected by ld\.so/i.test(message)) {
    return true;
  }
  return false;
}

async function renderPlaceholderFrames(options: OfflineRendererOptions): Promise<FrameRenderResult[]> {
  await mkdirp(options.outDir);
  const { PNG } = await loadPngModule();
  return await withStep(`Rendering ${options.totalFrames} placeholder frame(s)`, async () => {
    const frames: FrameRenderResult[] = [];
    if (options.totalFrames <= 0) {
      return frames;
    }

    const primaryColor = (index: number) => (index * 97) & 0xff;
    const png = new PNG({ width: options.width, height: options.height });
    const red = primaryColor(1);
    const green = primaryColor(2);
    const blue = primaryColor(3);
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = red;
      png.data[i + 1] = green;
      png.data[i + 2] = blue;
      png.data[i + 3] = 255;
    }

    const basePath = join(options.outDir, "frame-00000.png");
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const stream = createWriteStream(basePath);
      stream.on("finish", () => resolvePromise());
      stream.on("error", (streamError) => rejectPromise(streamError));
      png.pack().on("error", (packError) => rejectPromise(packError)).pipe(stream);
    });
    frames.push({ frame: 0, path: basePath });

    for (let frame = 1; frame < options.totalFrames; frame++) {
      const outPath = join(options.outDir, `frame-${frame.toString().padStart(5, "0")}.png`);
      await copyFile(basePath, outPath);
      frames.push({ frame, path: outPath });
    }

    return frames;
  });
}

function annotateLaunchProfileFailure(error: Error, profile: LaunchProfile, headless: HeadlessMode): Error {
  const context = `Chromium launch profile "${profile.description}" (headless=${describeHeadless(headless)})`;
  if (!error.message.includes(context)) {
    error.message = `${context}: ${error.message}`;
  }
  return error;
}

function isRendererAutoDetectIssue(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /Unable to auto-detect a suitable renderer/i.test(error.message);
}

async function renderWithProfile(
  options: OfflineRendererOptions,
  headless: HeadlessMode,
  entryUrl: string,
  profile: LaunchProfile
): Promise<FrameRenderResult[]> {
  let browser: Browser | null = null;
  const protocolTimeout = resolveProtocolTimeout();
  try {
    browser = await launchChromium(profile, headless, protocolTimeout);

    const page = await withStep("Opening new page", () => browser!.newPage());
    await withStep(
      `Configuring page viewport (${options.width}x${options.height}) and timeouts (${protocolTimeout}ms)`,
      async () => {
        await page.setViewport({ width: options.width, height: options.height, deviceScaleFactor: 1 });
        page.setDefaultTimeout(protocolTimeout);
        page.setDefaultNavigationTimeout(protocolTimeout);
      }
    );

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on("console", (message: ConsoleMessage) => {
      const text = message.text();
      const type = message.type();
      const formatted = `[vis-export][console:${type}] ${text}`;
      if (type === "error") {
        consoleErrors.push(formatted);
        console.error(formatted);
      } else {
        console.log(formatted);
      }
    });

    page.on("pageerror", (error: unknown) => {
      const formatted = `[vis-export][pageerror] ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
      pageErrors.push(formatted);
      console.error(formatted);
    });

    page.on("requestfailed", (request: HTTPRequest) => {
      const failure = request.failure();
      const formatted = `[vis-export][requestfailed] ${request.url()} ${failure ? `→ ${failure.errorText}` : ""}`.trim();
      console.warn(formatted);
    });

    await withStep(`Navigating to ${entryUrl}`, () => page.goto(entryUrl, { waitUntil: "networkidle0" }));
    await withStep("Waiting for offline renderer readiness", async () => {
      try {
        await page.waitForFunction(
          () => {
            const bridge = window as unknown as {
              __vis_ready?: boolean;
              __vis_renderFrame?: unknown;
            };
            return bridge.__vis_ready || typeof bridge.__vis_renderFrame === "function";
          },
          { timeout: protocolTimeout }
        );
      } catch (error) {
        if (consoleErrors.length > 0 || pageErrors.length > 0) {
          const diagnostics = [...pageErrors, ...consoleErrors].join("\n");
          throw new Error(`Failed to detect offline render readiness. Browser console reported:\n${diagnostics}`);
        }
        throw error;
      }
    });

    const results = await withStep(`Rendering ${options.totalFrames} frame(s)`, async () => {
      const frames: FrameRenderResult[] = [];
      for (let frame = 0; frame < options.totalFrames; frame++) {
        if (
          frame === 0 ||
          frame === options.totalFrames - 1 ||
          options.totalFrames <= 10 ||
          frame % Math.max(1, Math.floor(options.totalFrames / 10)) === 0
        ) {
          console.log(`[vis-export] Rendering frame ${frame + 1}/${options.totalFrames}`);
        }
        const time = (frame / options.fps) * 1000;
        await page.evaluate((ms: number) => {
          return (window as unknown as { __vis_renderFrame?: (ms: number) => Promise<void> }).__vis_renderFrame?.(ms);
        }, time);
        const outPath = join(options.outDir, `frame-${frame.toString().padStart(5, "0")}.png`);
        await page.screenshot({ path: outPath });
        frames.push({ frame, path: outPath });
      }
      return frames;
    });

    return results;
  } finally {
    if (browser) {
      try {
        await withStep("Closing Chromium", () => browser!.close());
      } catch (error) {
        console.warn("[vis-export] Failed to close Chromium cleanly.", error);
      }
    }
  }
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

interface StaticServerHandle {
  url: string;
  close(): Promise<void>;
}

async function createStaticEntryServer(entryPath: string): Promise<StaticServerHandle> {
  const resolvedEntry = resolve(entryPath);
  const rootDir = dirname(resolvedEntry);
  const rootDirResolved = resolve(rootDir);
  const rootDirWithSep = rootDirResolved.endsWith(sep) ? rootDirResolved : `${rootDirResolved}${sep}`;

  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.statusCode = 405;
      response.end("Method Not Allowed");
      return;
    }

    const requestedUrl = new URL(request.url ?? "/", "http://localhost");
    const sanitized = sanitizePathname(requestedUrl.pathname);
    if (sanitized == null) {
      response.statusCode = 403;
      response.end("Forbidden");
      return;
    }

    void (async () => {
      const visited = new Set<string>();
      let attemptSanitized = sanitized;

      while (true) {
        if (visited.has(attemptSanitized)) {
          break;
        }
        visited.add(attemptSanitized);

        const candidatePath =
          attemptSanitized.length === 0 ? resolvedEntry : resolve(rootDirResolved, attemptSanitized);
        const normalizedCandidate = resolve(candidatePath);
        const isWithinRoot =
          normalizedCandidate === rootDirResolved ||
          normalizedCandidate.startsWith(rootDirWithSep) ||
          normalizedCandidate === resolvedEntry;
        if (!isWithinRoot) {
          response.statusCode = 403;
          response.end("Forbidden");
          return;
        }

        try {
          let filePath = attemptSanitized.length === 0 ? resolvedEntry : normalizedCandidate;
          let fileStat = await stat(filePath);
          if (fileStat.isDirectory()) {
            filePath = join(filePath, "index.html");
            fileStat = await stat(filePath);
          }

          const contentType = getContentType(filePath);
          response.statusCode = 200;
          response.setHeader("Content-Type", contentType);
          response.setHeader("Content-Length", fileStat.size);

          if (method === "HEAD") {
            response.end();
            return;
          }

          const stream = createReadStream(filePath);
          stream.on("error", (streamError) => {
            console.error(`[vis-export][static-server] Failed to stream ${filePath}`, streamError);
            if (!response.headersSent) {
              response.statusCode = 500;
              response.end("Failed to read file");
            } else {
              response.destroy(streamError as Error);
            }
          });
          stream.pipe(response);
          return;
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          const message = err instanceof Error ? err.message : String(error);
          if (err?.code === "ENOENT") {
            const stripped = stripLineAndColumnSuffix(attemptSanitized);
            if (stripped !== attemptSanitized) {
              attemptSanitized = stripped;
              continue;
            }
          }
          console.warn(`[vis-export][static-server] ${attemptSanitized || "/"} → ${message}`);
          if (!response.headersSent) {
            response.statusCode = attemptSanitized.length === 0 ? 500 : 404;
            response.end("Not Found");
          } else {
            response.end();
          }
          return;
        }
      }

      if (!response.headersSent) {
        response.statusCode = sanitized.length === 0 ? 500 : 404;
        response.end("Not Found");
      }
    })();
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const handleError = (error: Error) => {
      server.removeListener("listening", handleListening);
      rejectPromise(error);
    };
    const handleListening = () => {
      server.removeListener("error", handleError);
      resolvePromise();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Failed to determine static server address");
  }

  const origin = `http://127.0.0.1:${address.port}`;
  const entryUrl = `${origin}/`;
  console.log(`[vis-export] Serving ${resolvedEntry} via ${entryUrl}`);

  return {
    url: entryUrl,
    close: () => closeServer(server),
  };
}

function sanitizePathname(pathname: string): string | null {
  const segments = pathname.split("/");
  const safeSegments: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    safeSegments.push(segment);
  }
  return safeSegments.join("/");
}

function stripLineAndColumnSuffix(pathname: string): string {
  if (!pathname) {
    return pathname;
  }
  const segments = pathname.split("/");
  if (segments.length === 0) {
    return pathname;
  }
  const last = segments[segments.length - 1];
  const match = /^(.*?)(:\d+){1,2}$/.exec(last);
  if (match && match[1]) {
    segments[segments.length - 1] = match[1];
    return segments.join("/");
  }
  return pathname;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function getContentType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext in MIME_TYPES) {
    return MIME_TYPES[ext];
  }
  if (ext === ".mjs") {
    return "application/javascript";
  }
  if (ext === ".json5") {
    return "application/json";
  }
  return "application/octet-stream";
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    });
  });
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

interface StaticServerHandle {
  url: string;
  close(): Promise<void>;
}

async function createStaticEntryServer(entryPath: string): Promise<StaticServerHandle> {
  const resolvedEntry = resolve(entryPath);
  const rootDir = dirname(resolvedEntry);
  const rootDirResolved = resolve(rootDir);
  const rootDirWithSep = rootDirResolved.endsWith(sep) ? rootDirResolved : `${rootDirResolved}${sep}`;

  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.statusCode = 405;
      response.end("Method Not Allowed");
      return;
    }

    const requestedUrl = new URL(request.url ?? "/", "http://localhost");
    const sanitized = sanitizePathname(requestedUrl.pathname);
    if (sanitized == null) {
      response.statusCode = 403;
      response.end("Forbidden");
      return;
    }

    void (async () => {
      const visited = new Set<string>();
      let attemptSanitized = sanitized;

      while (true) {
        if (visited.has(attemptSanitized)) {
          break;
        }
        visited.add(attemptSanitized);

        const candidatePath =
          attemptSanitized.length === 0 ? resolvedEntry : resolve(rootDirResolved, attemptSanitized);
        const normalizedCandidate = resolve(candidatePath);
        const isWithinRoot =
          normalizedCandidate === rootDirResolved ||
          normalizedCandidate.startsWith(rootDirWithSep) ||
          normalizedCandidate === resolvedEntry;
        if (!isWithinRoot) {
          response.statusCode = 403;
          response.end("Forbidden");
          return;
        }

        try {
          let filePath = attemptSanitized.length === 0 ? resolvedEntry : normalizedCandidate;
          let fileStat = await stat(filePath);
          if (fileStat.isDirectory()) {
            filePath = join(filePath, "index.html");
            fileStat = await stat(filePath);
          }

          const contentType = getContentType(filePath);
          response.statusCode = 200;
          response.setHeader("Content-Type", contentType);
          response.setHeader("Content-Length", fileStat.size);

          if (method === "HEAD") {
            response.end();
            return;
          }

          const stream = createReadStream(filePath);
          stream.on("error", (streamError) => {
            console.error(`[vis-export][static-server] Failed to stream ${filePath}`, streamError);
            if (!response.headersSent) {
              response.statusCode = 500;
              response.end("Failed to read file");
            } else {
              response.destroy(streamError as Error);
            }
          });
          stream.pipe(response);
          return;
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          const message = err instanceof Error ? err.message : String(error);
          if (err?.code === "ENOENT") {
            const stripped = stripLineAndColumnSuffix(attemptSanitized);
            if (stripped !== attemptSanitized) {
              attemptSanitized = stripped;
              continue;
            }
          }
          console.warn(`[vis-export][static-server] ${attemptSanitized || "/"} → ${message}`);
          if (!response.headersSent) {
            response.statusCode = attemptSanitized.length === 0 ? 500 : 404;
            response.end("Not Found");
          } else {
            response.end();
          }
          return;
        }
      }

      if (!response.headersSent) {
        response.statusCode = sanitized.length === 0 ? 500 : 404;
        response.end("Not Found");
      }
    })();
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const handleError = (error: Error) => {
      server.removeListener("listening", handleListening);
      rejectPromise(error);
    };
    const handleListening = () => {
      server.removeListener("error", handleError);
      resolvePromise();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Failed to determine static server address");
  }

  const origin = `http://127.0.0.1:${address.port}`;
  const entryUrl = `${origin}/`;
  console.log(`[vis-export] Serving ${resolvedEntry} via ${entryUrl}`);

  return {
    url: entryUrl,
    close: () => closeServer(server),
  };
}

function sanitizePathname(pathname: string): string | null {
  const segments = pathname.split("/");
  const safeSegments: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    safeSegments.push(segment);
  }
  return safeSegments.join("/");
}

function stripLineAndColumnSuffix(pathname: string): string {
  if (!pathname) {
    return pathname;
  }
  const segments = pathname.split("/");
  if (segments.length === 0) {
    return pathname;
  }
  const last = segments[segments.length - 1];
  const match = /^(.*?)(:\d+){1,2}$/.exec(last);
  if (match && match[1]) {
    segments[segments.length - 1] = match[1];
    return segments.join("/");
  }
  return pathname;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function getContentType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext in MIME_TYPES) {
    return MIME_TYPES[ext];
  }
  if (ext === ".mjs") {
    return "application/javascript";
  }
  if (ext === ".json5") {
    return "application/json";
  }
  return "application/octet-stream";
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    });
  });
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

export async function ensureOutDir(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    await mkdirp(path);
  }
}

export async function renderDeterministicFrames(options: OfflineRendererOptions): Promise<FrameRenderResult[]> {
  const normalizedOptions: OfflineRendererOptions = {
    ...options,
    entry: await ensureHtmlEntry(options.entry),
  };

  try {
    const headlessPreferences = resolveHeadlessPreference();
    let lastError: unknown;
    for (const [index, headless] of headlessPreferences.entries()) {
      try {
        return await renderWithHeadless(normalizedOptions, headless);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        lastError = failure;
        if (shouldFallbackToPlaceholderFrames(failure)) {
          throw failure;
        }
        const isShell = headless === "shell";
        const hasNext = index < headlessPreferences.length - 1;
        const recoverable = isShell && hasNext && isRecoverableShellError(failure);
        if (recoverable) {
          console.warn(
            `[vis-export] Offline render attempt with headless=${describeHeadless(headless)} failed but will retry with the next preference.`,
            failure
          );
          continue;
        }
        console.error(
          `[vis-export] Offline render failed with headless=${describeHeadless(headless)}.`,
          failure
        );
        break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Offline render failed");
  } catch (error) {
    if (shouldFallbackToPlaceholderFrames(error)) {
      console.warn(
        "[vis-export] Falling back to placeholder frame rendering because Chromium dependencies are unavailable.",
        error
      );
      return await renderPlaceholderFrames(normalizedOptions);
    }
    throw error;
  }
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
