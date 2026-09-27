import { NextResponse } from "next/server";
import { getDownloadJob } from "@/lib/downloader";

export const runtime = "nodejs";

/**
 * Downloads are created synchronously, but the generated file is retained
 * briefly so the frontend and API clients can inspect a real ready state.
 */
export async function GET(_request, { params }) {
  const { jobId } = await params;
  const job = getDownloadJob(jobId);

  if (!job) {
    return NextResponse.json(
      { success: false, jobId, error: "That download has expired or does not exist.", code: "DOWNLOAD_NOT_FOUND" },
      { status: 404 }
    );
  }

  return NextResponse.json(
    {
      success: true,
      jobId,
      status: "ready",
      size: job.size,
      download_url: `/api/download?jobId=${encodeURIComponent(job.id)}`
    }
  );
}
