import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { youtubeUploadJobs } from "@/db/schema";
import { listDriveFolderFiles } from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Slot = "shorts-noon" | "shorts-afternoon" | "shorts-evening" | "long";
type Mode = "scheduled" | "immediate";

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  return Boolean(expected && req.headers.get("x-mira-key") === expected);
}

function istanbulDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return { year: Number(part("year")), month: Number(part("month")), day: Number(part("day")) };
}

function dateKey({ year, month, day }: { year: number; month: number; day: number }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function localDateTime(date: string, time: string) {
  // Türkiye stays UTC+03:00; explicit offset avoids server timezone dependence.
  return new Date(`${date}T${time}:00+03:00`);
}

function daysFromStart(date: string) {
  const start = Date.UTC(2026, 9, 20);
  const current = new Date(`${date}T00:00:00Z`).getTime();
  return Math.floor((current - start) / 86_400_000);
}

function isLongVideoDay(date: string) {
  return daysFromStart(date) % 2 === 0;
}

function slotTime(slot: Slot, date: string) {
  if (slot === "shorts-noon") return "12:30";
  if (slot === "shorts-afternoon") return "16:30";
  if (slot === "shorts-evening") return isLongVideoDay(date) ? "21:00" : "20:30";
  return "18:00";
}

function filenameIndex(name: string, kind: "short" | "long") {
  const match = name.match(kind === "short" ? /^video_(\d+)\.mp4$/i : /^uzun_video_(\d+)\.mp4$/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "Yetkisiz. x-mira-key gerekli." }, { status: 401 });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const slot = body.slot as Slot;
  const mode = (body.mode === "immediate" ? "immediate" : "scheduled") as Mode;
  if (!["shorts-noon", "shorts-afternoon", "shorts-evening", "long"].includes(slot)) {
    return NextResponse.json({ ok: false, error: "slot: shorts-noon, shorts-evening veya long olmalı." }, { status: 400 });
  }
  if (body.confirm !== true) return NextResponse.json({ ok: false, error: "İşlem için confirm=true gerekli." }, { status: 400 });

  const now = new Date();
  let publishAt: Date;
  let date: string;
  if (mode === "immediate") {
    publishAt = new Date(now.getTime() + 10 * 60_000);
    date = dateKey(istanbulDateParts(publishAt));
  } else {
    const today = dateKey(istanbulDateParts(now));
    if (today < "2026-10-20") {
      return NextResponse.json({ ok: true, skipped: true, reason: "Otomasyon başlangıç tarihi henüz gelmedi; planlı yayın yapılmadı.", slot, startsOn: "2026-10-20" });
    }
    if (slot === "long" && !isLongVideoDay(today)) {
      return NextResponse.json({ ok: true, skipped: true, reason: "Uzun video yalnızca iki günde bir planlanır.", slot, date: today });
    }
    if (slot === "shorts-afternoon" && isLongVideoDay(today)) {
      return NextResponse.json({ ok: true, skipped: true, reason: "Uzun video günlerinde 16:30 Shorts atlanır; o gün toplam yayın sayısı 3 ile sınırlıdır.", slot, date: today });
    }
    date = today;
    publishAt = localDateTime(date, slotTime(slot, date));
    if (publishAt.getTime() <= now.getTime() + 60_000) {
      return NextResponse.json({ ok: true, skipped: true, reason: "Bu yayın saati geçti veya çok yakın; yinelenen/geçmiş zamanlı yükleme yapılmadı.", slot, date, publishAt: publishAt.toISOString() });
    }
  }

  const files = await listDriveFolderFiles();
  const videoFiles = files.filter((file) =>
    file.mimeType === "video/mp4" &&
    (slot === "long" ? /^uzun_video_\d+\.mp4$/i.test(file.name) : /^video_\d+\.mp4$/i.test(file.name))
  ).sort((a, b) => filenameIndex(a.name, slot === "long" ? "long" : "short") - filenameIndex(b.name, slot === "long" ? "long" : "short"));

  const jobs = await db.select().from(youtubeUploadJobs);
  const byDriveId = new Map(jobs.map((job) => [job.driveFileId, job]));
  const targetWindow = 2 * 60_000;
  const slotAlreadyBooked = jobs.find((job) =>
    job.publishAt &&
    Math.abs(job.publishAt.getTime() - publishAt.getTime()) <= targetWindow &&
    ["uploading", "completed", "needs_review"].includes(job.status)
  );
  if (slotAlreadyBooked) {
    return NextResponse.json({
      ok: true, skipped: true, reason: "Bu yayın saati için zaten bir Drive yükleme işi kayıtlı; ikinci yükleme engellendi.",
      slot, fileName: slotAlreadyBooked.driveFileName, publishAt: slotAlreadyBooked.publishAt?.toISOString(),
      videoId: slotAlreadyBooked.youtubeVideoId || null,
    });
  }

  const minimumIndex = slot === "long" ? 3 : 6;
  const file = videoFiles.find((item) => {
    if (filenameIndex(item.name, slot === "long" ? "long" : "short") < minimumIndex) return false;
    const job = byDriveId.get(item.id);
    if (!job) return true;
    // Completed, active or uncertain jobs are never selected a second time.
    return !["completed", "uploading", "needs_review"].includes(job.status) && !job.uploadSessionUrl;
  });
  if (!file) {
    return NextResponse.json({ ok: false, exhausted: true, error: "Bu sırada yüklenebilecek yeni ve güvenli bir Drive videosu bulunamadı.", slot, minimumIndex }, { status: 409 });
  }

  const origin = new URL(req.url).origin;
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "";
  const response = await fetch(`${origin}/api/youtube/drive-upload`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mira-key": secret },
    body: JSON.stringify(mode === "immediate"
      ? { confirm: true, fileName: file.name, publishNow: true, disableComment: true }
      : { confirm: true, fileName: file.name, publishAt: publishAt.toISOString(), disableComment: true }),
    cache: "no-store",
    signal: AbortSignal.timeout(260_000),
  });
  const result = await response.json().catch(() => ({ ok: false, error: "drive-upload JSON yanıtı okunamadı." })) as Record<string, unknown>;
  return NextResponse.json({
    ok: response.ok && result.ok === true,
    slot,
    mode,
    fileName: file.name,
    requestedPublishAt: publishAt.toISOString(),
    httpStatus: response.status,
    upload: result,
  }, { status: response.ok ? 200 : response.status });
}
