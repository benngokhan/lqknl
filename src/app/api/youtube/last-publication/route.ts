import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { youtubeUploadJobs } from "@/db/schema";
import { listMyChannelVideos } from "@/lib/youtube";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (secret && req.headers.get("x-mira-key") === secret) return true;
  return isMiraSessionCookie(req.headers.get("cookie"));
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  try {
    const [channel, jobs] = await Promise.all([
      listMyChannelVideos(100),
      db.select().from(youtubeUploadJobs)
        .where(eq(youtubeUploadJobs.status, "completed"))
        .orderBy(desc(youtubeUploadJobs.completedAt))
        .limit(50),
    ]);

    const lastPublished = channel.videos
      .filter((video) => video.privacyStatus === "public" && video.publishedAt)
      .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime())[0] || null;

    const now = Date.now();
    const scheduledJobs = jobs
      .filter((job) => job.publishAt && job.publishAt.getTime() > now && job.youtubeUrl)
      .sort((a, b) => (a.publishAt?.getTime() || 0) - (b.publishAt?.getTime() || 0));
    const nextScheduledJob = scheduledJobs[0] || null;

    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      lastPublished: lastPublished ? {
        title: lastPublished.title,
        publishedAt: lastPublished.publishedAt,
        url: lastPublished.url,
      } : null,
      nextScheduled: nextScheduledJob ? {
        title: nextScheduledJob.title,
        publishAt: nextScheduledJob.publishAt?.toISOString() || null,
        url: nextScheduledJob.youtubeUrl,
        fileName: nextScheduledJob.driveFileName,
      } : null,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 300) : "YouTube yayın bilgisi alınamadı.",
    }, { status: 502 });
  }
}
