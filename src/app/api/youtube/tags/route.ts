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

      const parsedItems: Array<{ videoId?: unknown; recommendedTags?: unknown; reason?: unknown }> = [];
      let modelInfo: { provider: string; model: string } | undefined;
      // Bazı sağlayıcılar JSON çıktısını kesebiliyor. Video başına kısa, satır tabanlı çıktı kullan.
      for (let offset = 0; offset < source.length; offset += 1) {
        const video = source[offset];
        const prompt = (retry = false) =>
          (retry
            ? "Önceki yanıt ayrıştırılamadı. Yalnızca şu iki satırı üret; JSON, Markdown veya başka açıklama yazma. TAGS satırında en fazla 15 etiket, aralarında | kullan."
            : "Bu videonun mevcut etiketlerini başlık ve açıklamayla karşılaştır; uygun, doğru ve alakalı etiketler öner. Yalnızca şu iki satırı üret; JSON veya Markdown yazma. TAGS satırında en fazla 15 etiket, aralarında | kullan.") +
          "\nTAGS: etiket 1 | etiket 2 | etiket 3\nREASON: kısa gerekçe (en fazla 120 karakter)\n\nVIDEO:\n" +
          JSON.stringify(video);
        let parsedItem: { videoId: string; recommendedTags: string[]; reason: string } | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await generateWithFallback({
            system: "Sen Bilgi Dozu YouTube kanalı için metadata denetçisisin. Yalnızca verilen başlık, açıklama ve mevcut etiketleri kullan. Konuyla doğrudan ilgili, doğru ve doğal Türkçe/ilgili dilde en fazla 15 etiket öner. Uydurma iddia ekleme. Çıktı biçimi kesinlikle iki düz metin satırıdır: TAGS: etiket1 | etiket2 ve REASON: kısa gerekçe. JSON döndürme.",
            history: [],
            message: prompt(attempt > 0),
          });
          modelInfo = { provider: result.provider, model: result.model };
          const raw = result.content.trim()
            .replace(/^```(?:text|json)?\s*/i, "")
            .replace(/\s*```$/, "");
          try {
            // Eski sağlayıcı JSON döndürürse uyumluluk için kabul et.
            let tags: string[] = [];
            let reason = "";
            try {
              const json = JSON.parse(raw);
              const item = Array.isArray(json) ? json[0] : json;
              if (item && Array.isArray(item.recommendedTags)) {
                tags = item.recommendedTags.filter((tag: unknown): tag is string => typeof tag === "string");
                reason = typeof item.reason === "string" ? item.reason : "";
              }
            } catch {
              const tagsLine = raw.match(/^\s*TAGS\s*:\s*(.+)$/im)?.[1]?.trim();
              reason = raw.match(/^\s*REASON\s*:\s*(.+)$/im)?.[1]?.trim() || "";
              if (tagsLine) tags = tagsLine.split("|").map((tag) => tag.trim()).filter(Boolean);
            }
            if (!tags.length) throw new Error("Etiket satırı boş veya biçimi geçersiz.");
            parsedItem = { videoId: video.videoId, recommendedTags: [...new Set(tags)].slice(0, 15), reason: reason.slice(0, 120) };
            break;
          } catch {
            // Bir kez daha kısa ve katı çıktı biçimiyle dene.
          }
        }
        if (!parsedItem) {
          throw new Error(`Model geçerli etiket çıktısı üretemedi (video ${offset + 1}: ${video.title.slice(0, 100)}). Etiketler değiştirilmedi.`);
        }
        parsedItems.push(parsedItem);
      }
      const parsed = parsedItems;
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
        model: modelInfo ?? null,
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
