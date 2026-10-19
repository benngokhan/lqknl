import { NextResponse } from "next/server";
import { isMiraSessionCookie } from "@/lib/mira-auth";
import { addYoutubeComment, hasYoutubeComments, listMyChannelVideos, loadYoutubeTokens, youtubeStatus } from "@/lib/youtube";
import { generateWithFallback } from "@/lib/model-manager";
import { sendTelegramMessage } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request) {
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (secret && req.headers.get("x-mira-key") === secret) return true;
  return isMiraSessionCookie(req.headers.get("cookie"));
}

function commentPrompt(title: string, description: string) {
  return [
    "Videonun başlığı ve açıklamasına göre, kanal sahibinin kendi videosuna yazacağı doğal bir Türkçe YouTube yorumu üret.",
    "Kurallar: yalnızca tek bir yorum döndür; 1-2 kısa cümle olsun; videonun gerçek konusuna değinsin; samimi ve özgün olsun; izleyiciyi doğal biçimde düşünmeye veya görüş paylaşmaya davet edebilir.",
    "Başlık/açıklama yetersizse içerik hakkında gerçek dışı ayrıntı uydurma; genel ama konuya bağlı bir yorum yaz.",
    "Hashtag, tırnak, açıklama veya seçenek listesi ekleme. Yorum reklam, spam veya tekrar eden kalıp gibi görünmesin.",
    "",
    "VİDEO BAŞLIĞI:",
    title.slice(0, 500),
    "",
    "VİDEO AÇIKLAMASI:",
    description.slice(0, 2500) || "(Açıklama yok)",
  ].join("\n");
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "Mira giriş oturumu gerekli." }, { status: 401 });

  let body: { confirm?: boolean; dryRun?: boolean; limit?: number; maxComments?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Geçersiz JSON." }, { status: 400 });
  }

  const dryRun = body.dryRun === true;
  if (!dryRun && body.confirm !== true) {
    return NextResponse.json({ ok: false, error: "Yorum eklemek için confirm:true gönder; önce kontrol etmek için dryRun:true kullan." }, { status: 400 });
  }

  const config = youtubeStatus();
  const tokens = await loadYoutubeTokens().catch(() => null);
  if (!config.configured || (!tokens && !process.env.YOUTUBE_REFRESH_TOKEN)) {
    return NextResponse.json({ ok: false, error: "YouTube OAuth bağlantısı hazır değil.", missingEnv: config.missing }, { status: 503 });
  }

  const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(100, Math.floor(Number(body.limit) || 30))) : 30;
  const maxComments = dryRun ? 0 : (Number.isFinite(Number(body.maxComments)) ? Math.max(1, Math.min(5, Math.floor(Number(body.maxComments) || 3))) : 3);

  try {
    const channel = await listMyChannelVideos(limit);
    const noCommentVideos: Array<{ videoId: string; title: string; url: string; description: string }> = [];
    const skipped: Array<{ videoId: string; title: string; reason: string }> = [];
    let checked = 0;

    // Keep the initial live test intentionally bounded: only public videos, at most 100 inspected.
    for (const video of channel.videos) {
      if (video.privacyStatus !== "public") {
        skipped.push({ videoId: video.videoId, title: video.title, reason: "Herkese açık değil." });
        continue;
      }
      try {
        const hasComments = await hasYoutubeComments(video.videoId);
        checked += 1;
        if (!hasComments) noCommentVideos.push({ videoId: video.videoId, title: video.title, url: video.url, description: video.description });
      } catch (error) {
        skipped.push({ videoId: video.videoId, title: video.title, reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
      }
    }

    const added: Array<{ videoId: string; title: string; url: string; comment: string }> = [];
    const failures: Array<{ videoId: string; title: string; error: string }> = [];

    for (const video of noCommentVideos.slice(0, maxComments)) {
      try {
        const generated = await generateWithFallback({
          system: "You are Mira, a concise Turkish YouTube community engagement writer. Follow the user's request exactly and return only the comment text.",
          history: [],
          message: commentPrompt(video.title, video.description),
        });
        const comment = generated.content.trim().replace(/^["'“”]+|["'“”]+$/g, "").slice(0, 1000);
        if (!comment || comment.length < 8) throw new Error("Mira geçerli bir yorum üretemedi.");
        const result = await addYoutubeComment(video.videoId, comment);
        added.push({ videoId: video.videoId, title: video.title, url: "https://www.youtube.com/watch?v=" + video.videoId, comment });
      } catch (error) {
        failures.push({ videoId: video.videoId, title: video.title, error: error instanceof Error ? error.message.slice(0, 250) : String(error).slice(0, 250) });
      }
    }

    const report = [
      "🔎 Mira YouTube yorum taraması tamamlandı",
      "Kanal: " + channel.channelTitle,
      "İncelenen video: " + channel.videos.length,
      "Yorum durumu okunabilen: " + checked,
      "Yorumsuz herkese açık video: " + noCommentVideos.length,
      dryRun ? "Deneme modu: yorum eklenmedi." : "Eklenen yorum: " + added.length,
      "Atlanan/hata: " + skipped.length + " / " + failures.length,
      ...(added.length ? ["", "Eklenenler:", ...added.map((item) => "• " + item.title + "\n" + item.url + "\nYorum: " + item.comment)] : []),
      ...(failures.length ? ["", "Yorum eklenemeyenler:", ...failures.map((item) => "• " + item.title + ": " + item.error)] : []),
      ...(noCommentVideos.length > maxComments && !dryRun ? ["", "Kalan yorumsuz video: " + (noCommentVideos.length - added.length)] : []),
    ].join("\n");

    const telegramNotification = await sendTelegramMessage(report);
    return NextResponse.json({
      ok: true,
      dryRun,
      channelTitle: channel.channelTitle,
      scanned: channel.videos.length,
      checked,
      noCommentCount: noCommentVideos.length,
      candidates: noCommentVideos.map(({ videoId, title, url }) => ({ videoId, title, url })),
      added,
      skipped,
      failures,
      remainingNoCommentVideos: dryRun ? noCommentVideos.length : Math.max(0, noCommentVideos.length - added.length),
      telegramNotification,
      note: "Yalnızca herkese açık videolar hedeflendi. Her çalıştırmada en fazla 5 yorum eklenebilir.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen YouTube tarama hatası";
    const telegramNotification = await sendTelegramMessage("⚠️ Mira YouTube yorum taraması başarısız.\nHata: " + message.slice(0, 500));
    return NextResponse.json({ ok: false, error: message.slice(0, 600), telegramNotification }, { status: 502 });
  }
}
