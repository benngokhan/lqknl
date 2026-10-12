import { NextResponse } from "next/server";
import { and, desc, eq, like } from "drizzle-orm";
import { db } from "@/db";
import { contentItems, operations, tasks } from "@/db/schema";
import { generateWithFallback } from "@/lib/model-manager";
import { sendTelegramMessage } from "@/lib/telegram";
import { extractNarration } from "@/lib/script-parse";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  return req.headers.get("x-mira-key") === expected;
}

async function loadLatestSignalDirective(): Promise<Record<string, unknown> | null> {
  const [record] = await db.select().from(operations)
    .where(and(eq(operations.action, "channel_signal_directive"), eq(operations.status, "success")))
    .orderBy(desc(operations.id))
    .limit(1);
  const metadata = record?.metadata && typeof record.metadata === "object"
    ? record.metadata as Record<string, unknown> : {};
  const directive = metadata.directive;
  return directive && typeof directive === "object" && !Array.isArray(directive)
    ? directive as Record<string, unknown>
    : null;
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  }

  const requestedId = Number(new URL(req.url).searchParams.get("contentId"));
  const hasId = Number.isInteger(requestedId) && requestedId > 0;
  const candidate = hasId
    ? await db.select().from(contentItems)
        .where(and(eq(contentItems.id, requestedId), eq(contentItems.status, "queued")))
        .limit(1)
    : await db.select().from(contentItems)
        .where(eq(contentItems.status, "queued"))
        .orderBy(contentItems.id)
        .limit(1);

  const item = candidate[0];
  if (!item) {
    return NextResponse.json({ ok: true, processed: false, message: "Kuyrukta içerik yok." });
  }

  // Claim atomically so two scheduled calls cannot process the same item.
  const [claimed] = await db.update(contentItems)
    .set({ status: "processing", updatedAt: new Date() })
    .where(and(eq(contentItems.id, item.id), eq(contentItems.status, "queued")))
    .returning();

  if (!claimed) {
    return NextResponse.json({ ok: true, processed: false, message: "İçerik başka bir işlem tarafından alındı." });
  }

  try {
    const topic = claimed.topic?.trim() || claimed.title;
    let signalDirective: Record<string, unknown> | null = null;
    try {
      signalDirective = await loadLatestSignalDirective();
    } catch (signalError) {
      console.error("[Worker] Kanal sinyal direktifi okunamadı; normal üretim devam edecek:",
        signalError instanceof Error ? signalError.message : String(signalError));
    }
    const result = await generateWithFallback({
      system: [
        "Sen Mira'nın Bilgi Dozu adlı YouTube Shorts kanalı için Türkçe içerik üretim motorusun.",
        "Her taslak yalnızca TEK bir konu ve TEK bir doğrulanabilir ana bilgi içersin. Üçlü liste, günlük hack listesi, gezi turu veya birbirinden bağımsız iddialar üretme.",
        "Video en fazla 30 saniyelik Türkçe Shorts olacak; toplam seslendirme 60-65 kelimeyi geçmesin. İlk 1-2 saniyede güçlü, merak uyandıran ama yanıltmayan bir KANCA/HOOK kullan. Zaman akışı: 0-2 sn kanca, 2-22 sn tek doğrulanabilir bilgi ve bağlam, 22-27 sn şaşırtıcı sonuç, 27-30 sn kısa takip çağrısı.",
        "Her taslak tam 3 ayrı görselden oluşmalı: GÖRSEL 1 (0-3 sn, kancayı destekleyen güçlü açılış), GÖRSEL 2 (3-18 sn, ana bilgiyi gösteren kanıta uygun görüntü), GÖRSEL 3 (18-30 sn, sonucu/ölçeği gösteren kapanış). Her görsel için ayrı, üretime hazır görsel promptu ve ekranda görünecek kısa metin ver. Tek görsel veya tek sahne önerme.",
        "Kullanıcı farklı bir süre veya format vermediyse en fazla 30 saniye, tam 3 görsel ve ilk 1-2 saniyede güçlü hook zorunludur. Konu plaj/gezi ise tek gerçek yer ve somut bilgi anlat; 'sadece yerel halkın bildiği' gibi kanıtsız gizem iddiaları kullanma.",
        "Güvenilir kaynağı gerçekten bilmiyorsan kaynak veya URL uydurma; KAYNAK bölümüne yalnızca 'DOĞRULAMA GEREKLİ' yaz. Doğrulanmamış sayısal değer, rekor, teknik özellik veya kesin iddia ekleme.",
        "Balık kabuğunun ilk telefon olduğu, uzayda çikolatanın yıldız gibi parladığı veya bir köpeğin yedi dil bildiği gibi temelsiz/kanıtsız iddiaları üretme.",
        "Çıktı başlıkları: KANCA, SESLENDİRME, EKRAN METNİ, GÖRSEL TASARIMI, SES VE MÜZİK, KAYNAK, AÇIKLAMA, ETİKETLER.",
        "Görsel formatı: dikey 9:16, 1080x1920, 30 fps; üç ayrı ama görsel olarak tutarlı sinematik görüntü, hafif Ken Burns hareketi; koyu tonlar, üst-alt siyah gradyan; ince gri ilerleme çubuğu ve #D4FF3F neon yeşil vurgu; üst solda 'BİLGİ DOZU', altta marka adı.",
        "Ekran metni kısa, okunaklı ve 2-3 satır olsun; anahtar son ifade neon yeşil vurgulansın. Türkçe doğal ve otoriter ses, kelime kelime senkron altyazı, düşük seviyeli gizemli müzik kullan.",
        "İçeriği yayınlama, video dosyası oluştuğunu iddia etme; yalnızca metin taslağı hazırla. Taslağın onay beklediğini açıkça belirt.",
        ...(signalDirective ? [
          "HAFTALIK KANAL SİNYALİ: aşağıdaki JSON güncel kanal performansından türetilmiştir. Güçlü kümeleri konu seçimi ve çerçevelemede önceliklendir; azalt_durdur kümelerinden yeni konu önermemeye çalış. Klonlanacak videolardan yalnızca kanca yapısını al, metni veya iddiayı kopyalama.",
          JSON.stringify(signalDirective)
        ] : [])
      ].join("\n"),
      history: [],
      message: `Platform: ${claimed.platform}\nKonu: ${topic}\nBaşlık: ${claimed.title}\nEn fazla 30 saniyelik, tek ana bilgili Bilgi Dozu Shorts taslağı üret. İlk 1-2 saniyeye güçlü hook/kanca koy ve tam 3 ayrı görsel için zaman kodlu, ayrı görsel promptları ver. Tüm zorunlu başlıkları doldur. Model hata/ret mesajı yazma; güvenilir kaynak bulamıyorsan iddiayı üretme ve KAYNAK bölümünde DOĞRULAMA GEREKLİ yaz.${signalDirective ? `\nHaftalık kanal sinyal direktifi: ${JSON.stringify(signalDirective)}` : ""}`,
    });

    const generated = result.content.trim();
    const refusalPattern = /üzgünüm[!, ]|bu isteği yerine getiremiyorum|i cannot help|i can.t help with that/i;
    if (refusalPattern.test(generated)) {
      throw new Error("Model içerik yerine ret/hata mesajı döndürdü; taslak kaydedilmedi.");
    }
    const normalized = generated.toLocaleUpperCase("tr-TR");
    const requiredHeadings = ["KANCA", "SESLENDİRME", "EKRAN METNİ", "GÖRSEL TASARIMI", "KAYNAK"];
    const missingHeadings = requiredHeadings.filter((heading) => !normalized.includes(heading));
    if (missingHeadings.length > 0) {
      throw new Error(`Model taslak formatını üretmedi. Eksik başlıklar: ${missingHeadings.join(", ")}; taslak kaydedilmedi.`);
    }

    // SESLENDİRME uzunluk tabanı: 38 kelime altı ≈ 10sn'lik video; bir kez uzatma denemesi.
    let scriptText = generated;
    let scriptProvider = { provider: result.provider, model: result.model };
    let narrationWords = extractNarration(scriptText, scriptText).split(/\s+/).filter(Boolean).length;
    if (narrationWords > 0 && narrationWords < 38) {
      try {
        const lengthen = await generateWithFallback({
          system: [
            "Sen Mira'nın Bilgi Dozu adlı YouTube Shorts kanalı için Türkçe içerik üretim motorusun.",
            "Verilen taslaktaki SESLENDİRME bölümünü 40-48 kelime arasına çıkar: kancayı, konuyu ve tüm başlık yapısını koru; aynı üslupla, konu hakkında 1-2 somut ve doğrulanabilir bilgi ekle.",
            "TASLAKIN TAMAMINI aynı başlıklarla döndür; başlık adları ve diğer bölümler değişmesin; hata/ret açıklaması yazma.",
          ].join("\n"),
          history: [],
          message: `Konu: ${topic}\nTaslak (SESLENDİRME ${narrationWords} kelime — kısa kaldı):\n${scriptText}`,
        });
        const retryText = lengthen.content.trim();
        const retryWords = extractNarration(retryText, retryText).split(/\s+/).filter(Boolean).length;
        const retryMissing = requiredHeadings.filter((h) => !retryText.toLocaleUpperCase("tr-TR").includes(h));
        if (retryMissing.length === 0 && retryWords >= 38 && !refusalPattern.test(retryText)) {
          scriptText = retryText;
          narrationWords = retryWords;
          scriptProvider = { provider: lengthen.provider, model: lengthen.model };
        }
      } catch {
        // Uzatma denemesi patlarsa kısa metinle devam; üretim tarafındaki ağ da var.
      }
    }

    const [savedOperation] = await db.insert(operations).values({
      action: "autonomous_content_draft",
      summary: `Mira otomatik içerik taslağı hazırladı: ${claimed.title}`,
      status: "success",
      platform: claimed.platform,
      metadata: {
        contentId: claimed.id,
        topic,
        title: claimed.title,
        provider: scriptProvider.provider,
        model: scriptProvider.model,
        script: scriptText,
        narrationWords,
        requiresApprovalToPublish: true,
      },
    }).returning();

    const [updated] = await db.update(contentItems)
      .set({ status: "draft", updatedAt: new Date() })
      .where(eq(contentItems.id, claimed.id))
      .returning();

    await db.update(tasks)
      .set({ status: "done", updatedAt: new Date() })
      .where(like(tasks.notes, `%"contentId":${claimed.id}%`));

    // New generated content is screened immediately; only selected drafts should reach the review panel.
    let contentScreening: { ok?: boolean; kept?: number; deleted?: number; error?: string } = {};
    try {
      const origin = new URL(req.url).origin;
      const screening = await fetch(`${origin}/api/automation/analyze-drafts`, {
        method: "POST",
        headers: { "x-mira-key": process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "" },
        cache: "no-store",
        signal: AbortSignal.timeout(55_000),
      });
      const screeningData = await screening.json().catch(() => null);
      contentScreening = screening.ok && screeningData && typeof screeningData === "object"
        ? screeningData as { ok?: boolean; kept?: number; deleted?: number; error?: string }
        : { ok: false, error: screeningData?.error || `Analiz HTTP ${screening.status}` };
    } catch (screeningError) {
      contentScreening = { ok: false, error: screeningError instanceof Error ? screeningError.message : String(screeningError) };
      console.error("[Worker] Otomatik içerik analizi başarısız:", contentScreening.error);
    }

    let telegramNotification: { sent: boolean; error?: string } = { sent: false, error: "Bildirim gönderimi doğrulanamadı." };
    try {
      const telegram = await sendTelegramMessage(
        `🤖 Mira içerik işleme tamamlandı\n\nBaşlık: ${updated.title}\nİçerik ID: ${updated.id}\nModel: ${scriptProvider.provider}/${scriptProvider.model}\nSeslendirme: ${narrationWords} kelime\nAnaliz: ${contentScreening.ok ? `${contentScreening.kept ?? 0} taslak tutuldu, ${contentScreening.deleted ?? 0} içerik silindi.` : `Tamamlanamadı: ${contentScreening.error || "sonuç alınamadı"}`}\nYalnızca seçilen içerikler onay panelinde gösterilir. Otomatik yayın yapılmadı.`
      );
      telegramNotification = telegram.sent
        ? { sent: true }
        : { sent: false, error: telegram.reason === "not_configured" ? "Telegram ayarları eksik." : (telegram.error || "Telegram API gönderimi reddetti.") };
    } catch (telegramError) {
      telegramNotification = { sent: false, error: telegramError instanceof Error ? telegramError.message : String(telegramError) };
    }
    if (!telegramNotification.sent) console.error("[Worker] Telegram success notification failed:", telegramNotification.error);

    // ——— OTOPİLOT: taslak hazırsa kullanıcı tuşunu beklemeden video üretimine gir.
    // Yayın (YouTube yükleme) kapısı açık değildir; video panelde incelenmeyi bekler.
    // MIRA_AUTO_PRODUCE=0 ile tamamen kapatılabilir.
    const autoProduce = process.env.MIRA_AUTO_PRODUCE !== "0";
    const autopilot: Record<string, unknown> = { enabled: autoProduce };
    if (autoProduce) {
      const origin = new URL(req.url).origin;
      const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "";
      try {
        const review = await fetch(`${origin}/api/content/review`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-mira-key": secret },
          body: JSON.stringify({ action: "approve_video", id: updated.id }),
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        autopilot.approveHttp = review.status;
        if (review.ok) {
          // Üretim uzun sürer; yanıtı beklemeden arka planda tetikle.
          fetch(`${origin}/api/automation/produce`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-mira-key": secret },
            body: JSON.stringify({ contentId: updated.id }),
          }).catch((e) => console.error("[Worker] Otopilot üretim tetiklemesi başarısız:", e));
          autopilot.produceTriggered = updated.id;
        }
      } catch (error) {
        autopilot.error = error instanceof Error ? error.message.slice(0, 120) : String(error);
        console.error("[Worker] Otopilot onay adımı başarısız:", autopilot.error);
      }

      // Kuyruk zincirlemesi: sıradaki içerik varsa bir sonraki turu kendini tetikle.
      // MIRA_WORKER_CHAIN_MAX (varsayılan 6) dalga başına zincir derinliğini sınırlar.
      try {
        const body = await req.clone().json().catch(() => ({}));
        const chainDepth = Number(body?.chainDepth) > 0 ? Number(body.chainDepth) : 0;
        const chainMax = Number(process.env.MIRA_WORKER_CHAIN_MAX) > 0 ? Number(process.env.MIRA_WORKER_CHAIN_MAX) : 6;
        const [nextQueued] = await db.select({ id: contentItems.id }).from(contentItems)
          .where(eq(contentItems.status, "queued")).orderBy(contentItems.id).limit(1);
        if (nextQueued && chainDepth + 1 < chainMax) {
          fetch(`${origin}/api/automation/worker`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-mira-key": secret },
            body: JSON.stringify({ chainDepth: chainDepth + 1 }),
          }).catch((e) => console.error("[Worker] Kuyruk zincirlemesi başarısız:", e));
          autopilot.chainedNext = { contentId: nextQueued.id, depth: chainDepth + 1 };
        } else if (nextQueued) {
          autopilot.chainStopped = `zincir derinliği sınırı (${chainMax}) doldu; kalan kuyruk ${[nextQueued.id]}`;
        }
      } catch (error) {
        console.error("[Worker] Zincirleme kontrolü yapılamadı:", error instanceof Error ? error.message : error);
      }
    }

    return NextResponse.json({
      ok: true,
      processed: true,
      notification: telegramNotification,
      autopilot,
      content: updated,
      script: scriptText,
      narrationWords,
      provider: scriptProvider.provider,
      model: scriptProvider.model,
      operationId: savedOperation.id,
      contentScreening,
      published: false,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await db.update(contentItems)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(contentItems.id, claimed.id));
    await db.update(tasks)
      .set({ status: "failed", updatedAt: new Date() })
      .where(like(tasks.notes, `%"contentId":${claimed.id}%`));
    await db.insert(operations).values({
      action: "autonomous_content_draft",
      summary: `Mira otomatik içerik taslağı oluşturamadı: ${claimed.title}`,
      status: "failed",
      platform: claimed.platform,
      metadata: { contentId: claimed.id, error: reason.slice(0, 1500) },
    });
    let telegramNotification: { sent: boolean; error?: string } = { sent: false, error: "Bildirim gönderimi doğrulanamadı." };
    try {
      const telegram = await sendTelegramMessage(
        `❌ Mira işçisi taslak oluşturamadı\n\nBaşlık: ${claimed.title}\nİçerik ID: ${claimed.id}\nHata: ${reason.slice(0, 900)}\n\nGörev kaydı korundu; hata incelenmeli.`
      );
      telegramNotification = telegram.sent
        ? { sent: true }
        : { sent: false, error: telegram.reason === "not_configured" ? "Telegram ayarları eksik." : (telegram.error || "Telegram API gönderimi reddetti.") };
    } catch (telegramError) {
      telegramNotification = { sent: false, error: telegramError instanceof Error ? telegramError.message : String(telegramError) };
    }
    if (!telegramNotification.sent) console.error("[Worker] Telegram failure notification failed:", telegramNotification.error);
    return NextResponse.json({ ok: false, processed: true, error: reason.slice(0, 500), notification: telegramNotification }, { status: 502 });
  }
}
