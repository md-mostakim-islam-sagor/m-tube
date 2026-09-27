/**
 * M-TUBE — Real downloader backend
 *
 * @media-downloaders/v2 writes a completed file to the current working
 * directory and returns its filename. This adapter serializes those calls,
 * moves only the verified output into an isolated temporary directory, and
 * exposes it through a short-lived in-memory job store.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import MediaDownloader from "@media-downloaders/v2";
import { SafeError } from "./security";
import { detectPlatform } from "./platform";

const WORKING_DIRECTORY = process.cwd();
const DOWNLOAD_DIRECTORY = path.join(os.tmpdir(), "m-tube-downloads");
const JOB_TTL_MS = 60 * 60 * 1000;
const JOB_ID_PATTERN = /^[a-f0-9]{48}$/;

const jobs = new Map();
let downloadQueue = Promise.resolve();

function withDownloadLock(task) {
  const run = downloadQueue.then(task, task);
  downloadQueue = run.catch(() => undefined);
  return run;
}

function safeTempFilePath(fileName) {
  if (typeof fileName !== "string" || !fileName) {
    throw new SafeError("DOWNLOAD_FAILED", "The downloader did not return a file.");
  }

  const basename = path.basename(fileName);
  if (!basename.startsWith("temp_video")) {
    throw new SafeError("DOWNLOAD_FAILED", "The downloader returned an invalid file.");
  }

  const candidate = path.resolve(WORKING_DIRECTORY, basename);
  const root = `${path.resolve(WORKING_DIRECTORY)}${path.sep}`;
  if (!candidate.startsWith(root)) {
    throw new SafeError("DOWNLOAD_FAILED", "The downloader returned an invalid file.");
  }
  return candidate;
}

async function removePackageTempFiles() {
  const entries = await fsp.readdir(WORKING_DIRECTORY, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("temp_video"))
      .map((entry) => fsp.rm(path.join(WORKING_DIRECTORY, entry.name), { force: true }))
  );
}

function contentTypeFor(extension) {
  const types = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".aac": "audio/aac"
  };
  return types[extension.toLowerCase()] || "application/octet-stream";
}

function cleanTitle(url, platformName) {
  const parsed = new URL(url);
  const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();

  if (lastSegment) {
    try {
      const decoded = decodeURIComponent(lastSegment)
        .replace(/\.[a-z0-9]{2,5}$/i, "")
        .replace(/[-_]+/g, " ")
        .trim();
      if (decoded.length >= 2 && decoded.length <= 180) return decoded;
    } catch {
      // Use the platform label below when a path segment is not decodable.
    }
  }

  return `${platformName || "Supported platform"} media`;
}

function sweepJobs(now = Date.now()) {
  for (const [jobId, job] of jobs) {
    if (job.expiresAt <= now) {
      jobs.delete(jobId);
      void fsp.rm(job.path, { force: true }).catch(() => undefined);
    }
  }
}

const cleanupTimer = setInterval(() => sweepJobs(), 10 * 60 * 1000);
cleanupTimer.unref?.();

export function getMediaInfo(url) {
  const platform = detectPlatform(url);
  const isSupported = typeof MediaDownloader.isVideoLink === "function"
    && MediaDownloader.isVideoLink(url);

  if (!isSupported) {
    throw new SafeError(
      "UNSUPPORTED_URL",
      "This link is not supported by the configured downloader."
    );
  }

  return {
    provider: "@media-downloaders/v2",
    platform: platform?.name || "Supported platform",
    title: cleanTitle(url, platform?.name),
    thumbnail: null,
    uploader: null,
    duration: null,
    formats: [{ type: "video", quality: "original", container: "mp4", sizeLabel: null }],
    isMock: false
  };
}

export async function downloadMedia(url) {
  return withDownloadLock(async () => {
    sweepJobs();
    await fsp.mkdir(DOWNLOAD_DIRECTORY, { recursive: true });
    await removePackageTempFiles();

    let packageFilePath;
    try {
      packageFilePath = await MediaDownloader(url, {
        autocrop: false,
        limitSizeMB: null,
        rotation: null,
        YTBcookie: process.env.MTUBE_YOUTUBE_COOKIE || undefined,
        YTBmaxduration: Number.parseInt(process.env.MTUBE_YOUTUBE_MAX_DURATION || "1800", 10)
      });

      const sourcePath = safeTempFilePath(packageFilePath);
      const stats = await fsp.stat(sourcePath);
      if (!stats.isFile() || stats.size <= 0) {
        throw new SafeError("DOWNLOAD_FAILED", "The downloader returned an empty file.");
      }

      const extension = path.extname(sourcePath).toLowerCase() || ".mp4";
      const jobId = crypto.randomBytes(24).toString("hex");
      const destination = path.join(DOWNLOAD_DIRECTORY, `${jobId}${extension}`);
      await fsp.rename(sourcePath, destination);

      const job = {
        id: jobId,
        path: destination,
        filename: `m-tube-${jobId.slice(0, 12)}${extension}`,
        contentType: contentTypeFor(extension),
        size: stats.size,
        createdAt: Date.now(),
        expiresAt: Date.now() + JOB_TTL_MS
      };
      jobs.set(jobId, job);
      return job;
    } catch (error) {
      if (packageFilePath) {
        const possiblePath = path.resolve(WORKING_DIRECTORY, path.basename(String(packageFilePath)));
        if (possiblePath.startsWith(`${WORKING_DIRECTORY}${path.sep}`)) {
          await fsp.rm(possiblePath, { force: true }).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      await removePackageTempFiles().catch(() => undefined);
    }
  });
}

export function getDownloadJob(jobId) {
  sweepJobs();
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) return null;
  const job = jobs.get(jobId);
  if (!job || job.expiresAt <= Date.now()) return null;
  return job;
}

export function openDownload(jobId) {
  const job = getDownloadJob(jobId);
  if (!job || !fs.existsSync(job.path)) return null;
  return { job, stream: fs.createReadStream(job.path) };
}