import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function utcToTrTime(utcStr: string): string {
  const m = utcStr.trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return utcStr;
  const dt = new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  if (Number.isNaN(dt.getTime())) return utcStr;
  const tr = new Date(dt.getTime() + 3 * 3600 * 1000);
  const yyyy = tr.getUTCFullYear();
  const mm = String(tr.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(tr.getUTCDate()).padStart(2, "0");
  const hh = String(tr.getUTCHours()).padStart(2, "0");
  const min = String(tr.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd} - ${hh}:${min}`;
}

export async function GET() {
  try {
    const [repRes, upRes] = await Promise.all([
      fetch("https://raw.githubusercontent.com/benngokhan/yt_auto_uploader/main/status_report.json", {
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      }),
      fetch("https://raw.githubusercontent.com/benngokhan/yt_auto_uploader/main/uploaded.txt", {
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      }),
    ]);

    if (!repRes.ok) {
      throw new Error(`status_report.json okunamadı (HTTP ${repRes.status})`);
    }
    const report = await repRes.json();

    let lastTelegramTime = "21:24";
    let lastUploadFull = report.updated_at || "2026.10.23 - 21:24";
    let lastFile = "video_33.mp4";
    let lastUrl = "https://youtu.be/sh9zYFybcHY";

    if (upRes.ok) {
      const upTxt = await upRes.text();
      const lines = upTxt
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && !l.startsWith("LOCKED_") && !l.startsWith("MANUAL_"));
      if (lines.length > 0) {
        const parts = lines[lines.length - 1].split("|").map((p) => p.trim());
        if (parts.length >= 4) {
          lastFile = parts[1] || lastFile;
          lastUrl = parts[2] || lastUrl;
          const rawTs = parts[3] || "";
          const trFormatted = utcToTrTime(rawTs);
          lastUploadFull = trFormatted;
          const hm = trFormatted.split("-")[1]?.trim();
          if (hm) lastTelegramTime = hm;
        }
      }
    }

    if (Array.isArray(report.workers)) {
      report.workers = report.workers.map((w: Record<string, unknown>) => {
        if (w.id === "uploader" || String(w.name || "").includes("Yükleyici")) {
          return {
            ...w,
            updated_at: String(w.updated_at || lastUploadFull).replace(/-/g, "."),
            telegram_last: lastTelegramTime,
            last_action: `${lastFile} yayınlandı (${lastUrl}) · Telegram'a son bildirim: ${lastTelegramTime}`,
          };
        }
        if (w.id === "telegram" || String(w.name || "").includes("Telegram")) {
          return {
            ...w,
            updated_at: String(w.updated_at || lastUploadFull).replace(/-/g, "."),
            telegram_last: lastTelegramTime,
            last_action: `${lastFile} yayın kartı ve sabit yorum gönderildi · Telegram'a son bildirim: ${lastTelegramTime}`,
          };
        }
        return w;
      });
    }

    return NextResponse.json({
      ok: true,
      fetched_at: new Date().toISOString(),
      last_telegram_time: lastTelegramTime,
      report,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Durum verisi alınamadı",
      },
      { status: 502 }
    );
  }
}
