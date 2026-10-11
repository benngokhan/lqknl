import { think } from '../../../lib/brain';
import { db } from '@/db';
import { contentItems, messages, memories, operations } from '@/db/schema';
import { desc, eq, ilike, sql } from 'drizzle-orm';
import { formatMemoriesForContext, getRelevantMemories, generateForgetApprovalMessage, generateSaveApprovalMessage, parseConfirmationResponse, parseMemoryCommand } from '@/lib/memory-chat';
import { remember } from '@/lib/memory';
import { NextResponse } from 'next/server';
import { sendTelegramMessage } from '@/lib/telegram';

const PRIVATE_MODE_COOKIE = 'mira_private_mode';
const ENTRY_COOKIE = 'mira_entry';

const EXTERNAL_TIMEOUT_MS = 8000;
const VIDEO_TIMEOUT_MS = 180000;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}) {
  return fetchWithTimeoutMs(input, init, EXTERNAL_TIMEOUT_MS);
}

async function fetchWithTimeoutMs(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = EXTERNAL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request) {
  try {
    if (!process.env.MIRA_ENTRY_PASSWORD?.trim()) {
      return NextResponse.json({ error: 'Mira giriş şifresi yapılandırılmamış.' }, { status: 503 });
    }
    const cookieHeader = req.headers.get('cookie') ?? '';
    const authenticated = cookieHeader.split(';').some((part) => part.trim() === `${ENTRY_COOKIE}=1`);
    if (!authenticated) {
      return NextResponse.json({ error: 'Mira oturumu doğrulanmadı.' }, { status: 401 });
    }
    const { message } = await req.json();

    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'Geçersiz mesaj' }, { status: 400 });
    }

    // Yardım ve sistem komutları
    const command = message.trim().split(/\s+/)[0].toLocaleLowerCase('tr-TR');

    // Hafıza onay akışı: bekleyen kayıt/silme işlemleri yalnızca açık onayla uygulanır.
    // A broken/missing operations table must not take ordinary chat offline.
    // Approval commands still require the database and will report their own failure.
    let pendingOp: typeof operations.$inferSelect | undefined;
    try {
      const pending = await db.select().from(operations).where(eq(operations.status, 'pending')).orderBy(desc(operations.id)).limit(1);
      pendingOp = pending[0];
    } catch (operationsError) {
      console.error('Mira operations table query failed; continuing without pending approval:', operationsError);
      pendingOp = undefined;
    }
    const confirmationCandidate = message.trim().toLocaleLowerCase('tr-TR');
    const isExplicitConfirmation = /^(?:evet,?\s*(?:hatırla|sil)|yes,?\s*(?:remember|delete)|onayla,?\s*(?:hatırla|sil)|hayır|hayir|hayır,?\s*(?:sakın|sakin|tut)|hayir,?\s*(?:sakin|tut)|no|nope|non|refuse|reddet|iptal|cancel)!?$/iu.test(confirmationCandidate);
    const confirmation = isExplicitConfirmation ? parseConfirmationResponse(message) : null;

    if (pendingOp?.action === 'memory_save_pending' && confirmation === 'approve') {
      const metadata = pendingOp.metadata && typeof pendingOp.metadata === 'object' ? pendingOp.metadata as Record<string, unknown> : {};
      const text = typeof metadata.text === 'string' ? metadata.text : '';
      const category = typeof metadata.category === 'string' ? metadata.category : 'general';
      const importance = typeof metadata.importance === 'number' ? metadata.importance : 3;
      if (!text) return NextResponse.json({ reply: 'Bekleyen hafıza kaydı geçersiz.', emotion: 'focused' }, { status: 500 });
      try {
        const row = await remember('memory:' + Date.now(), text, category, importance);
        await db.update(operations).set({ status: 'success', summary: 'Hafıza kaydedildi: ' + row.key }).where(eq(operations.id, pendingOp.id));
        return NextResponse.json({ reply: '✅ Tamam. Hafızaya kaydettim: "' + row.value + '"\nKategori: ' + row.category + ' · Önem: ' + row.importance + '/5', emotion: 'focused' });
      } catch (error) {
        console.error('Mira memory save failed:', error);
        return NextResponse.json({ reply: '❌ Hafızaya kaydetme başarısız oldu; kayıt tamamlanmadı.', emotion: 'focused' }, { status: 500 });
      }
    }

    if (pendingOp?.action === 'memory_save_pending' && confirmation === 'reject') {
      await db.update(operations).set({ status: 'cancelled', summary: 'Hafıza kaydı kullanıcı tarafından iptal edildi.' }).where(eq(operations.id, pendingOp.id));
      return NextResponse.json({ reply: 'İptal edildi. Bu bilgi hafızaya kaydedilmedi.', emotion: 'focused' });
    }

    if (pendingOp?.action === 'memory_forget_pending' && confirmation === 'approve') {
      const metadata = pendingOp.metadata && typeof pendingOp.metadata === 'object' ? pendingOp.metadata as Record<string, unknown> : {};
      const memoryId = typeof metadata.memoryId === 'number' ? metadata.memoryId : null;
      if (!memoryId) return NextResponse.json({ reply: 'Bekleyen silme işlemi geçersiz.', emotion: 'focused' }, { status: 500 });
      const [row] = await db.delete(memories).where(eq(memories.id, memoryId)).returning();
      await db.update(operations).set({ status: row ? 'success' : 'cancelled', summary: row ? 'Hafıza silindi: ' + row.key : 'Hafıza zaten bulunamadı.' }).where(eq(operations.id, pendingOp.id));
      return NextResponse.json({ reply: row ? '🗑️ Tamam. Hafızadan sildim: "' + row.value + '"' : 'Bu hafıza zaten mevcut değil.', emotion: 'focused' });
    }

    if (pendingOp?.action === 'memory_forget_pending' && confirmation === 'reject') {
      await db.update(operations).set({ status: 'cancelled', summary: 'Hafıza silme kullanıcı tarafından iptal edildi.' }).where(eq(operations.id, pendingOp.id));
      return NextResponse.json({ reply: 'İptal edildi. Hafıza saklı tutuldu.', emotion: 'focused' });
    }

    const memoryCommand = parseMemoryCommand(message);
    if (memoryCommand.type === 'save') {
      if (memoryCommand.hasSensitiveData) return NextResponse.json({ reply: generateSaveApprovalMessage(memoryCommand), emotion: 'focused' });
      await db.insert(operations).values({ action: 'memory_save_pending', status: 'pending', summary: 'Kullanıcı onayı bekleniyor: hafıza kaydı', metadata: { text: memoryCommand.text, category: memoryCommand.category, importance: memoryCommand.importance } });
      return NextResponse.json({ reply: generateSaveApprovalMessage(memoryCommand), emotion: 'focused' });
    }

    if (memoryCommand.type === 'forget') {
      const matches = await db.select({ id: memories.id, key: memories.key }).from(memories).where(ilike(memories.value, '%' + memoryCommand.text + '%')).limit(1);
      if (matches.length === 0) return NextResponse.json({ reply: 'ℹ️ Bu hafızayı kayıtlarda bulamadım: "' + memoryCommand.text + '"', emotion: 'focused' });
      const approval = await generateForgetApprovalMessage(memoryCommand.text);
      await db.insert(operations).values({ action: 'memory_forget_pending', status: 'pending', summary: 'Kullanıcı onayı bekleniyor: hafıza silme', metadata: { memoryId: matches[0].id, key: matches[0].key } });
      return NextResponse.json({ reply: approval, emotion: 'focused' });
    }

    if (memoryCommand.type === 'query') {
      const all = await db.select().from(memories).orderBy(desc(memories.importance), desc(memories.updatedAt)).limit(20);
      return NextResponse.json({ reply: all.length ? formatMemoriesForContext(all) : 'Henüz kayıtlı hafıza yok.', emotion: 'focused' });
    }

    if (command === '/yardım' || command === '/komutlar' || command === '/help') {
      return NextResponse.json({
        reply: [
          'Komutlarım:',
          '',
          '/yardım — Bu komut listesini gösterir.',
          '/durum — Mira backend ve veritabanı sağlık durumunu kontrol eder.',
          '/taslak <id> — Kayıtlı içerik taslağının tam metnini gösterir.',
          '/n8n — n8n bağlantı durumunu kontrol eder.',
          '/yt-viral <konu> — YouTube Shorts otomasyonunu başlatır.',
          '/oku <dosya> — GitHub reposundaki dosyayı okur.',
        ].join('\\n'),
        emotion: 'focused',
      });
    }

    if (command === '/durum') {
      try {
        await db.execute(sql`select 1`);
        return NextResponse.json({
          reply: 'Sistem ayakta. Backend: aktif. Veritabanı: bağlı ve doğrulandı.',
          emotion: 'focused',
        });
      } catch (error) {
        console.error('Mira /durum database health check failed:', error);
        return NextResponse.json({
          reply: 'Backend aktif, ancak veritabanı bağlantısı şu anda doğrulanamadı.',
          emotion: 'focused',
        });
      }
    }

    // Private playful mode trigger. This changes Mira's conversational style only;
    // it does not disable safety or authorization checks.
    const normalizePrivatePhrase = (value: string) =>
      value.trim().normalize('NFKC').toLocaleLowerCase('tr-TR').replace(/[ıi]/g, 'i');
    // KIRMIZI2206 works even if the Railway phrase variable is not configured.
    // Normalize dotted/dotless Turkish I so KIRMIZI2206 and KİRMIZI2206 both match.
    const privatePhrase = process.env.MIRA_PRIVATE_PHRASE?.trim() || 'KIRMIZI2206';
    const requestedPrivateMode = normalizePrivatePhrase(message) === normalizePrivatePhrase(privatePhrase);
    const storedPrivateMode = cookieHeader.split(';').some((part) => part.trim() === `${PRIVATE_MODE_COOKIE}=1`);
    const privateMode = requestedPrivateMode || storedPrivateMode;
    if (requestedPrivateMode) {
      const response = NextResponse.json({
        reply: '😈 Özel Mira modu açıldı. Konuşma boyunca daha yaramaz ve flörtöz olacağım; güvenlik kuralları değişmedi, patron.',
        emotion: 'playful',
        privateMode: true,
      });
      response.cookies.set(PRIVATE_MODE_COOKIE, '1', { httpOnly: true, sameSite: 'lax', path: '/' });
      return response;
    }

    // Mira -> n8n AI Agent
    if (command === '/n8n-ajan') {
      const instruction = message.trim().replace(/^\/n8n-ajan\s*/i, '').trim();
      const agentWebhookUrl = process.env.N8N_AGENT_WEBHOOK_URL?.trim();

      if (!instruction) {
        return NextResponse.json({
          reply: 'n8n Agent’a göndereceğim emri yazmalısın. Örnek: /n8n-ajan Antarktika hakkında bir Shorts videosu hazırla.',
          emotion: 'focused',
        });
      }

      if (!agentWebhookUrl) {
        return NextResponse.json({
          reply: 'n8n Agent webhook adresi henüz yapılandırılmadı. N8N_AGENT_WEBHOOK_URL gerekli.',
          emotion: 'focused',
        });
      }

      try {
        const response = await fetchWithTimeout(agentWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            instruction,
            source: 'Mira',
            timestamp: new Date().toISOString(),
          }),
        });

        const raw = await response.text();
        let data: unknown = raw;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {}

        if (!response.ok) {
          return NextResponse.json({
            reply: `❌ n8n Agent emri kabul etmedi. HTTP ${response.status}.`,
            emotion: 'focused',
          });
        }

        const agentReply =
          data && typeof data === 'object' && 'reply' in data && typeof data.reply === 'string'
            ? data.reply
            : raw || 'n8n Agent emri aldı; Agent sonucu henüz döndürmedi.';

        return NextResponse.json({
          reply: `🤖 n8n Agent’a emir gönderildi ve HTTP yanıtı doğrulandı.\n\n${agentReply}`,
          emotion: 'focused',
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return NextResponse.json({
          reply: `❌ n8n Agent bağlantısı başarısız: ${reason.slice(0, 300)}`,
          emotion: 'focused',
        });
      }
    }

    // /taslak <id>: Read the exact saved draft from the database without changing it.
    if (command === '/taslak') {
      const idText = message.trim().split(/\s+/)[1];
      const id = Number(idText);
      if (!idText || !Number.isInteger(id) || id <= 0) {
        return NextResponse.json({
          reply: 'Kullanım: /taslak 6 — Görmek istediğin taslak numarasını yaz.',
          emotion: 'focused',
        });
      }

      try {
        const [content] = await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
        if (!content) {
          return NextResponse.json({ reply: `❌ ID ${id} numaralı taslak veritabanında bulunamadı.`, emotion: 'focused' });
        }

        const draftOperations = await db.select().from(operations)
          .where(eq(operations.action, 'autonomous_content_draft'))
          .orderBy(desc(operations.id))
          .limit(500);
        const draftOperation = draftOperations.find((operation) => {
          const metadata = operation.metadata && typeof operation.metadata === 'object'
            ? operation.metadata as Record<string, unknown>
            : {};
          return Number(metadata.contentId) === id && typeof metadata.script === 'string';
        });
        const metadata = draftOperation?.metadata && typeof draftOperation.metadata === 'object'
          ? draftOperation.metadata as Record<string, unknown>
          : {};
        const script = typeof metadata.script === 'string' ? metadata.script : '';

        if (!script) {
          return NextResponse.json({
            reply: `⚠️ ID ${id} (${content.title}) bulundu; ancak kayıtlı senaryo metni bulunamadı. Taslak değiştirilmedi.`,
            emotion: 'focused',
          });
        }

        const extraFields: Array<[string, string]> = [
          ['Görsel komutları', 'imagePrompts'],
          ['Görsel komutu', 'visualPrompt'],
          ['Seslendirme metni', 'voiceover'],
          ['Süre', 'duration'],
          ['Kaynaklar', 'sources'],
          ['Kaynak bağlantıları', 'sourceUrls'],
        ];
        const extras = extraFields
          .filter(([, key]) => metadata[key] !== undefined && metadata[key] !== null)
          .map(([label, key]) => `${label}: ${typeof metadata[key] === 'string' ? metadata[key] : JSON.stringify(metadata[key])}`);

        return NextResponse.json({
          reply: [
            `📄 Kayıtlı taslak #${content.id}: ${content.title}`,
            `Durum: ${content.status}`,
            '',
            'KAYITLI SENARYO (aynen):',
            script,
            ...(extras.length ? ['', ...extras] : []),
            '',
            'Bilgi: Bu işlem yalnızca okuma yaptı. Taslak değiştirilmedi ve yayınlanmadı.',
          ].join('\\n'),
          emotion: 'focused',
        });
      } catch (error) {
        console.error('Mira /taslak database read failed:', error);
        return NextResponse.json({
          reply: '❌ Taslak veritabanından okunamadı. Hata kaydedildi; taslak değiştirilmedi.',
          emotion: 'focused',
        }, { status: 500 });
      }
    }

    if (command === '/n8n') {
      try {
        const base = new URL(req.url).origin;
        const status = await fetchWithTimeout(`${base}/api/automation/n8n-status`, { cache: 'no-store' });
        const data = await status.json().catch(() => ({}));
        return NextResponse.json({
          reply: data.reachable
            ? 'n8n sunucusuna canlı erişim doğrulandı.'
            : 'n8n sunucusuna canlı erişimi doğrulayamadım.',
          emotion: 'focused',
        });
      } catch {
        return NextResponse.json({ reply: 'n8n durumunu şu anda doğrulayamıyorum.', emotion: 'focused' });
      }
    }

    // /yt-viral komutu kontrolü (n8n İngilizce Video Otomasyonu Tetikleyici)
    if (message.startsWith('/yt-viral')) {
      const topic = message.replace('/yt-viral', '').trim() || 'AI tools and future technology';
      
      const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;

      if (!n8nWebhookUrl) {
        return NextResponse.json({
          reply: `⚠️ **N8N_WEBHOOK_URL** ortam değişkeni ayarlanmamış. Lütfen Railway paneline n8n webhook linkinizi ekleyin.\n\nAnaliz edilecek konu: **${topic}**`
        });
      }

      try {
        const response = await fetchWithTimeout(n8nWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: topic,
            language: 'en',
            requested_by: 'Mira Agent',
            timestamp: new Date().toISOString()
          }),
        });

        if (response.ok) {
          return NextResponse.json({
            reply: `🚀 **Mira YouTube otomasyonu tetikleme isteğini n8n'e iletti.**\n\n- **Aranan Konu:** ${topic}\n- **Hedef Kitle:** İngilizce / Global (US)\n- **Durum:** n8n webhook HTTP 2xx yanıtı verdi; bu yalnızca tetiklemenin kabul edildiğini doğrular.\n- **Not:** Video üretimi/yayınlanması henüz bu yanıtla doğrulanmış değildir.`
          });
        } else {
          return NextResponse.json({
            reply: `❌ n8n sunucusuna bağlanırken hata oluştu (Status: ${response.status}). Webhook adresinizi kontrol edin.`
          });
        }
      } catch (err: any) {
        return NextResponse.json({
          reply: `❌ n8n bağlantı hatası: ${err.message || 'Sunucuya ulaşılamadı'}`
        });
      }
    }

    // /oku komutu kontrolü
    if (message.startsWith('/oku ')) {
      const filePath = message.replace('/oku ', '').trim();
      const token = process.env.GITHUB_TOKEN;
      const repo = process.env.GITHUB_REPO;

      if (!token || !repo) {
        return NextResponse.json({
          reply: 'GitHub konfigürasyonu (GITHUB_TOKEN veya GITHUB_REPO) ortam değişkenlerinde eksik.',
        });
      }

      const res = await fetchWithTimeout(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3.raw',
        },
      });

      if (!res.ok) {
        return NextResponse.json({
          reply: `Dosya okunamadı veya bulunamadı: ${filePath} (Status:${res.status})`,
        });
      }

      const fileContent = await res.text();
      return NextResponse.json({
        reply: "```\n" + fileContent + "\n```",
      });
    }

    // Persisted conversation + relevant long-term memory.
    // Memory failures must never take the live chat path down.
    let history: { role: "user" | "assistant"; content: string }[] = [];
    let memoryContext = "(Henüz kayıtlı önemli hafıza yok.)";

    try {
      const recentMessages = await db
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .orderBy(desc(messages.id))
        .limit(12);

      history = recentMessages
        .reverse()
        .filter((m): m is { role: "user" | "assistant"; content: string } =>
          (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
        );

      const relevantMemories = await getRelevantMemories(message, 5);
      memoryContext = formatMemoriesForContext(relevantMemories);
    } catch (memoryError) {
      console.error("Mira context load failed:", memoryError);
    }

    const result = await think(message, history, "", "flirty", memoryContext, "", privateMode);

    // Explicit content-creation requests are saved as reviewable drafts.
    // This never publishes content; the review panel remains the approval gate.
    const asksForContentDraft =
      /(?:taslak|shorts|reels|video|içerik).{0,100}(?:oluştur|hazırla|üret|yaz)|(?:oluştur|hazırla|üret|yaz).{0,100}(?:taslak|shorts|reels|video|içerik)/iu.test(message);
    const asksForTelegramNotification = /telegram|bildirim|haber ver|bilgi ver/iu.test(message);
    const hasUsableDraftReply =
      typeof result.reply === "string" &&
      result.reply.trim().length > 40 &&
      !/^Model bağlantısı başarısız:/iu.test(result.reply.trim());

    if (asksForContentDraft && hasUsableDraftReply) {
      const title = message.trim().replace(/^(?:bana|lütfen)\s*/iu, "").slice(0, 160) || "Yeni YouTube Shorts taslağı";
      const topic = message.trim().slice(0, 2000);

      try {
        const savedDraft = await db.transaction(async (tx) => {
          const [draft] = await tx.insert(contentItems).values({
            title,
            platform: "youtube_shorts",
            status: "draft",
            topic,
          }).returning();

          await tx.insert(operations).values({
            action: "autonomous_content_draft",
            summary: `Mira sohbetten içerik taslağı kaydetti: ${title}`,
            status: "success",
            platform: draft.platform,
            metadata: {
              contentId: draft.id,
              topic,
              title,
              script: result.reply,
              requiresApprovalToPublish: true,
              published: false,
              source: "chat",
            },
          });

          return draft;
        });

        result.reply += `\n\n✅ Taslak onay paneline kaydedildi. Taslak no: ${savedDraft.id}. Yayınlanmadı; yayın için ayrı bir işlem ve senin onayın gerekir.`;

        if (asksForTelegramNotification) {
          try {
            const telegram = await sendTelegramMessage(
              `📋 Mira yeni bir taslak kaydetti\n\nTaslak no: ${savedDraft.id}\nBaşlık: ${savedDraft.title}\nDurum: Taslak kaydedildi. Video üretilmedi ve yayınlanmadı.`
            );
            if (telegram.sent) {
              result.reply += `\n\n✅ Telegram bildirimi gönderildi. Taslak no: ${savedDraft.id}.`;
            } else {
              console.error("[Chat] Telegram draft notification failed:", telegram.reason, telegram.reason === "send_failed" ? telegram.error : "");
              result.reply = telegram.reason === "not_configured"
                ? `Taslak no: ${savedDraft.id} kaydedildi. Video üretilmedi ve yayınlanmadı. Telegram bildirimi GÖNDERİLMEDİ: bot/chat ayarları yapılandırılmamış.`
                : `Taslak no: ${savedDraft.id} kaydedildi. Video üretilmedi ve yayınlanmadı. Telegram bildirimi GÖNDERİLMEDİ: Telegram API başarısız döndü.`;
            }
          } catch (telegramError) {
            console.error("[Chat] Telegram draft notification error:", telegramError instanceof Error ? telegramError.message : String(telegramError));
            result.reply = `Taslak no: ${savedDraft.id} kaydedildi. Video üretilmedi ve yayınlanmadı. Telegram bildiriminin gönderildiği DOĞRULANAMADI.`;
          }
        }
      } catch (saveError) {
        console.error("Mira content draft save failed:", saveError);
        result.reply += "\n\n⚠️ Taslağı onay paneline kaydedemedim. Kayıt doğrulanmadığı için kaydedildi diyemem; içerik yayımlanmadı.";
      }
    }

    // A direct Telegram troubleshooting request must perform a real API check,
    // not let the language model simulate checking phone notification settings.
    if (asksForTelegramNotification && !asksForContentDraft) {
      try {
        const telegram = await sendTelegramMessage(
          "🔔 Mira Telegram bağlantı testi\n\nBu mesaj, Mira sunucusunun Telegram Bot API üzerinden gerçek bir bildirim gönderebildiğini kontrol etmek için gönderildi."
        );
        if (telegram.sent) {
          result.reply = "Telegram bağlantısını gerçek bir mesaj göndererek test ettim: Telegram API mesajı kabul etti. Bu, Mira sunucusundan Telegram'a gönderimin çalıştığını doğrular; telefonundaki ses/titreşim izinlerini buradan göremem. Mesaj telefona düştüyse ancak ses çıkmadıysa Telegram ve Android bildirim ayarlarını kontrol etmek gerekir.";
        } else if (telegram.reason === "not_configured") {
          result.reply = "Telegram testi başarısız: Railway'de TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik. Bu nedenle gerçek mesaj gönderilemedi. Telefonun ses/titreşim ayarları bu hatanın nedeni değil; önce sunucu bağlantısı yapılandırılmalı.";
        } else {
          result.reply = `Telegram testi başarısız: Telegram API mesajı kabul etmedi. Hata: ${telegram.error || "Açıklama dönmedi"}. Bu bir gerçek gönderim denemesinin sonucudur; telefon bildirim ayarlarını henüz kontrol etmiyoruz.`;
        }
      } catch (telegramError) {
        const detail = telegramError instanceof Error ? telegramError.message : String(telegramError);
        result.reply = `Telegram testinde sunucu hatası oluştu: ${detail.slice(0, 300)}. Gerçek bildirim gönderimi doğrulanamadı.`;
      }
    }

    try {
      await db.insert(messages).values([
        { role: "user", content: message, emotion: "focused" },
        { role: "assistant", content: result.reply, emotion: result.emotion },
      ]);
    } catch (persistError) {
      console.error("Mira conversation persistence failed:", persistError);
    }

    const response = NextResponse.json({ ...result, privateMode });
    return response;

  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Sunucu hatası' }, { status: 500 });
  }
}
