import { NextResponse } from "next/server";
import { isMiraSessionCookie } from "@/lib/mira-auth";
import { generateWithFallback } from "@/lib/model-manager";
import { listMyChannelVideos, loadYoutubeTokens, updateYoutubeVideoTags, youtubeStatus } from "@/lib/youtube";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorized(req: Request) {
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (secret && req.headers.get("x-mira-key") === secret) return true;
  return isMiraSessionCookie(req.headers.get("cookie"));
}

function normalizeTag(tag: string) {
  return tag.normalize("NFKC").toLocaleLowerCase("tr-TR").trim();
}

function diffTags(current: string[], proposed: string[]) {
  const currentSet = new Set(current.map(normalizeTag));
  const proposedSet = new Set(proposed.map(normalizeTag));
  return {
    added: proposed.filter((tag) => !currentSet.has(normalizeTag(tag))),
    removed: current.filter((tag) => !proposedSet.has(normalizeTag(tag))),
  };
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "Mira giriş oturumu gerekli." }, { status: 401 });
  const config = youtubeStatus();
  const tokens = await loadYoutubeTokens().catch(() => null);
  if (!config.configured || (!tokens && !process.env.YOUTUBE_REFRESH_TOKEN)) {
    return NextResponse.json({ ok: false, error: "YouTube bağlantısı yapılandırılmamış.", missingEnv: config.missing }, { status: 503 });
  }
  const requested = Number(new URL(req.url).searchParams.get("limit") || 100);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(500, Math.floor(requested))) : 100;
  try {
    const channel = await listMyChannelVideos(limit);
    return NextResponse.json({
      ok: true,
      channelId: channel.channelId,
      channelTitle: channel.channelTitle,
      count: channel.videos.length,
      videos: channel.videos.map((video) => ({
        videoId: video.videoId,
        title: video.title,
        description: video.description,
        currentTags: video.tags,
        url: video.url,
        publishedAt: video.publishedAt,
        privacyStatus: video.privacyStatus,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen YouTube hatası";
    return NextResponse.json({ ok: false, error: message.slice(0, 500) }, { status: 502 });
  }
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "Mira giriş oturumu gerekli." }, { status: 401 });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";

  const config = youtubeStatus();
  const tokens = await loadYoutubeTokens().catch(() => null);
  if (!config.configured || (!tokens && !process.env.YOUTUBE_REFRESH_TOKEN)) {
    return NextResponse.json({ ok: false, error: "YouTube bağlantısı yapılandırılmamış.", missingEnv: config.missing }, { status: 503 });
  }

  if (action === "analyze") {
    const requested = Number(body.limit || 30);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(40, Math.floor(requested))) : 30;
    try {
      const channel = await listMyChannelVideos(limit);
      const source = channel.videos.map((video) => ({
        videoId: video.videoId,
        title: video.title,
        description: video.description.slice(0, 700),
        currentTags: video.tags,
      }));
      if (!source.length) return NextResponse.json({ ok: true, channelTitle: channel.channelTitle, count: 0, report: [] });

      const result = await generateWithFallback({
        system: "Sen Bilgi Dozu YouTube kanalı için metadata denetçisisin. Yalnızca verilen başlık, açıklama ve mevcut etiketleri kullan. Konuyla doğrudan ilgili, doğru ve doğal Türkçe/ilgili dilde etiketler öner. Uydurma iddia ekleme. En fazla 15 etiket öner; tekrarları ve alakasız/genel etiketleri çıkar. Yalnızca geçerli JSON döndür.",
        history: [],
        message: "Aşağıdaki videoları incele. Her video için yalnızca şu şemada JSON dizisi döndür: [{\"videoId\":\"...\",\"recommendedTags\":[\"...\"],\"reason\":\"kısa gerekçe\"}]. Video kimliklerini aynen koru. Öneriler mevcut etiketlerden daha iyi değilse uygun mevcut etiketleri koru.\n" + JSON.stringify(source),
      });

      const raw = result.content.trim().replace(/^\u0060\u0060\u0060(?:json)?\s*/i, "").replace(/\s*\u0060\u0060\u0060$/, "");
      const parsed = JSON.parse(raw) as Array<{ videoId?: unknown; recommendedTags?: unknown; reason?: unknown }>;
      if (!Array.isArray(parsed)) throw new Error("Model yanıtı JSON dizisi değil.");
      const byId = new Map(channel.videos.map((video) => [video.videoId, video]));
      const report = parsed.flatMap((item) => {
        if (typeof item.videoId !== "string" || !byId.has(item.videoId) || !Array.isArray(item.recommendedTags)) return [];
        const video = byId.get(item.videoId)!;
        const proposed = [...new Set(item.recommendedTags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))].slice(0, 30);
        const diff = diffTags(video.tags, proposed);
        return [{
          videoId: video.videoId,
          title: video.title,
          url: video.url,
          description: video.description,
          currentTags: video.tags,
          recommendedTags: proposed,
          added: diff.added,
          removed: diff.removed,
          reason: typeof item.reason === "string" ? item.reason.slice(0, 500) : "",
        }];
      });
      return NextResponse.json({
        ok: true,
        channelTitle: channel.channelTitle,
        analyzedCount: report.length,
        report,
        model: { provider: result.provider, model: result.model },
        note: "Bu rapor öneridir; YouTube etiketleri değiştirilmedi. Değişiklik için her video için ayrıca action=apply ve confirm=true gerekir.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bilinmeyen analiz hatası";
      return NextResponse.json({ ok: false, error: message.slice(0, 500), updated: false }, { status: 502 });
    }
  }

  if (action === "apply") {
    if (body.confirm !== true) {
      return NextResponse.json({ ok: false, error: "Etiket değişikliği için açık onay gerekli: confirm=true.", updated: false }, { status: 400 });
    }
    const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
    const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : [];
    if (!videoId || tags.length > 30) {
      return NextResponse.json({ ok: false, error: "Geçerli videoId ve en fazla 30 etiket gerekli.", updated: false }, { status: 400 });
    }
    try {
      const result = await updateYoutubeVideoTags(videoId, tags);
      return NextResponse.json({
        ok: true,
        updated: true,
        verified: result.verified,
        videoId: result.videoId,
        tags: result.tags,
        note: "YouTube API üzerinden güncellendi ve yeniden okunarak doğrulandı. Video yükleme, silme, yeniden yayınlama veya gizlilik durumu değiştirilmedi.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bilinmeyen etiket güncelleme hatası";
      return NextResponse.json({ ok: false, updated: false, verified: false, error: message.slice(0, 500) }, { status: 502 });
    }
  }

  return NextResponse.json({ ok: false, error: "action değeri analyze veya apply olmalı." }, { status: 400 });
}
