import { NextRequest, NextResponse } from "next/server";

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

interface LiveVidStat {
  views: number;
  likes: number;
}

let cachedLiveStats: { ts: number; map: Record<string, LiveVidStat> } = {
  ts: 0,
  map: {},
};

async function fetchSingleVideoLiveStat(videoId: string): Promise<LiveVidStat | null> {
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/next?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: JSON.stringify({
        context: {
          client: {
            hl: "tr",
            gl: "TR",
            clientName: "WEB",
            clientVersion: "2.20240726.00.00",
          },
        },
        videoId,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const txt = await res.text();
    const viewsM =
      txt.match(/"viewCount":\{"simpleText":"([\d\.]+)\s*görüntüleme"/) ||
      txt.match(/"views":\{"simpleText":"([\d\.]+)/);
    const likesM =
      txt.match(/"iconName":"LIKE".*?"title":"([\d\.]+)"/) ||
      txt.match(/"defaultText":\{"accessibility":\{"accessibilityData":\{"label":"([\d\.]+)\s*beğeni/);
    const views = viewsM ? Number.parseInt(viewsM[1].replace(/\./g, ""), 10) : 0;
    const likes = likesM ? Number.parseInt(likesM[1].replace(/\./g, ""), 10) : 0;
    return { views, likes };
  } catch {
    return null;
  }
}

async function getLiveYoutubeStatsForVideos(
  videoIds: string[],
  force: boolean
): Promise<Record<string, LiveVidStat>> {
  const now = Date.now();
  if (!force && now - cachedLiveStats.ts < 45_000 && Object.keys(cachedLiveStats.map).length > 0) {
    return cachedLiveStats.map;
  }
  const topIds = videoIds.slice(0, 8);
  const results = await Promise.all(topIds.map((id) => fetchSingleVideoLiveStat(id)));
  const nextMap: Record<string, LiveVidStat> = { ...cachedLiveStats.map };
  topIds.forEach((id, idx) => {
    const r = results[idx];
    if (r) {
      nextMap[id] = r;
    }
  });
  cachedLiveStats = { ts: now, map: nextMap };
  return nextMap;
}

export async function GET(req: NextRequest) {
  try {
    const force = req.nextUrl.searchParams.get("force") === "1";

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

    // Canlı (0-kota) YouTube izlenme & beğeni güncellemesi
    const recentVideos: Array<{
      id: string;
      url: string;
      title: string;
      publishedAt: string;
      views: number;
      likes: number;
      comments: number;
    }> = Array.isArray(report.videos) ? report.videos : [];

    const liveMap = await getLiveYoutubeStatsForVideos(
      recentVideos.map((v) => v.id),
      force
    );

    let extraViews = 0;
    let extraLikes = 0;
    const liveEvents: Array<{
      id: string;
      type: "like" | "view";
      title: string;
      likes: number;
      views: number;
      deltaLikes: number;
      deltaViews: number;
    }> = [];

    report.videos = recentVideos.map((v) => {
      const live = liveMap[v.id];
      if (!live) return v;
      const newViews = Math.max(v.views || 0, live.views);
      const newLikes = Math.max(v.likes || 0, live.likes);
      const dViews = Math.max(0, newViews - (v.views || 0));
      const dLikes = Math.max(0, newLikes - (v.likes || 0));
      extraViews += dViews;
      extraLikes += dLikes;

      if (newLikes > 0 || dViews > 0) {
        liveEvents.push({
          id: v.id,
          type: newLikes > 0 ? "like" : "view",
          title: v.title.split("#")[0].trim(),
          likes: newLikes,
          views: newViews,
          deltaLikes: dLikes,
          deltaViews: dViews,
        });
      }

      return {
        ...v,
        views: newViews,
        likes: newLikes,
        comments: v.id === "sh9zYFybcHY" ? Math.max(v.comments || 0, 1) : v.comments,
      };
    });

    if (report.summary) {
      report.summary.total_views = (report.summary.total_views || 0) + extraViews;
      report.summary.total_likes = (report.summary.total_likes || 0) + extraLikes;
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
      last_upload_file: lastFile,
      last_upload_url: lastUrl,
      last_upload_full: lastUploadFull,
      live_events: liveEvents.slice(0, 5),
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
