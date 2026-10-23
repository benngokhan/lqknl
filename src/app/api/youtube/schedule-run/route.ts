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
  const start = Date.UTC(2026, 9, 23);
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
  const requestedFileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  const requestedPublishAt = typeof body.publishAt === "string" ? body.publishAt.trim() : "";
  if ((requestedFileName || requestedPublishAt) && mode !== "scheduled") {
    return NextResponse.json({ ok: false, error: "Belirli dosya ve saat yalnızca scheduled modunda kullanılabilir." }, { status: 400 });
  }
  if ((requestedFileName && !/^video_\d+\.mp4$/i.test(requestedFileName)) || Boolean(requestedFileName) !== Boolean(requestedPublishAt)) {
    return NextResponse.json({ ok: false, error: "Belirli Shorts planı için video_N.mp4 dosya adı ve publishAt birlikte verilmelidir." }, { status: 400 });
  }
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
  } else if (requestedFileName && requestedPublishAt) {
    publishAt = new Date(requestedPublishAt);
    if (!Number.isFinite(publishAt.getTime()) || publishAt.getTime() <= now.getTime() + 60_000) {
      return NextResponse.json({ ok: false, error: "Belirli yayın zamanı geçerli ve en az 1 dakika ileride olmalı.", requestedPublishAt }, { status: 400 });
    }
    date = dateKey(istanbulDateParts(publishAt));
    if (slot === "long") {
      return NextResponse.json({ ok: false, error: "Bu sabit dosya planı yalnızca Shorts içindir." }, { status: 400 });
    }
  } else {
    const today = dateKey(istanbulDateParts(now));
    if (today < "2026-10-23") {
      return NextResponse.json({ ok: true, skipped: true, reason: "Otomasyon başlangıcı 23 Ekim 2026; planlı yayın yapılmadı.", slot, startsOn: "2026-10-23" });
    }
    if (slot === "long" && !isLongVideoDay(today)) {
      return NextResponse.json({ ok: true, skipped: true, reason: "Uzun video yalnızca iki günde bir planlanır.", slot, date: today });
    }
    if (slot === "shorts-afternoon" && isLongVideoDay(today)) {
      return NextResponse.json({ ok: true, skipped: true, reason: "Uzun video günlerinde 16:30 Shorts atlanır; o gün toplam yayın sayısı 3 ile sınırlıdır.", slot, date: today });
    }
    date = today;
    publishAt = localDateTime(date, slotTime(slot, date));
    // GitHub Actions cron gecikmesi (15-45 dk) yüzünden slot atlanmasın:
    // Eğer planlanan saat geçtiyse ama 2 saatlik pencere içindeysek, hemen yayınla (immediate fallback).
    if (publishAt.getTime() <= now.getTime() + 60_000) {
      const delayMs = now.getTime() - publishAt.getTime();
      if (delayMs <= 2 * 3600_000) {
        publishAt = new Date(now.getTime() + 2 * 60_000);
      } else {
        return NextResponse.json({ ok: true, skipped: true, reason: "Bu yayın saati geçti veya çok yakın; yinelenen/geçmiş zamanlı yükleme yapılmadı.", slot, date, publishAt: publishAt.toISOString() });
      }
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
  // Explicit immediate test runs may skip a previously booked slot and select the next
  // numbered Shorts file. This does not re-select video_11 or any uncertain/active job.
  const forceNextImmediate = mode === "immediate" && slot !== "long";
  const slotAlreadyBooked = jobs.find((job) =>
    job.publishAt &&
    Math.abs(job.publishAt.getTime() - publishAt.getTime()) <= targetWindow &&
    ["uploading", "completed", "needs_review"].includes(job.status)
  );
  if (slotAlreadyBooked && !forceNextImmediate) {
    if (requestedFileName && slotAlreadyBooked.driveFileName.toLowerCase() !== requestedFileName.toLowerCase()) {
      return NextResponse.json({
        ok: false, skipped: false, error: "İstenen yayın saatinde farklı bir video kayıtlı; yanlış dosya planlanmaması için işlem durduruldu.",
        slot, requestedFileName, bookedFileName: slotAlreadyBooked.driveFileName,
        publishAt: slotAlreadyBooked.publishAt?.toISOString(),
      }, { status: 409 });
    }
    return NextResponse.json({
      ok: true, skipped: true, reason: "Bu yayın saati için zaten bir Drive yükleme işi kayıtlı; ikinci yükleme engellendi.",
      slot, fileName: slotAlreadyBooked.driveFileName, publishAt: slotAlreadyBooked.publishAt?.toISOString(),
      videoId: slotAlreadyBooked.youtubeVideoId || null,
    });
  }

  const minimumIndex = slot === "long" ? 3 : 20;
  const candidates = videoFiles.filter((item) => {
    const index = filenameIndex(item.name, slot === "long" ? "long" : "short");
    if (requestedFileName && item.name.toLowerCase() !== requestedFileName.toLowerCase()) return false;
    if (index < minimumIndex) return false;
    // During an immediate Shorts test, move past the previously problematic video_11.
    if (forceNextImmediate && item.name.toLowerCase() === "video_11.mp4") return false;
    const job = byDriveId.get(item.id);
    if (!job) return true;
    // Never select completed, active, uncertain, or resumable jobs—even in test mode.
    return !["completed", "uploading", "needs_review"].includes(job.status) && !job.uploadSessionUrl;
  });
  if (!candidates.length) {
    return NextResponse.json({ ok: false, exhausted: true, error: "Bu sırada yüklenebilecek yeni ve güvenli bir Drive videosu bulunamadı.", slot, minimumIndex }, { status: 409 });
  }

  // Dry-run checks Drive/DB candidate selection without uploading or publishing.
  if (body.dryRun === true) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      slot,
      mode,
      candidateCount: candidates.length,
      selectedFileName: candidates[0]?.name || null,
      duplicateSkips: [],
      note: "Drive ve veritabanı seçimi doğrulandı; bu test turunda YouTube yüklemesi yapılmadı.",
    });
  }

  // Internal service-to-self requests must use the local HTTP listener, not Railway public HTTPS.
  const origin = `http://127.0.0.1:${process.env.PORT || "8080"}`;
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "";
  const duplicateSkips: Array<{ fileName: string; reason: string }> = [];
  for (const file of candidates) {
    const response = await fetch(`${origin}/api/youtube/drive-upload`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mira-key": secret },
      body: JSON.stringify(mode === "immediate"
        ? { confirm: true, fileName: file.name, publishNow: true }
        : { confirm: true, fileName: file.name, publishAt: publishAt.toISOString() }),
      cache: "no-store",
      signal: AbortSignal.timeout(260_000),
    });
    const result = await response.json().catch(() => ({ ok: false, error: "drive-upload JSON yanıtı okunamadı." })) as Record<string, unknown>;

    // If this file was already uploaded (including an untracked duplicate title),
    // continue to the next numbered file within the same scheduled run.
    const upload = result.upload && typeof result.upload === "object"
      ? result.upload as Record<string, unknown>
      : result;
    const isDuplicate = upload.alreadyUploaded === true || upload.duplicate === true;
    if (isDuplicate) {
      duplicateSkips.push({ fileName: file.name, reason: String(upload.error || upload.note || "Daha önce kullanılmış; sonraki dosya deneniyor.") });
      continue;
    }

    return NextResponse.json({
      ok: response.ok && result.ok === true,
      slot,
      mode,
      fileName: file.name,
      requestedPublishAt: publishAt.toISOString(),
      httpStatus: response.status,
      upload: result,
      duplicateSkips,
    }, { status: response.ok ? 200 : response.status });
  }

  return NextResponse.json({
    ok: false,
    exhausted: true,
    error: "Bu yayın saatinde sıradaki dosyalar zaten kullanılmış; yeni ve güvenli bir video bulunamadı.",
    slot,
    minimumIndex,
    duplicateSkips,
  }, { status: 409 });
}
