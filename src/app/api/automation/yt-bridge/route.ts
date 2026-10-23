import { NextResponse } from "next/server";
import { db } from "@/db";
import { operations } from "@/db/schema";
import { isMiraSessionCookie } from "@/lib/mira-auth";
import {
  getLiveAutomationStock,
  normalizeVideoType,
  triggerYoutubeAutoUpload,
  type YoutubeAutoVideoType,
} from "@/lib/yt-auto-bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isAuthorizedPost(req: Request): boolean {
  const automationSecret = (process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "").trim();
  const entryPassword = (process.env.MIRA_ENTRY_PASSWORD || "").trim();

  if (automationSecret) {
    const headerKey = (req.headers.get("x-mira-key") || "").trim();
    if (headerKey && headerKey === automationSecret) return true;

    const authHeader = (req.headers.get("authorization") || "").trim();
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      const bearerToken = authHeader.slice(7).trim();
      if (bearerToken && bearerToken === automationSecret) return true;
    }
  }

  if (isMiraSessionCookie(req.headers.get("cookie"))) {
    return true;
  }

  // Geliştirme ortamında şifre/secret tanımlı değilse geçişe izin ver
  if (!automationSecret && !entryPassword && process.env.NODE_ENV !== "production") {
    return true;
  }

  return false;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "1";
    const stock = await getLiveAutomationStock({ forceRefresh });

    return NextResponse.json(stock, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 320) : "Canlı otomasyon stok verisi okunamadı.";
    return NextResponse.json(
      {
        ok: false,
        error: message,
      },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  if (!isAuthorizedPost(req)) {
    return NextResponse.json(
      { ok: false, error: "Mira oturumu veya otomasyon anahtarı gerekli." },
      { status: 401 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Geçersiz JSON gövdesi." }, { status: 400 });
  }

  const action = String(body.action ?? "").trim().toLowerCase();

  if (action === "stock" || action === "status") {
    try {
      const stock = await getLiveAutomationStock({ forceRefresh: true });
      return NextResponse.json(stock, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 320) : "Canlı stok okunamadı.";
      return NextResponse.json({ ok: false, error: message }, { status: 502 });
    }
  }

  if (action !== "upload_now" && action !== "dry_run") {
    return NextResponse.json(
      {
        ok: false,
        error: 'Geçersiz action. Beklenen: { action: "upload_now", videoType: "short" | "long" | "auto" }.',
      },
      { status: 400 },
    );
  }

  let videoType: YoutubeAutoVideoType;
  try {
    videoType = normalizeVideoType(body.videoType ?? body.video_type ?? "auto");
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Geçersiz videoType ("short" | "long" | "auto").',
      },
      { status: 400 },
    );
  }

  const dryRun = action === "dry_run" ? true : Boolean(body.dryRun ?? body.dry_run ?? false);

  try {
    const result = await triggerYoutubeAutoUpload(videoType, dryRun);

    // Operasyon kaydını veritabanına yaz (DB erişilemezse akışı kesmez)
    try {
      await db.insert(operations).values({
        action: dryRun ? "yt_auto_uploader_dry_run" : "yt_auto_uploader_dispatch",
        summary: result.message.slice(0, 480),
        status: "queued",
        platform: "youtube",
        metadata: {
          repo: result.repo,
          workflow: result.workflow,
          videoType: result.videoType,
          dryRun: result.dryRun,
          targetPreview: result.targetPreview,
        },
      });
    } catch {
      // DB loglama opsiyoneldir
    }

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 360) : "GitHub Actions yükleme tetiklemesi başarısız oldu.";
    const status = /tanımlanmalıdır/i.test(message) ? 503 : 502;
    return NextResponse.json({ ok: false, error: message }, { status: status });
  }
}
