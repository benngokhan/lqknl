import { NextResponse, after } from "next/server";
import { and, desc, eq, like, lt } from "drizzle-orm";
import { db } from "@/db";
import { contentItems, operations, tasks } from "@/db/schema";
import { generateWithFallback } from "@/lib/model-manager";
import { sendTelegramMessage } from "@/lib/telegram";
import { extractNarration, parseDraftScript } from "@/lib/script-parse";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (expected && req.headers.get("x-mira-key") === expected) return true;
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? (!expected && process.env.NODE_ENV !== "production");
}

async function reportScriptProgress(contentId: number, percentage: number, stage: string, status = "running", detail?: string, nextAction?: string) {
  await db.insert(operations).values({
    action: "content_produce_progress", summary: stage, status, platform: "youtube",
    metadata: { contentId, percentage, stage, status, detail, nextAction, updatedAt: new Date().toISOString(), workflow: "manual_script" },
  }).catch((error) => console.error("[Worker] progress write failed:", error instanceof Error ? error.message : String(error)));
}
type FactGateResult = { ok: true; sourceUrls: string[]; reason: string } | { ok: false; sourceUrls: string[]; reason: string };

function isPublicHttpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname.includes(".")) return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return null;
    return url;
  } catch { return null; }
}

async function readPublicSource(raw: string): Promise<{ url: string; text: string }> {
  let current = isPublicHttpsUrl(raw);
  if (!current) throw new Error("Kaynak bağlantısı güvenli bir HTTPS adresi değil.");
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "MiraFactCheck/1.0" },
      cache: "no-store",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || hop === 3) throw new Error("Kaynak yönlendirmesi çözülemedi.");
      const next = isPublicHttpsUrl(new URL(location, current).toString());
      if (!next) throw new Error("Kaynak güvenli bir HTTPS adresine yönlendirmiyor.");
      current = next;
      continue;
    }
    if (!response.ok) throw new Error(`Kaynak bağlantısı HTTP ${response.status} döndürdü.`);
    const type = response.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new Error("Kaynak sayfası okunabilir metin olarak sunulmuyor.");
    const rawText = (await response.text()).slice(0, 250_000);
    const text = rawText
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ").trim();
    if (text.length < 250) throw new Error("Kaynak sayfasında doğrulama için yeterli metin bulunamadı.");
    return { url: current.toString(), text: text.slice(0, 12_000) };
  }
  throw new Error("Kaynak yönlendirmesi çözülemedi.");
}

async function verifyScriptSources(script: string, narration: string): Promise<FactGateResult> {
  const sections = parseDraftScript(script);
  const sourceSection = sections["KAYNAK"]?.trim() || "";
  if (!sourceSection || /DOĞRULAMA\s*GEREKLİ|KAYNAK\s*YOK|BİLİNMİYOR/i.test(sourceSection)) {
    return { ok: false, sourceUrls: [], reason: "Kaynak bölümü açıkça doğrulama gerektiğini belirtiyor veya boş." };
  }
  const candidates = [...sourceSection.matchAll(/https:\/\/[^\s)\]>]+/gi)]
    .map((match) => match[0].replace(/[.,;]+$/, ""))
    .filter((url, index, all) => all.indexOf(url) === index)
    .slice(0, 2);
  if (!candidates.length) return { ok: false, sourceUrls: [], reason: "Kaynak bölümünde kontrol edilebilir HTTPS bağlantısı yok." };
  try {
    const pages = await Promise.all(candidates.map(readPublicSource));
    const evidence = pages.map((page, index) => `KAYNAK ${index + 1}: ${page.url}\n${page.text}`).join("\n\n");
    const check = await generateWithFallback({
      system: [
        "Sen katı bir bilgi doğrulama denetçisisin. Yalnızca verilen kaynak metninde açıkça desteklenen iddiaları kabul et.",
        "Kaynakla çelişen, kaynakta bulunmayan, abartılmış veya kesinliği kanıtlanmamış ana iddia varsa reddet.",
        "Genel konu benzerliği yeterli değildir; seslendirmedeki ana olgular kaynak metniyle doğrudan desteklenmeli.",
        "Yalnızca geçerli JSON döndür: {\"supported\": true veya false, \"reason\": \"kısa Türkçe gerekçe\"}. Emin değilsen supported=false.",
      ].join("\n"),
      history: [],
      message: `VİDEO SESLENDİRMESİ:\n${narration}\n\nKAYNAK SAYFALARINDAN OKUNAN METİN:\n${evidence}`,
    });
    const raw = check.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(raw) as { supported?: unknown; reason?: unknown };
    const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 400) : "Model gerekçe vermedi.";
    if (parsed.supported !== true) return { ok: false, sourceUrls: pages.map((p) => p.url), reason };
    return { ok: true, sourceUrls: pages.map((p) => p.url), reason };
  } catch (error) {
    return { ok: false, sourceUrls: candidates, reason: (error instanceof Error ? error.message : String(error)).slice(0, 400) };
  }
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

/**
 * Ağır senaryo işini (LLM çağrısı + uzatma denemesi + analiz + Telegram + otopilot
 * tetikleme + zincirleme) HTTP yanıtından SONRA çalışan after() görevine taşır.
 * GitHub Actions curl'i 75 saniyede kesiyor, cevap gelmeyince tüm vardiya FAIL olup
 * analiz+üretim zinciri skip ediliyordu. Artık yanıt ~1-3 saniyede döner; iş sunucuda
 * tamamlanır ve durum güncellemesi DB üzerinden görünür.
 * Küçük güvenlik uydusu: 45+ dakika "processing" kalan kalemler stale sayılıp tekrar
 * devreye alınır (yeniden başlatma/deploy sırasında yarım kalan işler için).
 */
export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  }

  // Yanıttan önce gerekli primleri garanti altına al: body + origin (after içinde req güvenli değil).
  const origin = new URL(req.url).origin;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "";

  // Stale reclaim: 45 dk önce claim edilip kilitlenen kalemler tekrar kuyruğa döner.
  const staleThreshold = new Date(Date.now() - 45 * 60 * 1000);
  await db.update(contentItems)
    .set({ status: "queued", updatedAt: new Date() })
    .where(and(eq(contentItems.status, "processing"), lt(contentItems.updatedAt, staleThreshold)));

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

  after(async () => {
    try {
      const topic = claimed.topic?.trim() || claimed.title;
      await reportScriptProgress(claimed.id, 8, "Konu analizi yapılıyor…", "running", "Konu tek bir ana bilgiye indirgeniyor; belirsiz veya çok geniş noktalar ayıklanıyor.", "Uygun kapsam belirlenince senaryo taslağını oluşturacağım.");
      let signalDirective: Record<string, unknown> | null = null;
      try {
        signalDirective = await loadLatestSignalDirective();
      } catch (signalError) {
        console.error("[Worker] Kanal sinyal direktifi okunamadı; normal üretim devam edecek:",
          signalError instanceof Error ? signalError.message : String(signalError));
      }
      await reportScriptProgress(claimed.id, 18, "Senaryo hazırlanıyor…", "running", "Zorunlu bölümler, üç ayrı görsel ve kısa seslendirme hazırlanıyor.", "Taslak biçimini denetleyip eksik bölüm varsa otomatik düzeltmeyi deneyeceğim.");
      const result = await generateWithFallback({
        system: [
          "Sen Mira'nın Bilgi Dozu adlı YouTube Shorts kanalı için Türkçe içerik üretim motorusun.",
          "Her taslak yalnızca TEK bir konu ve TEK bir doğrulanabilir ana bilgi içersin. Üçlü liste, günlük hack listesi, gezi turu veya birbirinden bağımsız iddialar üretme.",
          "Video en fazla 30 saniyelik Türkçe Shorts olacak; toplam seslendirme 60-65 kelimeyi geçmesin. İlk 1-2 saniyede güçlü, merak uyandıran ama yanıltmayan bir KANCA/HOOK kullan. Zaman akışı: 0-2 sn kanca, 2-22 sn tek doğrulanabilir bilgi ve bağlam, 22-27 sn şaşırtıcı sonuç, 27-30 sn kısa takip çağrısı.",
          "Her taslak tam 3 ayrı görselden oluşmalı: GÖRSEL 1 (0-3 sn, kancayı destekleyen güçlü açılış), GÖRSEL 2 (3-18 sn, ana bilgiyi gösteren kanıta uygun görüntü), GÖRSEL 3 (18-30 sn, sonucu/ölçeği gösteren kapanış). Her görsel için ayrı, üretime hazır görsel promptu ve ekranda görünecek kısa metin ver. Tek görsel veya tek sahne önerme.",
          "Kullanıcı yalnızca kısa konu yazmışsa varsayılan format en fazla 30 saniye, tam 3 görsel ve ilk 1-2 saniyede güçlü hook kullanır. Kullanıcı açıkça farklı süre/format belirttiyse onun talimatı önceliklidir (ör. 30-40 saniye).",
          "Kullanıcı girdisi KONU, KANCA, GELİŞME, KAYNAKLAR, BAŞLIK, AÇIKLAMA, ETİKETLER veya FORMAT gibi alanlar içeriyorsa bunu hazır içerik paketi kabul et. Alanları tek tek oku; kullanıcının kancasını, gelişmesini, başlığını, açıklamasını, CTA ve etiketlerini, süre/format talimatlarını koru. Metni genel bir konu başlığına indirgeme, alanları kaybetme veya verilen ayrıntıları baştan uydurarak değiştirme. Gerekirse yalnızca bilimsel doğruluk ve kısa video akışı için gerekli düzenlemeyi yap; önemli değişiklikleri sonuçta belirt.",
          "Kullanıcının KAYNAKLAR bölümünde belirttiği kurumlar veya yayınlar yalnızca araştırma adaylarıdır; ilgili kanıt bulunmadan doğrulanmış gibi sunma. Erişilebilir kaynak metnini kontrol et, her ana iddiayı ayrı değerlendir, desteklenmeyen iddiayı düzelt/yumuşat veya doğrulama gerektiğini açıkça belirt.",
          "Güvenilir kaynağı gerçekten bilmiyorsan kaynak veya URL uydurma; KAYNAK bölümüne yalnızca 'DOĞRULAMA GEREKLİ' yaz. Doğrulanmamış sayısal değer, rekor, teknik özellik veya kesin iddia ekleme.",
          "Balık kabuğunun ilk telefon olduğu, uzayda çikolatanın yıldız gibi parladığı veya bir köpeğin yedi dil bildiği gibi temelsiz/kanıtsız iddiaları üretme.",
          "Çıktı başlıkları: KANCA, SESLENDİRME, EKRAN METNİ, GÖRSEL TASARIMI, SES VE MÜZİK, KAYNAK, AÇIKLAMA, ETİKETLER.",
          "Görsel formatı: dikey 9:16, 1080x1920, 30 fps; üç ayrı ama görsel olarak tutarlı sinematik görüntü, hafif Ken Burns hareketi; koyu tonlar, üst-alt siyah gradyan; ince gri ilerleme çubuğu ve #D4FF3F neon yeşil vurgu; üst solda 'BİLGİ DOZU', altta marka adı.",
          "Ekran metni kısa, okunaklı ve 2-3 satır olsun; anahtar son ifade neon yeşil vurgulansın. Türkçe doğal ve otoriter ses, kelime kelime senkron altyazı, düşük seviyeli gizemli müzik kullan.",
          "Taslağın en sonuna TASARIM başlıklı bölüm ekle; içinde YALNIZCA tek satır JSON olsun: {\"title\":[[\"SATIR1\"],[\"SATIR2\"],[[\"SON SATIR\",\"g\"]]],\"note1\":\"GERÇEK ÖZETİ (CAPS, ≤80 kr)\",\"note2\":\"SOYADI • KAYNAK (YIL)\",\"accents\":[\"k1\",\"k2\",\"k3\"]}. Başlık = içerik başlığının 2-3 satırlık BÜYÜK HARF hâli, son satır \"g\" işaretli (yeşil segment). accents = SESLENDİRME metninde birebir geçen 3-5 vurucu kelime. Kaynak belli değilse note2 olarak 'BİLGİ DOZU EDİTÖR DERLEMESİ (2026)' yaz.",
          "İçeriği yayınlama, video dosyası oluştuğunu iddia etme; yalnızca metin taslağı hazırla. Taslağın onay beklediğini açıkça belirt.",
          ...(signalDirective ? [
            "HAFTALIK KANAL SİNYALİ: aşağıdaki JSON güncel kanal performansından türetilmiştir. Güçlü kümeleri konu seçimi ve çerçevelemede önceliklendir; azalt_durdur kümelerinden yeni konu önermemeye çalış. Klonlanacak videolardan yalnızca kanca yapısını al, metni veya iddiayı kopyalama.",
            JSON.stringify(signalDirective)
          ] : [])
        ].join("\n"),
        history: [],
        message: `Kullanıcının verdiği tam konu girdisi (varsa tüm alanları ve ayrıntıları koru):\n${topic}\n\nKayıt başlığı: ${claimed.title}\nTalimat: Kullanıcının açıkça belirttiği süre, kanca, gelişme, CTA, kaynak adayları, başlık, açıklama ve etiketlere uy. Yalnızca kısa konu girdisiyse varsayılan Bilgi Dozu Shorts formatını kullan. Tam 3 ayrı görsel için zaman kodlu promptlar ver. Kaynak adaylarını gerçekten kontrol et; erişilemeyen veya iddiayı desteklemeyen kaynağı doğrulanmış gösterme. Tüm zorunlu başlıkları doldur. ${signalDirective ? `\nHaftalık kanal sinyal direktifi: ${JSON.stringify(signalDirective)}` : ""}`,
      });

      const generated = result.content.trim();
      const refusalPattern = /üzgünüm[!, ]|bu isteği yerine getiremiyorum|i cannot help|i can.t help with that/i;
      if (refusalPattern.test(generated)) {
        throw new Error("Model içerik yerine ret/hata mesajı döndürdü; taslak kaydedilmedi.");
      }
      const requiredHeadings = ["KANCA", "SESLENDİRME", "EKRAN METNİ", "GÖRSEL TASARIMI", "SES VE MÜZİK", "KAYNAK", "AÇIKLAMA", "ETİKETLER"];
      const findMissingHeadings = (text: string) => {
        const normalized = text.toLocaleUpperCase("tr-TR");
        return requiredHeadings.filter((heading) => !normalized.includes(heading));
      };
      let missingHeadings = findMissingHeadings(generated);
      let scriptText = generated;
      let scriptProvider = { provider: result.provider, model: result.model };

      // Bir başlık eksikse hemen işi düşürme: aynı model zinciriyle tek bir düzeltme denemesi yap.
      if (missingHeadings.length > 0) {
        await reportScriptProgress(claimed.id, 32, `Eksik senaryo bölümleri tamamlanıyor: ${missingHeadings.join(", ")}…`, "running", "İlk taslak zorunlu başlıkların tümünü içermedi; kaydetmeden önce aynı konu ve iddiaları koruyarak biçimi düzeltiyorum.", "Düzeltilmiş taslağı yeniden denetleyeceğim; hâlâ eksikse taslağı hatalı diye işaretleyip kaydetmeyeceğim.");
        const repaired = await generateWithFallback({
          system: [
            "Sen Mira'nın taslak biçimi düzeltme motorusun.",
            "Verilen senaryoyu baştan sona yeniden döndür. Konunun anlamını, doğrulanabilir iddiaları ve mevcut bilgileri koru; yeni doğrulanmamış bilgi veya kaynak uydurma.",
            "Aşağıdaki başlıkların HER BİRİ ayrı bir bölüm başlığı olarak, tam yazımıyla zorunludur: KANCA, SESLENDİRME, EKRAN METNİ, GÖRSEL TASARIMI, SES VE MÜZİK, KAYNAK, AÇIKLAMA, ETİKETLER, TASARIM.",
            "EKRAN METNİ bölümünde ekranda gösterilecek kısa Türkçe metinleri, GÖRSEL TASARIMI bölümünde tam 3 ayrı görsel için zaman kodu ve promptları yaz.",
            "Kaynak güvenilir biçimde bilinmiyorsa KAYNAK bölümüne yalnızca DOĞRULAMA GEREKLİ yaz; URL veya kaynak adı uydurma.",
            "Yalnızca düzeltilmiş tam taslağı döndür; açıklama, özür veya eksik başlık listesi yazma.",
          ].join("\n"),
          history: [],
          message: `Konu: ${topic}\nEksik zorunlu başlıklar: ${missingHeadings.join(", ")}\n\nDüzeltilmesi gereken taslak:\n${generated}`,
        });
        const repairedText = repaired.content.trim();
        const repairedMissing = findMissingHeadings(repairedText);
        if (!refusalPattern.test(repairedText) && repairedMissing.length === 0) {
          scriptText = repairedText;
          scriptProvider = { provider: repaired.provider, model: repaired.model };
          missingHeadings = [];
        } else {
          missingHeadings = repairedMissing.length ? repairedMissing : missingHeadings;
        }
      }
      if (missingHeadings.length > 0) {
        throw new Error(`Model taslak formatını üretemedi. Düzeltme denemesinde eksik başlıklar: ${missingHeadings.join(", ")}; taslak kaydedilmedi.`);
      }

      // SESLENDİRME uzunluk tabanı: 38 kelime altı ≈ 10sn'lik video; bir kez uzatma denemesi.
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

      await reportScriptProgress(claimed.id, 58, "Kaynak araştırılıyor…", "running", "Senaryodaki kaynak bölümünden gerçek HTTPS adresleri çıkarılıp erişilebilirlik kontrolü yapılacak.", "Okunabilen kaynak metnini ana iddialarla karşılaştıracağım.");
      await reportScriptProgress(claimed.id, 68, "Bilgilerin doğruluğu kontrol ediliyor…", "running", "Kaynak sayfasında bulunmayan veya desteklenmeyen iddialar kabul edilmeyecek.", "Sonucu kaydedip senaryoyu onayına sunacağım; doğrulama başarısızsa nedeni açıkça göstereceğim.");
      const rawNarration = extractNarration(scriptText, `${claimed.title}. ${topic}`);
      const factCheck = await verifyScriptSources(scriptText, rawNarration);
      await db.insert(operations).values({
        action: factCheck.ok ? "fact_check_passed" : "fact_check_blocked",
        summary: factCheck.ok ? `Kaynak kontrolü geçti: ${claimed.title}` : `Kaynak/doğruluk kontrolü başarısız: ${claimed.title}`,
        status: factCheck.ok ? "success" : "failed", platform: claimed.platform,
        metadata: { contentId: claimed.id, sourceUrls: factCheck.sourceUrls, reason: factCheck.reason, gate: "source_reachability_and_claim_support", videoCreated: false },
      });
      await reportScriptProgress(claimed.id, 82, "Senaryo ve kaynak analizi tamamlanıyor…", "running", "Senaryo metni, kullanılan model ve kaynak kontrolü sonucu kayıt altına alınıyor.", "Taslağı onay bekleyen duruma getireceğim; bu adım video üretmez veya YouTube’a yüklemez.");
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
          factCheck: { ok: factCheck.ok, sourceUrls: factCheck.sourceUrls, reason: factCheck.reason },
          requiresApprovalToPublish: true,
        },
      }).returning();

      const [updated] = await db.update(contentItems)
        .set({ status: "draft", updatedAt: new Date() })
        .where(eq(contentItems.id, claimed.id))
        .returning();

      await db.update(tasks)
        .set({ status: "done", updatedAt: new Date() })
        .where(like(tasks.notes, `%\"contentId\":${claimed.id}%`));

      // Manual-topic flow must never run destructive batch screening against other drafts.
      let contentScreening: { ok?: boolean; kept?: number; deleted?: number; error?: string } = body.manualTopic === true ? { ok: true, kept: 1, deleted: 0 } : {};
      try {
        if (body.manualTopic !== true) {
        const screening = await fetch(`${origin}/api/automation/analyze-drafts`, {
          method: "POST",
          headers: { "x-mira-key": secret },
          cache: "no-store",
          signal: AbortSignal.timeout(55_000),
        });
        const screeningData = await screening.json().catch(() => null);
        contentScreening = screening.ok && screeningData && typeof screeningData === "object"
          ? screeningData as { ok?: boolean; kept?: number; deleted?: number; error?: string }
          : { ok: false, error: screeningData?.error || `Analiz HTTP ${screening.status}` };
        }
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
      const autoProduce = body.manualProduce === true;
      const autopilot: Record<string, unknown> = { enabled: autoProduce };
      if (autoProduce) {
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

        // Tek bir kullanıcı isteği yalnızca seçilen içeriği işler; kuyruğu zincirleme tüketmez.
      }

      await reportScriptProgress(claimed.id, factCheck.ok ? 100 : 92, factCheck.ok ? "Senaryo hazır — onayını bekliyor." : `Kaynak/doğruluk kontrolü tamamlandı ancak doğrulanamadı: ${factCheck.reason}`, factCheck.ok ? "success" : "failed", factCheck.ok ? "Senaryo kaydedildi ve kaynak kontrolü geçti." : `Taslak kaydedildi; ancak kaynak/doğruluk kontrolü geçmedi. ${factCheck.reason}`, factCheck.ok ? "Senaryoyu inceleyip onaylayabilirsin. Video üretimi ayrı onay gerektirir." : "Kaynağı/iddiaları düzeltip yeniden doğrulama yapmadan video üretimine geçme.");
      console.log(`[Worker] Senaryo tamamlandı (arka plan): #${updated.id} "${updated.title}" — model ${scriptProvider.provider}/${scriptProvider.model}, ${narrationWords} kelime, op #${savedOperation.id}.`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await reportScriptProgress(claimed.id, 0, `İşlem başarısız: ${reason.slice(0, 240)}`, "failed", "İşlem bu aşamada tamamlanamadı; hata kaydı korunuyor.", "Mira hatayı ve eksik koşulu gösterecek. Sorun otomatik düzeltme kapsamındaysa yeniden denenecek; değilse kaynağı veya model çıktısını düzeltmek gerekecek.");
      await db.update(contentItems)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(contentItems.id, claimed.id));
      await db.update(tasks)
        .set({ status: "failed", updatedAt: new Date() })
        .where(like(tasks.notes, `%\"contentId\":${claimed.id}%`));
      await db.insert(operations).values({
        action: "autonomous_content_draft",
        summary: `Mira otomatik içerik taslağı oluşturamadı: ${claimed.title}`,
        status: "failed",
        platform: claimed.platform,
        metadata: { contentId: claimed.id, error: reason.slice(0, 1500) },
      });
      try {
        const telegram = await sendTelegramMessage(
          `❌ Mira işçisi taslak oluşturamadı\n\nBaşlık: ${claimed.title}\nİçerik ID: ${claimed.id}\nHata: ${reason.slice(0, 900)}\n\nGörev kaydı korundu; hata incelenmeli.`
        );
        if (!telegram.sent) console.error("[Worker] Telegram failure notification failed:", telegram.reason === "not_configured" ? "Telegram ayarları yok." : (telegram.error || "Telegram API gönderimi reddetti."));
      } catch (telegramError) {
        console.error("[Worker] Telegram failure notification failed:", telegramError instanceof Error ? telegramError.message : String(telegramError));
      }
      console.error(`[Worker] Arka plan senaryo işi başarısız (#${claimed.id}):`, reason.slice(0, 300));
    }
  });

  return NextResponse.json({
    ok: true,
    processed: true,
    started: true,
    contentId: claimed.id,
    title: claimed.title,
    message: "Senaryo üretimi arka planda başladı; ilerleme DB durumundan görünür (queued → draft).",
  }, { status: 202 });
}
