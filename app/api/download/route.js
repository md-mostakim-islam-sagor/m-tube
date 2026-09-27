import { NextResponse } from "next/server";
import { DownloadRequestSchema, parseJsonBody } from "@/lib/validation";
import { assertSafeUrl, toSafeErrorResponse, SafeError } from "@/lib/security";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { downloadMedia, openDownload } from "@/lib/downloader";
import { Readable } from "node:stream";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const rate = checkRateLimit(ip);
    if (!rate.allowed) {
      throw new SafeError("RATE_LIMITED", "Too many requests. Please slow down and try again shortly.", 429);
    }

    const { data, error } = await parseJsonBody(request, DownloadRequestSchema);
    if (error) throw new SafeError(error.code, error.message, 400);

    const parsedUrl = assertSafeUrl(data.url);

    const job = await downloadMedia(parsedUrl.href);

    return NextResponse.json({
      success: true,
      provider: "@media-downloaders/v2",
      download_url: `/api/download?jobId=${encodeURIComponent(job.id)}`,
      format: "mp4",
      quality: "original",
      size_label: `${(job.size / (1024 * 1024)).toFixed(1)} MB`
    });
  } catch (err) {
    const safe = toSafeErrorResponse(err);
    return NextResponse.json(safe, { status: safe.status || 400 });
  }
}

export async function GET(request) {
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (jobId) {
    const opened = openDownload(jobId);
    if (!opened) {
      return NextResponse.json(
        { success: false, error: "That download has expired or does not exist.", code: "DOWNLOAD_NOT_FOUND" },
        { status: 404 }
      );
    }

    return new NextResponse(Readable.toWeb(opened.stream), {
      headers: {
        "Content-Type": opened.job.contentType,
        "Content-Length": String(opened.job.size),
        "Content-Disposition": `attachment; filename="${opened.job.filename}"`,
        "Cache-Control": "private, no-store"
      }
    });
  }

  return NextResponse.json(
    { success: false, error: "Use POST with a JSON body or GET with a valid jobId." },
    { status: 405 }
  );
}
