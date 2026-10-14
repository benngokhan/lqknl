import { NextResponse, after } from "next/server";
import { selfOrigin } from "@/lib/self-url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, like, lt } from "drizzle-orm";
import { db } from "@/db";
import { logEvent } from "@/lib/logger";
import { contentAssets, contentItems, operations, tasks } from "@/db/schema";
import { isPermanentlyDeletedTopic } from "@/lib/deleted-topics";
import { generateWithFallback } from "@/lib/model-manager";
import { sendTelegramMessage } from "@/lib/telegram";
import { extractNarration, parseDraftScript } from "@/lib/script-parse";
import { normalizeTitleLines } from "@/lib/motor-render";
import { searchAcademicSources } from "@/lib/source-search";

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

async function removePermanentlyDeletedItem(contentId: number, title: string, topic: string) {
  const terms = [...new Set([title, topic].filter((value) => value.trim()))];
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, (character) => `\\${character}`);
  await db.delete(contentAssets).where(eq(contentAssets.contentId, contentId)).catch(() => undefined);
  await db.delete(contentItems).where(eq(contentItems.id, contentId)).catch(() => undefined);
  const allTasks = await db.select().from(tasks).catch(() => []);
  const taskIds = allTasks.filter((task) => {
    const text = `${task.title} ${task.notes || ""}`.toLocaleLowerCase("tr-TR");
    return text.includes(`"contentid":${contentId}`) || terms.some((term) => text.includes(term.toLocaleLowerCase("tr-TR")));
  }).map((task) => task.id);
  if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds)).catch(() => undefined);
  const allOps = await db.select().from(operations).catch(() => []);
  for (const op of allOps) {
    const metadata = op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {};
    if (Number(metadata.contentId) === contentId) {
      await db.delete(operations).where(eq(operations.id, op.id)).catch(() => undefined);
      continue;
    }
    const scrub = (value: unknown): unknown => {
      if (typeof value === "string") {
        let next = value;
        for (const term of [...terms].sort((a, b) => b.length - a.length)) {
          next = next.replace(new RegExp(escapeRegex(term), "giu"), "[kalıcı olarak silindi]");
        }
        return next;
      }
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scrub(item)]));
      return value;
    };
    const summary = scrub(op.summary) as string;
    const nextMetadata = scrub(metadata);
    if (summary !== op.summary || JSON.stringify(nextMetadata) !== JSON.stringify(metadata)) {
      await db.update(operations).set({ summary, metadata: nextMetadata }).where(eq(operations.id, op.id)).catch(() => undefined);
    }
  }
}
type EEngineStats = { openalex: number; crossref: number; pubmed: number };
type FactGateResult = { ok: boolean; sourceUrls: string[]; reason: string; engines?: EEngineStats };

const TRUSTED_SOURCE_DOMAINS = [
  "tmsf.org.tr", "nasa.gov", "nih.gov", "ncbi.nlm.nih.gov", "medlineplus.gov",
  "cdc.gov", "who.int", "nhs.uk", "mayoclinic.org", "clevelandclinic.org",
  "harvard.edu", "harvardhealth.harvard.edu", "stanford.edu", "nature.com",
  "science.org", "scientificamerican.com", "britannica.com", "merckmanuals.com",
  "sleepfoundation.org", "doi.org", "pmc.ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov",
  "sciencedirect.com", "jamanetwork.com", "academic.oup.com", "journals.sagepub.com",
  "frontiersin.org", "plos.org", "pnas.org", "royalsocietypublishing.org",
  "cell.com", "springer.com", "wiley.com", "tandfonline.com", "pubs.acs.org",
  "aps.org", "aip.org",
  // Akademik indeks/varış hostları: DOI'lerin çözüldüğü Türkçe+ulusal portal
  // (dergipark), OpenAlex kayıt sayfası ve yaygın önbaskı/yayın siteleri.
  "openalex.org", "dergipark.org.tr", "arxiv.org", "biorxiv.org", "medrxiv.org",
  "bmj.com", "thelancet.com", "mdpi.com", "hindawi.com", "cambridge.org",
] as const;

function isTrustedSourceUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return TRUSTED_SOURCE_DOMAINS.some((domain) => host === domain || host.endsWith("." + domain)) ||
      /\.edu(?:\.tr)?$/.test(host) || /\.ac\.uk$/.test(host) || /\.gov(?:\.tr)?$/.test(host);
  } catch {
    return false;
  }
}

async function loadArchiveContext(topic: string): Promise<string> {
  const archive = await readFile(path.join(process.cwd(), "konu_arsivi.md"), "utf8").catch(() => "");
  if (!archive) return "";
  const normalize = (value: string) => value.toLocaleLowerCase("tr-TR")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = [...new Set(normalize(topic).split(/\s+/).filter((token) => token.length >= 4))];
  if (!tokens.length) return "";
  const blocks = archive.split(/(?=^## KONU\s+\d+)/m);
  let best = "";
  let bestScore = 0;
  for (const block of blocks) {
    const normalized = normalize(block);
    const score = tokens.reduce((sum, token) => sum + (normalized.includes(token) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = block; }
  }
  return bestScore >= 3 ? best.slice(0, 4200).trim() : "";
}

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

async function verifyScriptSources(contentId: number, script: string, narration: string, topic: string): Promise<FactGateResult> {
  await reportScriptProgress(contentId, 58, "Senaryodaki kaynaklar inceleniyor…", "running", "Taslak içindeki KAYNAK bölümünden HTTPS bağlantıları çıkarılıyor ve güvenilir alan adları denetleniyor.", "Kaynak yoksa otomatik arama başlatacağım.");
  const sections = parseDraftScript(script);
  const sourceSection = sections["KAYNAK"]?.trim() || "";
  let candidates = [...sourceSection.matchAll(/https:\/\/[^\s)\]>]+/gi)]
    .map((match) => match[0].replace(/[.,;]+$/, ""))
    .filter((url, index, all) => all.indexOf(url) === index)
    .filter((url) => isTrustedSourceUrl(url))
    .slice(0, 3);
  let searchedAutomatically = false;
  let searchChannel = "";
  let academicStats: EEngineStats | undefined;
  if (!candidates.length) {
    searchedAutomatically = true;
    await reportScriptProgress(contentId, 60, "Akademik kaynak aranıyor (OpenAlex/Crossref/PubMed)…", "running", "Taslakta doğrulanabilir HTTPS kaynağı bulunmadı; önce anahtarsız akademik indeksleri tarıyorum.", "Akademik bulgu olmazsa DuckDuckGo yedeğine düşeceğim.");
    const academic = await searchAcademicSources(topic, narration).catch((e) => ({ urls: [] as string[], engines: { openalex: 0, crossref: 0, pubmed: 0 }, errors: [e instanceof Error ? e.message.slice(0, 120) : String(e)] }));
    academicStats = academic.engines;
    candidates = academic.urls.filter(isTrustedSourceUrl).slice(0, 3);
    if (candidates.length) {
      searchChannel = `akademik indeksler (openalex:${academic.engines.openalex} crossref:${academic.engines.crossref} pubmed:${academic.engines.pubmed})`;
    }
    if (!candidates.length) {
      const reason = `Kaynak bulunamadı: OpenAlex/Crossref/PubMed sonuç vermedi${academic.errors.length ? ` (motor hataları: ${academic.errors.join(" | ")})` : ""}. DuckDuckGo kullanılmıyor; kaynak uydurulmayacak.`;
      await reportScriptProgress(contentId, 62, "Akademik indekslerde güvenilir kaynak bulunamadı", "failed", reason, "Konuyu kaynak bulunduktan sonra yeniden dene; doğrulanmamış iddia üretme.");
      return { ok: false, sourceUrls: [], reason, engines: academicStats };
    }
  }
  await reportScriptProgress(contentId, 63, "Kaynak bağlantıları bulundu…", "running", `${candidates.length} güvenilir kaynak adayı bulundu: ${candidates.join(" ; ")}`, "Bağlantıları açıp okunabilir kaynak metni olup olmadığını kontrol edeceğim.");
  try {
    // Anchor güveni: aday zaten trust list'ten (örn. doi.org/canonical kayıtlar) seçildi.
    // Varış hostu https+public olduğu sürece REDdetme; varış https/public değilse hata ver.
    // Gerçek kalite kontrolü bir sonraki LLM iddia-karşılaştırmasındadır; host dominosu peşinde koşulmaz.
    const settled = await Promise.allSettled(candidates.map(async (candidateUrl) => {
      const page = await readPublicSource(candidateUrl);
      return { candidateUrl: candidateUrl, page };
    }));
    const resolved = settled
      .filter((r): r is PromiseFulfilledResult<{ candidateUrl: string; page: { url: string; text: string } }> => r.status === "fulfilled")
      .map((r) => r.value);
    if (!resolved.length) {
      const firstRejected = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      const firstError = firstRejected?.reason instanceof Error ? firstRejected.reason.message : String(firstRejected?.reason || "Kaynaklar okunamadı.");
      throw new Error(firstError);
    }
    const pages = resolved.map((r) => r.page);
    const susHost = resolved.find((r) => !isTrustedSourceUrl(r.page.url) && !isPublicHttpsUrl(r.page.url));
    if (susHost) throw new Error("Kaynak sayfası yönlendirmesi güvenli HTTPS/public bir alan adına ulaşamadı (" + susHost.page.url.slice(0, 120) + ").");
    const finalHostName = (u: string) => { try { return new URL(u).hostname; } catch { return "?"; } };
    if (resolved.some((r) => !isTrustedSourceUrl(r.page.url))) {
      console.log("[Worker/verify] Anchor-güveni kabulü: trust-liste dışı varış",
        resolved.map((r) => `${r.candidateUrl.slice(0, 60)} → ${finalHostName(r.page.url)}`).join(" ; "));
    }
    await reportScriptProgress(contentId, 66, "Kaynak sayfaları okundu…", "running", `${pages.length} kaynak sayfası açıldı ve metni alındı; şimdi seslendirmedeki iddialarla karşılaştırılacak.`, "Ana iddiaları yalnızca okunan kaynak metnine göre denetleyeceğim.");
    const evidence = pages.map((page, index) => "KAYNAK " + (index + 1) + ": " + page.url + "\n" + page.text).join("\n\n");
    await reportScriptProgress(contentId, 70, "İddialar kaynaklarla karşılaştırılıyor…", "running", "Seslendirme metni, açılıp okunan kaynak sayfalarının metniyle karşılaştırılıyor; arama sonucu başlığı tek başına kanıt sayılmıyor.", "Karşılaştırma sonucunu ve gerekçesini kaydedeceğim.");
    const check = await generateWithFallback({
      system: [
        "Sen katı bir bilgi doğrulama denetçisisin. Yalnızca verilen kaynak metninde açıkça desteklenen iddiaları kabul et.",
        "Kaynakla çelişen, kaynakta bulunmayan, abartılmış veya kesinliği kanıtlanmamış ana iddia varsa reddet.",
        "Genel konu benzerliği yeterli değildir; seslendirmedeki ana olgular kaynak metniyle doğrudan desteklenmeli.",
        "Arama sonuçlarının başlığı tek başına kanıt değildir; yalnızca aşağıda okunan sayfa metnini değerlendir.",
        "Yalnızca geçerli JSON döndür: {\"supported\": true veya false, \"reason\": \"kısa Türkçe gerekçe\"}. Emin değilsen supported=false.",
      ].join("\n"),
      history: [],
      message: "VİDEO SESLENDİRMESİ:\n" + narration + "\n\nKAYNAK SAYFALARINDAN OKUNAN METİN:\n" + evidence,
    });
    const raw = check.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(raw) as { supported?: unknown; reason?: unknown };
    const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 400) : "Model gerekçe vermedi.";
    const sourceUrls = pages.map((p) => p.url);
    const prefix = searchedAutomatically ? (searchChannel ? `Otomatik arama (${searchChannel}). ` : "Otomatik arama yapıldı. ") : "";
    if (parsed.supported !== true) {
      await reportScriptProgress(contentId, 76, "Kaynak kontrolü başarısız", "failed", `${prefix}${reason} Kaynaklar: ${sourceUrls.join(" ; ")}`, "Desteklenmeyen iddiayı düzeltmeden video üretimine geçme.");
      return { ok: false, sourceUrls, reason: prefix + reason, engines: academicStats };
    }
    await reportScriptProgress(contentId, 76, "Kaynak kontrolü geçti", "running", `${prefix}${reason} Kaynaklar: ${sourceUrls.join(" ; ")}`, "Senaryo ve kaynak kontrolü sonucunu kaydediyorum.");
    return { ok: true, sourceUrls, reason: prefix + reason, engines: academicStats };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 400);
    await reportScriptProgress(contentId, 76, "Kaynak kontrolü tamamlanamadı", "failed", reason, "Kaynak erişimini veya doğrulama modelinin çıktısını kontrol et; sonra aynı içeriği yeniden dene.");
    return { ok: false, sourceUrls: candidates, reason, engines: academicStats };
  }
}


function tgEsc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  const origin = selfOrigin();
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

  const initialTopic = claimed.topic?.trim() || claimed.title;
  if (await isPermanentlyDeletedTopic(db, [claimed.title, initialTopic])) {
    await removePermanentlyDeletedItem(claimed.id, claimed.title, initialTopic);
    return NextResponse.json({ ok: true, processed: false, permanentlyBlocked: true, message: "Bu konu kalıcı silme listesinde; üretim durduruldu." }, { status: 410 });
  }

  after(async () => {
    try {
      const topic = claimed.topic?.trim() || claimed.title;
      const archiveContext = await loadArchiveContext(topic);
      const topicSelectionSpec = await readFile(path.join(process.cwd(), "mira_konu_secim_spec.md"), "utf8").catch(() => "");
      const templateSpec = await readFile(path.join(process.cwd(), "mira-prompt", "BILGI_DOZU_TEMPLATE_SPEC.md"), "utf8").catch(() => "");
      if (!templateSpec.trim()) throw new Error("Sabit Bilgi Dozu şablon spesifikasyonu okunamadı; taslak üretilmedi.");

      await reportScriptProgress(claimed.id, 8, "Konu ve arşiv bağlamı inceleniyor…", "running", archiveContext ? "Konu arşivinde eşleşen bağlam bulundu; bu bilgi taslak istemine eklenecek." : "Konu arşivinde yeterli eşleşme bulunmadı; taslak kullanıcının verdiği konu üzerinden hazırlanacak.", "Kanal yönergesini kontrol edip senaryo modelini çağıracağım.");
      let signalDirective: Record<string, unknown> | null = null;
      try {
        signalDirective = await loadLatestSignalDirective();
      } catch (signalError) {
        console.error("[Worker] Kanal sinyal direktifi okunamadı; normal üretim devam edecek:",
          signalError instanceof Error ? signalError.message : String(signalError));
      }
      await reportScriptProgress(claimed.id, 18, "Senaryo hazırlanıyor…", "running", "Zorunlu bölümler, iki sinematik arka plan ve 35–40 saniyelik seslendirme hazırlanıyor.", "Taslak biçimini ve zorunlu TASARIM bloğunu denetleyeceğim.");
      const result = await generateWithFallback({
        system: [
          "Sen Mira'nın Bilgi Dozu adlı YouTube Shorts kanalı için Türkçe içerik üretim motorusun.",
          "OTOMATİK KONU SEÇİMİNDE mira_konu_secim_spec.md tek otoritedir. Hayvan konuları (ahtapot dahil), tarih anekdotları, '3 şaşırtıcı gerçek' listicle biçimi ve genel AI/gelecek spekülasyonu YASAKTIR. Tek doğrulanabilir ana gerçek seç; önceki kullanılan konuları tekrar etme. Her iddia kaynak doğrulamasından geçmelidir.",
          "Konu kullanıcı tarafından panelden açıkça verilmişse konuyu sessizce başka konuyla değiştirme; ancak tek gerçek, kaynak doğrulama ve kalite kapılarını uygula.",
          ...(topicSelectionSpec.trim() ? [`CANONICAL KONU SEÇİM SPEC'İ (kuralları aynen uygula):\n${topicSelectionSpec}`] : ["Konu seçim spec dosyası okunamadı: otomatik konu önerme; verilen manuel konuyu koru ve kaynak doğrulamasını uygula."]),
          "Her taslak yalnızca TEK bir konu ve TEK bir doğrulanabilir ana bilgi içersin. Üçlü liste, günlük hack listesi, gezi turu veya birbirinden bağımsız iddialar üretme.",
          "Standart video süresi 35–40 saniyedir. SESLENDİRME 70–80 kelime olsun; kanca, 2–3 destek cümlesi, pekiştirme ve sabit CTA 'Daha fazla bilgi dozu için takip etmeyi unutma!' içersin. İlk 2 saniyede güçlü ama yanıltmayan kanca kullan. Sayıları seslendirmede yazıyla yaz.",
          "Her video için tam 2 ayrı görsel promptu üret: GÖRSEL 1 (açılış ve kanca), GÖRSEL 2 (ana bilgiyi ve sonucu gösteren sahne). İkisi de konuya birebir uyan koyu/sinematik dikey 9:16 arka plan olsun; sahne geçişi yaklaşık ortada olsun. Her görsel için üretime hazır prompt ver; görselin içine yazı ekleme.",
          "Kullanıcı yalnızca kısa konu yazmışsa varsayılan format 35–40 saniye, tam 2 görsel ve ilk 2 saniyede güçlü hook kullanır. Kullanıcının açıkça verdiği farklı süre/format talimatı önceliklidir.",
          "Kullanıcı girdisi KONU, KANCA, GELİŞME, KAYNAKLAR, BAŞLIK, AÇIKLAMA, ETİKETLER veya FORMAT gibi alanlar içeriyorsa bunu hazır içerik paketi kabul et. Alanları tek tek oku; kullanıcının kancasını, gelişmesini, başlığını, açıklamasını, CTA ve etiketlerini, süre/format talimatlarını koru. Metni genel bir konu başlığına indirgeme, alanları kaybetme veya verilen ayrıntıları baştan uydurarak değiştirme. Gerekirse yalnızca bilimsel doğruluk ve kısa video akışı için gerekli düzenlemeyi yap; önemli değişiklikleri sonuçta belirt.",
          "Kullanıcının KAYNAKLAR bölümünde belirttiği kurumlar veya yayınlar yalnızca araştırma adaylarıdır; ilgili kanıt bulunmadan doğrulanmış gibi sunma. Erişilebilir kaynak metnini kontrol et, her ana iddiayı ayrı değerlendir, desteklenmeyen iddiayı düzelt/yumuşat veya doğrulama gerektiğini açıkça belirt.",
          "Güvenilir kaynağı gerçekten bilmiyorsan kaynak veya URL uydurma; KAYNAK bölümüne yalnızca 'DOĞRULAMA GEREKLİ' yaz. Doğrulanmamış sayısal değer, rekor, teknik özellik veya kesin iddia ekleme.",
          "Balık kabuğunun ilk telefon olduğu, uzayda çikolatanın yıldız gibi parladığı veya bir köpeğin yedi dil bildiği gibi temelsiz/kanıtsız iddiaları üretme.",
          "Çıktı başlıkları: KANCA, SESLENDİRME, EKRAN METNİ, GÖRSEL TASARIMI, SES VE MÜZİK, KAYNAK, AÇIKLAMA, ETİKETLER, TASARIM.",
          `SABİT GÖRSEL ŞABLON — yerleşim, renk, logo, font ve altyazı stili değiştirilemez; aşağıdaki spesifikasyonu aynen uygula:\n${templateSpec}`,
          "Ekran metni kısa, okunaklı ve 2-3 satır olsun; anahtar son ifade neon yeşil vurgulansın. Türkçe doğal ve otoriter ses, kelime kelime senkron altyazı, düşük seviyeli gizemli müzik kullan.",
          "Taslağın en sonuna TASARIM başlıklı bölüm ekle; içinde YALNIZCA tek satır JSON olsun: {\"title\":[[\"SATIR1\"],[\"SATIR2\"],[[\"SON SATIR\",\"g\"]]],\"note1\":\"GERÇEK ÖZETİ (CAPS, ≤80 kr)\",\"note2\":\"SOYADI • KAYNAK (YIL)\",\"accents\":[\"k1\",\"k2\",\"k3\"]}. Başlık = içerik başlığının 2-3 satırlık BÜYÜK HARF hâli, son satır \"g\" işaretli (yeşil segment). accents = SESLENDİRME metninde birebir geçen 3-5 vurucu kelime. Kaynak belli değilse note2 olarak 'BİLGİ DOZU EDİTÖR DERLEMESİ (2026)' yaz.",
          "İçeriği yayınlama, video dosyası oluştuğunu iddia etme; yalnızca metin taslağı hazırla. Taslağın onay beklediğini açıkça belirt.",
          ...(archiveContext ? [`KONU ARŞİVİNDEN EŞLEŞEN BÖLÜM (aday kaynak/çerçeve; canlı doğrulama yine zorunlu):\n${archiveContext}`] : []),
          ...(signalDirective ? [
            "HAFTALIK KANAL SİNYALİ: aşağıdaki JSON güncel kanal performansından türetilmiştir. Güçlü kümeleri konu seçimi ve çerçevelemede önceliklendir; azalt_durdur kümelerinden yeni konu önermemeye çalış. Klonlanacak videolardan yalnızca kanca yapısını al, metni veya iddiayı kopyalama.",
            JSON.stringify(signalDirective)
          ] : [])
        ].join("\n"),
        history: [],
        message: `Kullanıcının verdiği tam konu girdisi (varsa tüm alanları ve ayrıntıları koru):\n${topic}\n\nKayıt başlığı: ${claimed.title}\nTalimat: Kullanıcının açıkça belirttiği süre, kanca, gelişme, CTA, kaynak adayları, başlık, açıklama ve etiketlere uy. Yalnızca kısa konu girdisiyse varsayılan Bilgi Dozu Shorts formatını kullan. Tam 2 ayrı görsel için zaman kodlu promptlar ver. Kaynak adaylarını gerçekten kontrol et; erişilemeyen veya iddiayı desteklemeyen kaynağı doğrulanmış gösterme. Tüm zorunlu başlıkları doldur. ${signalDirective ? `\nHaftalık kanal sinyal direktifi: ${JSON.stringify(signalDirective)}` : ""}`,
      });

      const generated = result.content.trim();
      await reportScriptProgress(claimed.id, 28, "İlk senaryo taslağı alındı…", "running", `Model yanıt verdi (${result.provider}/${result.model}); çıktı ${generated.length} karakter. Şimdi zorunlu başlıklar ve biçim denetleniyor.`, "Eksik bölüm varsa düzeltme deneyeceğim.");
      const refusalPattern = /üzgünüm[!, ]|bu isteği yerine getiremiyorum|i cannot help|i can.t help with that/i;
      if (refusalPattern.test(generated)) {
        throw new Error("Model içerik yerine ret/hata mesajı döndürdü; taslak kaydedilmedi.");
      }
      const requiredHeadings = ["KANCA", "SESLENDİRME", "EKRAN METNİ", "GÖRSEL TASARIMI", "SES VE MÜZİK", "KAYNAK", "AÇIKLAMA", "ETİKETLER", "TASARIM"];
      const validateTasarimJson = (rawScript: string): boolean => {
        const sec = parseDraftScript(rawScript);
        const raw = sec["TASARIM"]?.trim();
        if (!raw) return false;
        const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(clean) as Record<string, unknown>;
        } catch {
          const f = clean.indexOf("{");
          const l = clean.lastIndexOf("}");
          if (f >= 0 && l > f) {
            try { parsed = JSON.parse(clean.slice(f, l + 1)) as Record<string, unknown>; } catch { return false; }
          }
        }
        if (!parsed || typeof parsed !== "object") return false;
        const titleLines = normalizeTitleLines(parsed.title);
        if (titleLines.length === 0 || !parsed.note1 || !parsed.note2) return false;
        return true;
      };
      const findMissingHeadings = (text: string) => {
        const sec = parseDraftScript(text);
        const missing = requiredHeadings.filter((heading) => !sec[heading as keyof typeof sec]);
        if (!missing.includes("TASARIM") && !validateTasarimJson(text)) {
          missing.push("TASARIM (geçerli JSON ve zorunlu alanlar: title, note1, note2)");
        }
        return missing;
      };
      
      // Otomatik kontroller: Konu sapması, 2 görsel promptu, 70-80 kelime sınırı
      const validateScriptQuality = (script: string, expectedTopic: string): string[] => {
        const issues: string[] = [];
        const sec = parseDraftScript(script);
        
        // 1. İki görsel promptu kontrolü
        const visuals = sec["GÖRSEL TASARIMI"] || "";
        const promptLines = visuals.split(/\n/).map(l => l.trim()).filter(l => l.length > 20);
        const hasGorselTags = /görsel\s*1/i.test(visuals) && /görsel\s*2/i.test(visuals);
        if (!hasGorselTags && promptLines.length < 2) {
          issues.push("GÖRSEL TASARIMI (tam 2 ayrı dikey görsel promptu zorunludur: GÖRSEL 1 ve GÖRSEL 2)");
        }

        // 2. Konu bütünlüğü / Konu sapması kontrolü
        const narration = extractNarration(script, "");
        const cleanTopicWords = expectedTopic.toLocaleLowerCase("tr-TR")
          .replace(/[^a-zçğıöşü0-9\s]/gi, " ")
          .split(/\s+/)
          .filter(w => w.length >= 4);
        const combinedText = (script + " " + narration).toLocaleLowerCase("tr-TR");
        const matchedKeywords = cleanTopicWords.filter(w => combinedText.includes(w));
        if (cleanTopicWords.length > 0 && matchedKeywords.length === 0) {
          issues.push(`Konu bütünlüğü (metin verilen '${expectedTopic.slice(0, 50)}' konusuyla eşleşmiyor, konu sapması engellendi)`);
        }

        return issues;
      };
      let missingHeadings = [...findMissingHeadings(generated), ...validateScriptQuality(generated, topic)];
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
            "EKRAN METNİ bölümünde kısa Türkçe metinleri, GÖRSEL TASARIMI bölümünde tam 2 ayrı görsel promptunu yaz.",
            "TASARIM bölümü en sonda yer almalı ve geçerli tek satır JSON içermelidir. Örnek: {\"title\":[[\"SATIR 1\"],[[\"SON SATIR\",\"g\"]]],\"note1\":\"ÖZET (CAPS)\",\"note2\":\"KAYNAK (YIL)\",\"accents\":[\"kelime1\",\"kelime2\"]}",
            "Kaynak güvenilir biçimde bilinmiyorsa KAYNAK bölümüne yalnızca DOĞRULAMA GEREKLİ yaz; URL veya kaynak adı uydurma.",
            "Yalnızca düzeltilmiş tam taslağı döndür; açıklama, özür veya eksik başlık listesi yazma.",
          ].join("\n"),
          history: [],
          message: `Konu: ${topic}\nEksik zorunlu başlıklar: ${missingHeadings.join(", ")}\n\nDüzeltilmesi gereken taslak:\n${generated}`,
        });
        const repairedText = repaired.content.trim();
        const repairedMissing = [...findMissingHeadings(repairedText), ...validateScriptQuality(repairedText, topic)];
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
      if (narrationWords > 0 && narrationWords < 65) {
        try {
          const lengthen = await generateWithFallback({
            system: [
              "Sen Mira'nın Bilgi Dozu adlı YouTube Shorts kanalı için Türkçe içerik üretim motorusun.",
              "Verilen taslaktaki SESLENDİRME bölümünü 70-80 kelime arasına çıkar: kancayı, konuyu, CTA'yı ve tüm başlık yapısını koru; yalnızca kaynakla doğrulanabilir bilgi ekle.",
              "TASLAKIN TAMAMINI aynı başlıklarla döndür; başlık adları ve diğer bölümler değişmesin; hata/ret açıklaması yazma.",
            ].join("\n"),
            history: [],
            message: `Konu: ${topic}\nTaslak (SESLENDİRME ${narrationWords} kelime — kısa kaldı):\n${scriptText}`,
          });
          const retryText = lengthen.content.trim();
          const retryWords = extractNarration(retryText, retryText).split(/\s+/).filter(Boolean).length;
          const retryMissing = findMissingHeadings(retryText);
          if (retryMissing.length === 0 && retryWords >= 65 && retryWords <= 90 && !refusalPattern.test(retryText)) {
            scriptText = retryText;
            narrationWords = retryWords;
            scriptProvider = { provider: lengthen.provider, model: lengthen.model };
          }
        } catch {
          // Uzatma denemesi patlarsa kısa metinle devam; üretim tarafındaki ağ da var.
        }
      }


      const rawNarration = extractNarration(scriptText, `${claimed.title}. ${topic}`);
      const ctaPattern = /takip\s+etmeyi\s+unutma/i;
      if (!ctaPattern.test(rawNarration)) {
        scriptText = scriptText.replace(
          /(##?\s*SESLENDİRME[\s\S]*?)(\n\s*##?\s*[A-ZÇĞİÖŞÜ ]+|$)/i,
          (m, p1, p2) => `${p1.trim()}\nDaha fazla bilgi dozu için takip etmeyi unutma!\n\n${p2}`
        );
      }
      const rawNarrationFinal = extractNarration(scriptText, `${claimed.title}. ${topic}`);
      await reportScriptProgress(claimed.id, 54, "Senaryo metni çıkarıldı…", "running", `Seslendirme metni ayrıştırıldı; ${rawNarration.split(/\s+/).filter(Boolean).length} kelime bulundu. Kaynak denetimi başlıyor.`, "Kaynak bağlantılarını açıp ana iddiaları karşılaştıracağım.");
      const factCheck = await verifyScriptSources(claimed.id, scriptText, rawNarrationFinal, claimed.title + ". " + topic);
      // Kaynak doğrulaması tüm konular için zorunludur. Manuel konu girişi bu kapıyı atlayamaz.
      // Silme isteği üretim sürerken geldiyse senaryo kaydına yazmadan önce tekrar denetle.
      if (await isPermanentlyDeletedTopic(db, [claimed.title, topic])) {
        await removePermanentlyDeletedItem(claimed.id, claimed.title, topic);
        return;
      }
      const gatePass = factCheck.ok;
      await db.insert(operations).values({
        action: factCheck.ok ? "fact_check_passed" : "fact_check_blocked",
        summary: factCheck.ok ? `Kaynak kontrolü geçti: ${claimed.title}` : `Kaynak/doğruluk kontrolü başarısız: ${claimed.title}`,
        status: factCheck.ok ? "success" : "failed", platform: claimed.platform,
        metadata: { contentId: claimed.id, sourceUrls: factCheck.sourceUrls, reason: factCheck.reason, gate: "source_reachability_and_claim_support", videoCreated: false },
      });
      await logEvent({
        level: factCheck.ok ? "success" : "error",
        source: "worker/gate",
        message: factCheck.ok
          ? `Kaynak kapısını GEÇTİ #${claimed.id} — ${claimed.title}`
          : `Kapı takıldı #${claimed.id} — taslak RED: ${factCheck.reason}`,
        meta: { contentId: claimed.id, manualTopic: body.manualTopic === true, sourceUrls: factCheck.sourceUrls.slice(0, 5), engines: factCheck.engines, reason: factCheck.reason.slice(0, 300) },
      });
      await reportScriptProgress(claimed.id, 82, "Senaryo ve kaynak analizi tamamlanıyor…", "running", "Senaryo metni, kullanılan model ve kaynak kontrolü sonucu kayıt altına alınıyor.", "Kaynak doğrulaması geçerse taslak onaya açılır; geçmezse üretim engellenir.");
      const [savedOperation] = await db.insert(operations).values({
        action: "autonomous_content_draft",
        summary: `Mira otomatik içerik taslağı hazırladı: ${claimed.title}`,
        status: gatePass ? "success" : "failed",
        platform: claimed.platform,
        metadata: {
          contentId: claimed.id,
          topic,
          title: claimed.title,
          provider: scriptProvider.provider,
          model: scriptProvider.model,
          script: scriptText,
          narrationWords,
          factCheck: { ok: factCheck.ok, manualTopic: body.manualTopic === true, sourceUrls: factCheck.sourceUrls, reason: factCheck.reason },
          requiresApprovalToPublish: true,
        },
      }).returning();

      const [updated] = await db.update(contentItems)
        .set({ status: gatePass ? "draft" : "failed", updatedAt: new Date() })
        .where(eq(contentItems.id, claimed.id))
        .returning();

      await db.update(tasks)
        .set({ status: gatePass ? "done" : "failed", updatedAt: new Date() })
        .where(like(tasks.notes, `%\"contentId\":${claimed.id}%`));

      // Manual-topic flow must never run destructive batch screening against other drafts.
      let contentScreening: { ok?: boolean; kept?: number; deleted?: number; error?: string } = !gatePass ? { ok: false, error: "Kaynak doğrulaması başarısız; taslak reddedildi." } : body.manualTopic === true ? { ok: true, kept: 1, deleted: 0 } : {};
      try {
        if (gatePass && body.manualTopic !== true) {
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
        void logEvent({ level: "error", source: "worker/analyze", message: `İçerik analizi başarısız: ${String(contentScreening.error).slice(0, 250)}`, meta: { contentId: claimed.id } });
      }

      let telegramNotification: { sent: boolean; error?: string } = { sent: false, error: "Bildirim gönderimi doğrulanamadı." };
      try {
        const telegram = await sendTelegramMessage(
          [
            `<b>🤖 MİRA | ${gatePass ? "İçerik İşleme Tamamlandı" : "Kaynak Doğrulamayı Geçemedi"}</b>`,
            ``,
            `🎬 <b>Başlık:</b> ${tgEsc(updated.title)}`,
            `🆔 <b>İçerik ID:</b> #${updated.id}`,
            ``,
            factCheck.ok
              ? `📚 <b>Kaynak Kontrolü:</b> ✅ <b>GEÇTİ</b>`
              : `📚 <b>Kaynak Kontrolü:</b> ❌ <b>RED</b>`,
            ...(factCheck.engines
              ? [`<i>OpenAlex: ${factCheck.engines.openalex} | CrossRef: ${factCheck.engines.crossref} | PubMed: ${factCheck.engines.pubmed}</i>`]
              : factCheck.ok && factCheck.sourceUrls.length ? [`<i>Kaynak: taslak URL'si ✓</i>`] : []),
            `&gt; <i>${tgEsc(rawNarration.split(/\s+/).slice(0, 12).join(" ") + "…")}</i>`,
            ...(!factCheck.ok ? [`📝 <i>${tgEsc(factCheck.reason.slice(0, 150))}</i>`] : []),
            ``,
            `🎙️ <b>Seslendirme:</b> ${narrationWords} kelime`,
            `🤖 <b>Model:</b> ${tgEsc(`${scriptProvider.provider}/${scriptProvider.model}`)}`,
            `📊 <b>Durum:</b> ${gatePass
              ? (contentScreening.ok
                  ? `${contentScreening.kept ?? 0} taslak tutuldu <i>(onay bekliyor)</i>${(contentScreening as { archived?: number }).archived ?? contentScreening.deleted ?? 0 ? ` · ${(contentScreening as { archived?: number }).archived ?? contentScreening.deleted ?? 0} arşiv` : ""}`
                  : `Analiz tamamlanamadı <i>(${tgEsc((contentScreening.error || "sonuç yok").slice(0, 80))})</i>`)
              : "Analiz ve üretim yapılmadı"}`,
            ``,
            `📌 <i>Otomatik yayın yapılmadı. İnceleyip onaylayabilirsiniz.</i>`,
          ].join("\n"),
          { parseMode: "HTML" }
        );
        telegramNotification = telegram.sent
          ? { sent: true }
          : { sent: false, error: telegram.reason === "not_configured" ? "Telegram ayarları eksik." : (telegram.error || "Telegram API gönderimi reddetti.") };
      } catch (telegramError) {
        telegramNotification = { sent: false, error: telegramError instanceof Error ? telegramError.message : String(telegramError) };
      }
      if (!telegramNotification.sent) console.error("[Worker] Telegram success notification failed:", telegramNotification.error);
      if (!telegramNotification.sent) void logEvent({ level: "warn", source: "worker/telegram", message: `Bildirim Telegram'a ulaşamadı: ${String(telegramNotification.error).slice(0, 200)}` });

      // ——— OTOPİLOT: taslak hazırsa kullanıcı tuşunu beklemeden video üretimine gir.
      // Yayın (YouTube yükleme) kapısı açık değildir; video panelde incelenmeyi bekler.
      // MIRA_AUTO_PRODUCE=0 ile tamamen kapatılabilir.
      // Üretim pilotu varsayılan-AÇIK (MIRA_AUTO_PRODUCE=0 kapatır). manualProduce=true ek isteği de
      // dürter. Her durumda kaynak doğrulama kapısının geçilmiş olması zorunludur.
      const autoProduce = (process.env.MIRA_AUTO_PRODUCE !== "0" || body.manualProduce === true) && gatePass;
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
            // Üretim uzun sürer ama kör fire-and-forget BIRAKMA: bekle, hata kodunu görünür kıl.
            // Red/502/timeout gibi hallerde produce zaten Telegram atar; burada asıl amaç
            // "hiçbir şey olmadı" (sessiz ağ/early-401/kelime host) vakasını kayıt altına almak.
            autopilot.produceTriggered = updated.id;
            const produceRes = await fetch(`${origin}/api/automation/produce`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-mira-key": secret },
              body: JSON.stringify({ contentId: updated.id }),
              signal: AbortSignal.timeout(480_000),
            }).catch((err) => ({ error: err instanceof Error ? err.message.slice(0, 140) : String(err) } as const));
            if ("error" in produceRes) {
              autopilot.produceHttp = -1;
              console.error("[Worker] Otopilot üretim çağrısı yerine ulaşamadı:", produceRes.error);
              void logEvent({ level: "error", source: "worker/autopilot", message: `Üretim çağrısı yerine varmadı #${updated.id}: ${produceRes.error}`, meta: { contentId: updated.id } });
              await sendTelegramMessage(
                `<b>⚠️ MİRA | Otopilot Üretim Çalıştırılamadı</b>\n\n🆔 <b>İçerik:</b> #${updated.id}\n🔗 <b>Sorun:</b> ${tgEsc(produceRes.error)}\n\nÜretim isteği sunucuya varmadan patladı; paneldeki "Onayla ve video üret" tuşuyla tekrar dene.`,
                { parseMode: "HTML" }
              ).catch(() => {});
            } else {
              autopilot.produceHttp = produceRes.status;
              if (!produceRes.ok) {
                const bodyText = (await produceRes.text().catch(() => "")).slice(0, 180);
                console.error(`[Worker] Otopilot produce HTTP ${produceRes.status}:`, bodyText);
                void logEvent({ level: "error", source: "worker/autopilot", message: `Üretim red verdi #${updated.id}: HTTP ${produceRes.status} — ${bodyText.slice(0, 150)}`, meta: { contentId: updated.id, http: produceRes.status } });
                await sendTelegramMessage(
                  `<b>⚠️ MİRA | Otopilot Üretim Reddedildi</b>\n\n🆔 <b>İçerik:</b> #${updated.id}\n🔗 <b>HTTP:</b> ${produceRes.status}\n📝 ${tgEsc(bodyText || "yanıt yok")}\n\nAyrıntılar paneldeki üretim durumunda görülebilir.`,
                  { parseMode: "HTML" }
                ).catch(() => {});
              }
            }
          }
        } catch (error) {
          autopilot.error = error instanceof Error ? error.message.slice(0, 120) : String(error);
          console.error("[Worker] Otopilot onay adımı başarısız:", autopilot.error);
          void logEvent({ level: "error", source: "worker/autopilot", message: `Onay adımı patladı #${updated.id}: ${String(autopilot.error).slice(0, 200)}`, meta: { contentId: updated.id } });
        }

        // Tek bir kullanıcı isteği yalnızca seçilen içeriği işler; kuyruğu zincirleme tüketmez.
      }

      await reportScriptProgress(claimed.id, gatePass ? 100 : 92,
        gatePass
          ? "Senaryo hazır — onayını bekliyor."
          : `Kaynak/doğruluk kontrolü başarısız; üretim engellendi: ${factCheck.reason}`,
        gatePass ? "success" : "failed",
        gatePass
          ? "Senaryo kaydedildi ve kaynak kontrolü geçti."
          : `Kaynak doğrulanmadığı için taslak reddedildi; video üretimi yapılmadı. ${factCheck.reason}`,
        gatePass ? "Senaryoyu inceleyip onaylayabilirsin." : "Kaynağı/iddiaları düzeltip yeniden doğrulama yapmadan video üretimine geçme.");
      console.log(`[Worker] Senaryo tamamlandı (arka plan): #${updated.id} "${updated.title}" — model ${scriptProvider.provider}/${scriptProvider.model}, ${narrationWords} kelime, op #${savedOperation.id}.`);
      await logEvent({ level: factCheck.ok ? "success" : "error", source: "worker/script", message: `Senaryo işlemi #${updated.id} — "${updated.title}" | kaynak kapısı: ${factCheck.ok ? "GEÇTİ" : "RED"} | ${narrationWords} kelime | @${scriptProvider.provider}`, meta: { contentId: updated.id, operationId: savedOperation.id, manualTopic: body.manualTopic === true } });
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
      await logEvent({ level: "error", source: "worker/script", message: `Senaryo işi patladı #${claimed.id}: ${reason.slice(0, 280)}`, meta: { contentId: claimed.id } });
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
