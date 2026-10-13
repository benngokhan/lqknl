import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { desc, eq, gte, and } from "drizzle-orm";
import { db } from "@/db";
import { contentItems, operations, tasks, trends } from "@/db/schema";
import { isPermanentlyDeletedTopic } from "@/lib/deleted-topics";
import { generateWithFallback } from "@/lib/model-manager";

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

function todayStartInTurkey(now = new Date()) {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return new Date(`${day}T00:00:00+03:00`);
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function tag(item: string, name: string) {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const now = new Date();
  const start = todayStartInTurkey(now);
  const createdToday = await db.select({ id: contentItems.id })
    .from(contentItems)
    .where(gte(contentItems.createdAt, start));
  const dailyTarget = 2;
  const remaining = Math.max(0, dailyTarget - createdToday.length);

  if (remaining === 0) {
    return NextResponse.json({
      ok: true,
      researched: false,
      queued: 0,
      message: `Bugünün ${dailyTarget} içerik kotası dolu.`,
      dailyTarget,
      createdToday: createdToday.length,
    });
  }

  // Kopya koruması 30 güne genişletildi: eskiden yalnızca bugünkü kayıtlara bakılıyordu,
  // bu yüzden aynı konu her gün yeniden "queued" olarak ekleniyor ve panel kopya doluyordu.
  const dupWindow = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const existing = await db.select({ title: contentItems.title, topic: contentItems.topic })
    .from(contentItems)
    .where(gte(contentItems.createdAt, dupWindow));

  const feedResponse = await fetch("https://trends.google.com/trending/rss?geo=TR", {
    headers: { "User-Agent": "MiraContentResearch/1.0" },
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
  });
  if (!feedResponse.ok) {
    throw new Error(`Google Trends RSS HTTP ${feedResponse.status}`);
  }
  const xml = await feedResponse.text();
  const candidates = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]
    .map((match) => ({
      trend: tag(match[1], "title"),
      url: tag(match[1], "link"),
      traffic: tag(match[1], "ht:approx_traffic"),
    }))
    .filter((item) => item.trend)
    .slice(0, 30);

  if (candidates.length === 0) {
    return NextResponse.json({
      ok: false,
      researched: false,
      queued: 0,
      error: "Google Trends kaynağından güncel konu alınamadı; içerik uydurulmadı.",
    }, { status: 502 });
  }

  let signalDirective: Record<string, unknown> | null = null;
  try {
    signalDirective = await loadLatestSignalDirective();
  } catch (signalError) {
    console.error("[Research] Kanal sinyal direktifi okunamadı; temel trend araştırması devam edecek:",
      signalError instanceof Error ? signalError.message : String(signalError));
  }

  // Marka koruması: MIRA_SYSTEM_PROMPT.txt'nin konu kurallarını (tek doğrulanabilir gerçek +
  // kaynak zorunluluğu + kullanılmış-konu yasak listesi) intake prompt'una aynen enjekte et.
  let topicRules = "";
  try {
    topicRules = (await fs.readFile(path.join(process.cwd(), "mira-prompt", "MIRA_TOPIC_RULES.txt"), "utf8")).trim();
  } catch (rulesError) {
    console.error("[Research] MIRA_TOPIC_RULES.txt okunamadı; konu kuralları eksik:",
      rulesError instanceof Error ? rulesError.message : String(rulesError));
  }

  let topicSelectionSpec = "";
  try {
    topicSelectionSpec = (await fs.readFile(path.join(process.cwd(), "mira_konu_secim_spec.md"), "utf8")).trim();
  } catch (specError) {
    console.error("[Research] mira_konu_secim_spec.md okunamadı; seçim güvenlik kuralları eksik:", 
      specError instanceof Error ? specError.message : String(specError));
  }

  const selected = await generateWithFallback({
    system: [
      "Sen Mira'nın Bilgi Dozu kanalı için Türkçe YouTube Shorts konu araştırmacısısın — konu araştırmacısı, haberci DEĞİL.",
      "Yalnızca verilen güncel Google Trends listesini kaynak olarak kullan.",
      ...(topicRules ? [
        "BİLGİ DOZU KONU KURALLARI (mira-prompt/MIRA_TOPIC_RULES.txt, aynen geçerli):",
        topicRules
      ] : []),
      "MARKA KAPSAMI DIŞI (listedeki trend bunlara girse bile ASLA SEÇME): gezi/mekan önerileri (şehir, tatil yeri, plaj...), ürün/marka/şirket tanıtımları, magazin-ünlü dedikodusu, siyaset-parti-hükümet haberciliği, spor transfer skoru vb. genel haberler, algoritma şaşırtmacası bileşimi olmayan düz gündem. Bunlar Bilgi Dozu kümeleri değildir; onlar 'genel trend çöpü'.",
      "KONU SEÇİM SİGORTASI: Canonical spec dosyasını uygula. Hayvan, tarih anekdotu, '3 şaşırtıcı gerçek' listicle ve genel AI/gelecek spekülasyonu seçme. Spec okunamazsa da bu yasaklar geçerlidir; güçlü uygun aday yoksa daha az öğe üret.",
      ...(topicSelectionSpec ? ["CANONICAL KONU SEÇİM SPEC'İ:", topicSelectionSpec] : []),
      "İzlenme potansiyeli ve görsel anlatılabilirlik ikincil filtre; birinci filtre her zaman: Bilgi Dozu kümesi + doğrulanabilir kalıcı bilgi + güçlü 2 saniyelik kanca.",
      "Birbirine benzeyen konuları seçme; listeden ilham alan ama trendmiş gibi sunulmayan, açıkça Shorts bilgi fikri olan başlıklar üret.",
      "Yalnızca geçerli JSON döndür: { \"items\": [{ \"topic\": \"kısa video fikri\", \"title\": \"kısa başlık\", \"sourceTrend\": \"listedeki tam trend\", \"score\": 1-100 }] }",
      `Tam olarak ${remaining} farklı öğe üret. Bir öğeyi güvenilir şekilde oluşturamıyorsan daha az öğe üret; aynı konuyu tekrarlama.`,
      ...(signalDirective ? [
        "HAFTALIK KANAL SİNYALİ: agirlik_artir içindeki kümelere konu seçiminde öncelik ver; azalt_durdur içindeki kümelerden yeni konu seçme. Uygun güçlü konu sayısı azsa zayıf konu veya uydurma trend eklemek yerine daha az öğe döndür. Bu direktif Google Trends listesini geçersiz kılmaz; sourceTrend mutlaka listeden birebir alınmalı.",
        `Güncel sinyal direktifi JSON: ${JSON.stringify(signalDirective)}`
      ] : [])
    ].join("\n"),
    history: [],
    message: `Tarih: ${now.toISOString()}\nBugün daha önce eklenen içerikler: ${JSON.stringify(existing)}\nGüncel Google Trends Türkiye RSS öğeleri: ${JSON.stringify(candidates)}${signalDirective ? `\nHaftalık kanal sinyal direktifi: ${JSON.stringify(signalDirective)}` : ""}`,
  });

  const raw = selected.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: { items?: Array<{ topic?: unknown; title?: unknown; sourceTrend?: unknown; score?: unknown }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Konu seçimi modeli geçerli JSON döndürmedi.");
  }

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const existingKeys = new Set(existing.flatMap((item) => [item.title, item.topic].filter(Boolean).map((v) => String(v).toLocaleLowerCase("tr-TR"))));
  const added: Array<{ id: number; title: string; topic: string }> = [];

  for (const item of items) {
    if (added.length >= remaining) break;
    const topic = typeof item.topic === "string" ? item.topic.trim().slice(0, 500) : "";
    const title = typeof item.title === "string" ? item.title.trim().slice(0, 300) : "";
    const sourceTrend = typeof item.sourceTrend === "string" ? item.sourceTrend.trim() : "";
    if (!topic || !title || !sourceTrend) continue;
    if (await isPermanentlyDeletedTopic(db, [title, topic])) continue;
    const key = title.toLocaleLowerCase("tr-TR");
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    const candidate = candidates.find((entry) => entry.trend.toLocaleLowerCase("tr-TR") === sourceTrend.toLocaleLowerCase("tr-TR"));
    const score = typeof item.score === "number" && Number.isFinite(item.score)
      ? Math.max(1, Math.min(100, item.score))
      : null;

    const [trend] = await db.insert(trends).values({
      topic,
      platform: "youtube",
      sourceUrl: candidate?.url || null,
      score,
      status: "selected",
      notes: `Kaynak trend: ${sourceTrend}; araştırma: Google Trends Türkiye RSS`,
    }).returning();

    const [content] = await db.insert(contentItems).values({
      title,
      platform: "youtube",
      status: "queued",
      topic,
    }).returning();

    const [task] = await db.insert(tasks).values({
      title: `Mira kısa video taslağı hazırla: ${title}`,
      status: "pending",
      source: "mira",
      notes: JSON.stringify({
        type: "content_pipeline",
        contentId: content.id,
        trendId: trend.id,
        platform: "youtube",
        stages: ["research", "script", "voice", "video", "publish", "report"],
      }),
    }).returning();

    await db.insert(operations).values({
      action: "autonomous_topic_research",
      summary: `Mira trend araştırmasıyla konu seçti: ${title}`,
      status: "queued",
      platform: "youtube",
      metadata: {
        contentId: content.id,
        taskId: task.id,
        trendId: trend.id,
        topic,
        sourceTrend,
        score,
        provider: selected.provider,
        model: selected.model,
        signalDirectivePeriod: typeof signalDirective?.donem === "string" ? signalDirective.donem : null,
        requiresApprovalToPublish: true,
      },
    });
    added.push({ id: content.id, title, topic });
  }

  return NextResponse.json({
    ok: true,
    researched: true,
    queued: added.length,
    dailyTarget,
    createdBeforeResearch: createdToday.length,
    items: added,
    provider: selected.provider,
    model: selected.model,
    published: false,
  });
}
