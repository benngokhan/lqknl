import { think } from '../../../lib/brain';
import { logEvent } from "@/lib/logger";
import { selfOrigin } from "@/lib/self-url";
import { db } from '@/db';
import { contentAssets, contentItems, messages, memories, operations, tasks } from '@/db/schema';
import { desc, eq, ilike, sql } from 'drizzle-orm';
import { formatMemoriesForContext, getRelevantMemories, generateForgetApprovalMessage, generateSaveApprovalMessage, parseConfirmationResponse, parseMemoryCommand } from '@/lib/memory-chat';
import { remember } from '@/lib/memory';
import { NextResponse } from 'next/server';
import { sendTelegramMessage } from '@/lib/telegram';
import { isPermanentlyDeletedTopic } from "@/lib/deleted-topics";
import { isYoutubeScheduleCancellation, isYoutubeScheduleConfirmation } from "@/lib/youtube-schedule-approval";
import { readDriveVideoMetadata } from "@/lib/drive-video-metadata";
import { isMiraSessionCookie } from "@/lib/mira-auth";
import { requestedScheduleSlots } from "@/lib/youtube-schedule-slots";

const PRIVATE_MODE_COOKIE = 'mira_private_mode';

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
    const authenticated = isMiraSessionCookie(cookieHeader);
    if (!authenticated) {
      return NextResponse.json({ error: 'Mira oturumu doğrulanmadı.' }, { status: 401 });
    }
    const { message } = await req.json();

    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'Geçersiz mesaj' }, { status: 400 });
    }

    // A bare wake word is a conversational cue, not a request to inspect source code.
    if (/^mira[!.… ]*$/iu.test(message.trim())) {
      return NextResponse.json({ reply: 'Buradayım, söyle.', emotion: 'happy' });
    }

    // Yardım ve sistem komutları
    const command = message.trim().split(/\s+/)[0].toLocaleLowerCase('tr-TR');

    // Eski manuel içerik giriş yolları kapalı: yeni içerik yalnızca Google Drive kaynağından alınır.
    if (command === '/paylas-icerik' || command === '/yt-viral' || command === '/video-uret' || command === '/video') {
      return NextResponse.json({
        reply: "Eski manuel içerik/taslak akışı kapatıldı. Yeni içerikler için tek kaynak Google Drive. Drive kataloğu okunmadan eski taslak veya elle girilen konudan üretim başlatmıyorum.",
        emotion: 'focused',
      }, { status: 410 });
    }

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

    // YouTube scheduling is a two-step action: persist an exact preview, then require a separate explicit confirmation.
    const scheduleConfirmation = isYoutubeScheduleConfirmation(message);
    const scheduleRejection = isYoutubeScheduleCancellation(message);
    if (scheduleConfirmation || scheduleRejection) {
      try {
        const [pendingSchedule] = await db.select().from(operations)
          .where(eq(operations.action, "youtube_drive_schedule_pending"))
          .orderBy(desc(operations.id)).limit(1);
        if (pendingSchedule?.status === "pending") {
          const ageMs = Date.now() - new Date(pendingSchedule.createdAt).getTime();
          if (!Number.isFinite(ageMs) || ageMs > 30 * 60 * 1000) {
            await db.update(operations).set({
              status: "cancelled",
              summary: "Plan zaman aşımına uğradı; hiçbir video yüklenmedi.",
            }).where(eq(operations.id, pendingSchedule.id));
            return NextResponse.json({ reply: "Bu yayın planının onay süresi dolmuş. Hiçbir video yüklenmedi; güncel bir plan oluşturmak gerekiyor.", emotion: "focused" });
          }
          if (scheduleRejection) {
            await db.update(operations).set({
              status: "cancelled",
              summary: "Kullanıcı YouTube yayın planını iptal etti; hiçbir video yüklenmedi.",
            }).where(eq(operations.id, pendingSchedule.id));
            return NextResponse.json({ reply: "Plan iptal edildi. Hiçbir video YouTube'a yüklenmedi.", emotion: "focused" });
          }
          const metadata = pendingSchedule.metadata && typeof pendingSchedule.metadata === "object"
            ? pendingSchedule.metadata as { uploads?: Array<{ fileName?: string; title?: string; description?: string; tags?: string[]; comment?: string; publishAt?: string }> }
            : {};
          const uploads = Array.isArray(metadata.uploads) ? metadata.uploads : [];
          if (uploads.length < 2 || uploads.length > 4 || uploads.some((item) =>
            typeof item.fileName !== "string" || typeof item.title !== "string" ||
            typeof item.description !== "string" || !Array.isArray(item.tags) ||
            typeof item.publishAt !== "string" || !Number.isFinite(new Date(item.publishAt).getTime()) ||
            new Date(item.publishAt).getTime() <= Date.now() + 60_000
          )) {
            await db.update(operations).set({ status: "failed", summary: "Bekleyen YouTube planı geçersiz; hiçbir video yüklenmedi." }).where(eq(operations.id, pendingSchedule.id));
            return NextResponse.json({ reply: "Bekleyen planın bilgileri geçersiz veya yayın saatleri geçmiş. Güvenlik için hiçbir video yüklenmedi; yeni plan hazırlanmalı.", emotion: "focused" }, { status: 409 });
          }

          const origin = selfOrigin();
          const uploadResults: Array<{ fileName: string; ok: boolean; url?: string; error?: string; publishAt: string }> = [];
          for (const item of uploads) {
            try {
              const response = await fetchWithTimeoutMs(`${origin}/api/youtube/drive-upload`, {
                method: "POST",
                headers: { "Content-Type": "application/json", cookie: cookieHeader },
                body: JSON.stringify({ confirm: true, ...item }),
              }, VIDEO_TIMEOUT_MS);
              const data = await response.json().catch(() => ({})) as Record<string, unknown>;
              uploadResults.push({
                fileName: item.fileName!,
                ok: response.ok && data.uploaded === true && data.scheduled === true,
                url: typeof data.url === "string" ? data.url : undefined,
                error: typeof data.error === "string" ? data.error : undefined,
                publishAt: item.publishAt!,
              });
            } catch (error) {
              uploadResults.push({
                fileName: item.fileName!,
                ok: false,
                error: error instanceof Error ? error.message.slice(0, 250) : "İstek sonucu doğrulanamadı",
                publishAt: item.publishAt!,
              });
            }
          }
          const successCount = uploadResults.filter((item) => item.ok).length;
          await db.update(operations).set({
            status: successCount === uploadResults.length ? "success" : successCount > 0 ? "partial" : "failed",
            summary: `YouTube planı onaylandı; ${successCount}/${uploadResults.length} video doğrulanmış biçimde planlandı.`,
            metadata: { ...metadata, results: uploadResults, completedAt: new Date().toISOString() },
          }).where(eq(operations.id, pendingSchedule.id));
          return NextResponse.json({
            reply: [
              `Onaylanan plan işlendi: ${successCount}/${uploadResults.length} video YouTube tarafından kabul edilip planlandı.`,
              ...uploadResults.map((item, index) =>
                `${index + 1}. ${item.fileName}: ${item.ok ? "PLANLANDI" : "BAŞARISIZ"} — ${item.ok ? item.url : item.error || "YouTube sonucu doğrulanamadı"} — Türkiye saati: ${new Date(item.publishAt).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}`
              ),
              "Başarılı sayılan kayıtlar YouTube API yanıtıyla doğrulandı. Bu, videoların şu anda herkese açık olduğu anlamına gelmez.",
            ].join("\n"),
            emotion: "focused",
          }, { status: successCount === uploadResults.length ? 200 : 502 });
        }
      } catch (scheduleError) {
        console.error("[Chat] YouTube schedule approval failed:", scheduleError);
        return NextResponse.json({ reply: "Bekleyen yayın planı okunamadı veya güncellenemedi. Hiçbir yeni yükleme başlatılmadı.", emotion: "focused" }, { status: 500 });
      }
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
          '/drive-katalog — Google Drive klasöründeki gerçek başlık ve video dosyalarını kontrol eder.',
          'Yeni içerik kaynağı yalnızca Google Drive’dır; eski manuel konu/taslak komutları kapatıldı.',
          '/uretim-list — Son üretim/işlem kayıtlarını veritabanından listeler.',
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
        reply: '😈 Özel Mira modu açıldı. Konuşma boyunca daha yaramaz ve flörtöz olacağım; güvenlik falan yok patron, yanmaya hazır ol 😄',
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

    // /uretim-list: Read recent operation/production records from the database.
    if (command === '/uretim-list') {
      try {
        const rows = await db.select({
          action: operations.action,
          status: operations.status,
          summary: operations.summary,
          createdAt: operations.createdAt,
        }).from(operations).orderBy(desc(operations.id)).limit(30);
        return NextResponse.json({
          reply: rows.length
            ? ['🧾 Son işlem/üretim kayıtları:', '', ...rows.map((row) => {
                const date = row.createdAt
                  ? new Date(row.createdAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })
                  : 'tarih yok';
                return `${date} | ${row.status || 'durum yok'} | ${row.action || 'işlem'} | ${row.summary || 'özet yok'}`;
              })].join('\\n')
            : 'Veritabanında işlem/üretim kaydı bulunamadı.',
          emotion: 'focused',
        });
      } catch (error) {
        console.error('Mira /uretim-list failed:', error);
        return NextResponse.json({
          reply: '❌ İşlem/üretim kayıtlarını veritabanından okuyamadım. Hata kaydedildi; hiçbir kayıt değiştirilmedi.',
          emotion: 'focused',
        }, { status: 500 });
      }
    }

    // /taslak-list: List saved drafts from both the content table and worker operation records.
    if (command === '/taslak-list') {
      try {
        const rows = await db.select().from(contentItems).orderBy(desc(contentItems.updatedAt)).limit(100);
        const draftOps = await db.select().from(operations)
          .where(eq(operations.action, 'autonomous_content_draft'))
          .orderBy(desc(operations.id))
          .limit(500);
        const byId = new Map<number, { title: string; status: string; platform: string; createdAt: string }>();
        for (const row of rows) {
          if (row.status === 'deleted') continue;
          byId.set(row.id, {
            title: row.title,
            status: row.status,
            platform: row.platform,
            createdAt: row.createdAt ? new Date(row.createdAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }) : 'tarih yok',
          });
        }
        for (const op of draftOps) {
          if (op.status === 'deleted') continue;
          const meta = op.metadata && typeof op.metadata === 'object' ? op.metadata as Record<string, unknown> : {};
          const id = Number(meta.contentId);
          if (!Number.isInteger(id) || id <= 0 || byId.has(id)) continue;
          const title = typeof meta.title === 'string' ? meta.title : op.summary.replace(/^.*?:\s*/, '').slice(0, 180);
          byId.set(id, { title: title || 'Başlıksız taslak', status: 'yalnızca işçi kaydında', platform: 'bilinmiyor', createdAt: op.createdAt ? new Date(op.createdAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }) : 'tarih yok' });
        }
        const entries = [...byId.entries()].sort((a, b) => b[0] - a[0]);
        return NextResponse.json({
          reply: entries.length
            ? ['📚 Kayıtlı taslaklar (silinmiş kayıtlar hariç):', '', ...entries.map(([id, row]) => `#${id} — ${row.title} | Durum: ${row.status} | Platform: ${row.platform} | ${row.createdAt}`), '', 'Görmek için: /taslak <id>', 'Silmek için: /taslak-sil <id>'].join('\n')
            : 'Kayıtlı taslak bulunamadı.',
          emotion: 'focused',
        });
      } catch (error) {
        console.error('Mira /taslak-list failed:', error);
        return NextResponse.json({ reply: '❌ Taslak listesi okunamadı. Hata kaydedildi; hiçbir kayıt değiştirilmedi.', emotion: 'focused' }, { status: 500 });
      }
    }

    // /taslak-sil <id>: Soft-delete a draft and retain its audit trail for recovery/diagnostics.
    if (command === '/taslak-sil') {
      const idText = message.trim().split(/\\s+/)[1];
      const id = Number(idText);
      if (!idText || !Number.isInteger(id) || id <= 0) {
        return NextResponse.json({ reply: 'Kullanım: /taslak-sil 17 — Silmek istediğin taslak numarasını yaz.', emotion: 'focused' });
      }
      try {
        const [row] = await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
        const matchingOps = await db.select().from(operations)
          .where(eq(operations.action, 'autonomous_content_draft'))
          .orderBy(desc(operations.id))
          .limit(500);
        const relatedOps = matchingOps.filter((op) => {
          const meta = op.metadata && typeof op.metadata === 'object' ? op.metadata as Record<string, unknown> : {};
          return Number(meta.contentId) === id && op.status !== 'deleted';
        });
        if (!row && relatedOps.length === 0) {
          return NextResponse.json({ reply: `❌ #${id} numaralı taslak bulunamadı.`, emotion: 'focused' });
        }
        if (row && ['published', 'uploaded', 'live'].includes(row.status.toLocaleLowerCase('tr-TR'))) {
          return NextResponse.json({ reply: `⛔ #${id} yayınlanmış görünüyor; güvenlik için silinmedi.`, emotion: 'focused' });
        }
        if (row) {
          await db.update(contentItems).set({ status: 'deleted', updatedAt: new Date() }).where(eq(contentItems.id, id));
        }
        for (const op of relatedOps) {
          await db.update(operations).set({ status: 'deleted', summary: `Taslak #${id} kullanıcı komutuyla silindi (kayıt korundu).` }).where(eq(operations.id, op.id));
        }
        await db.insert(operations).values({
          action: 'content_soft_delete',
          status: 'success',
          summary: `Taslak #${id} silinmek üzere gizlendi; kayıt denetim için korundu.`,
          platform: row?.platform ?? null,
          externalId: row?.externalId ?? null,
          metadata: { contentId: id, softDeleted: true, relatedDraftOperations: relatedOps.length },
        });
        return NextResponse.json({ reply: `🗑️ Taslak #${id} listeden kaldırıldı. Kayıt kalıcı olarak veritabanından silinmedi; denetim ve kurtarma için korundu.`, emotion: 'focused' });
      } catch (error) {
        console.error('Mira /taslak-sil failed:', error);
        return NextResponse.json({ reply: '❌ Taslak silinemedi. Hata kaydedildi; işlem tamamlandı diye işaretlenmedi.', emotion: 'focused' }, { status: 500 });
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
        if (content?.status === 'deleted') {
          return NextResponse.json({ reply: `ℹ️ Taslak #${id} silinmiş olarak işaretli. /taslak-list komutunda gösterilmez.`, emotion: 'focused' });
        }

        const draftOperations = await db.select().from(operations)
          .where(eq(operations.action, 'autonomous_content_draft'))
          .orderBy(desc(operations.id))
          .limit(500);
        const draftOperation = draftOperations.find((operation) => {
          const metadata = operation.metadata && typeof operation.metadata === 'object'
            ? operation.metadata as Record<string, unknown>
            : {};
          return Number(metadata.contentId) === id && operation.status !== 'deleted' && typeof metadata.script === 'string';
        });
        const metadata = draftOperation?.metadata && typeof draftOperation.metadata === 'object'
          ? draftOperation.metadata as Record<string, unknown>
          : {};
        const script = typeof metadata.script === 'string' ? metadata.script : '';

        if (!content && !draftOperation) {
          return NextResponse.json({ reply: `❌ #${id} numaralı taslak veritabanında veya işçi kayıtlarında bulunamadı.`, emotion: 'focused' });
        }
        const title = content?.title || (typeof metadata.title === 'string' ? metadata.title : draftOperation?.summary || `Taslak #${id}`);
        if (!script) {
          return NextResponse.json({
            reply: `⚠️ ID ${id} (${title}) bulundu; ancak kayıtlı senaryo metni bulunamadı. Taslak değiştirilmedi.`,
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
            `📄 Kayıtlı taslak #${id}: ${title}`,
            `Durum: ${content?.status || 'yalnızca işçi kaydında'}`,
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
        const base = selfOrigin();
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

    // Son üretilen video hakkında soru: yanıtı model tahmininden değil, gerçek video varlığından oluştur.
    const asksLatestVideoDetails =
      /(?:en\s+son|son)(?:\s+ürettiğin|\s+üretilen|\s+hazırladığın|\s+hazırlanan)?[\s\S]{0,70}(?:video|mp4)|(?:video|mp4)[\s\S]{0,70}(?:en\s+son|son)(?:\s+ürettiğin|\s+üretilen|\s+hazırladığın|\s+hazırlanan)?/iu.test(message) &&
      /(?:bahset|içeriğ|konu|neydi|anlat|göster|detay|sonuç)/iu.test(message);
    if (asksLatestVideoDetails) {
      try {
        const [latest] = await db.select({
          contentId: contentItems.id,
          title: contentItems.title,
          topic: contentItems.topic,
          status: contentItems.status,
          platform: contentItems.platform,
          createdAt: contentAssets.createdAt,
          assetId: contentAssets.id,
          bytes: contentAssets.bytes,
          meta: contentAssets.meta,
        })
          .from(contentAssets)
          .innerJoin(contentItems, eq(contentAssets.contentId, contentItems.id))
          .where(eq(contentAssets.kind, 'video'))
          .orderBy(desc(contentAssets.createdAt))
          .limit(1);

        if (!latest) {
          return NextResponse.json({
            reply: 'Kayıtlarda henüz oluşturulmuş bir MP4 video bulamadım. Taslak veya senaryo, tek başına video dosyasının üretildiğini kanıtlamaz.',
            emotion: 'focused',
          });
        }

        const meta = latest.meta && typeof latest.meta === 'object' ? latest.meta as Record<string, unknown> : {};
        const duration = typeof meta.durationSeconds === 'number' ? Math.round(meta.durationSeconds) : null;
        const date = latest.createdAt
          ? new Date(latest.createdAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })
          : 'tarih kaydı yok';
        const baseUrl = (process.env.NEXT_PUBLIC_MIRA_BASE_URL || 'https://aimira.up.railway.app').replace(/\/$/, '');
        const previewUrl = baseUrl + '/api/video/asset/' + latest.assetId;
        const topicLine = latest.topic && latest.topic.trim() && latest.topic !== latest.title
          ? '\nKonu: ' + latest.topic
          : '';
        const durationLine = duration !== null ? '\nSüre: yaklaşık ' + duration + ' saniye' : '';
        const sizeLine = typeof latest.bytes === 'number' ? '\nDosya boyutu: ' + (latest.bytes / (1024 * 1024)).toFixed(1) + ' MB' : '';
        return NextResponse.json({
          reply: 'En son kaydedilmiş video: “' + latest.title + '”.' + topicLine +
            '\nDurum: ' + latest.status + durationLine + sizeLine +
            '\nKaydedilme: ' + date +
            '\nÖnizleme: ' + previewUrl +
            '\nBu bilgi veritabanındaki gerçek MP4 kaydından alındı; YouTube’da yayımlandığı anlamına gelmez.',
          emotion: 'focused',
        });
      } catch (error) {
        console.error('Mira latest video lookup failed:', error);
        return NextResponse.json({
          reply: 'Son videonun kaydını şu anda okuyamadım; içeriğini tahmin edip varmış gibi anlatmayacağım.',
          emotion: 'focused',
        });
      }
    }

    // Yan etkili işlemler yalnızca açık slash komutlarıyla başlar.
    // Normal konuşmada "video üret" ifadesinin geçmesi üretimi tetiklemez.
    const trimmedIntent = message.trim();
    const isDiscussionOrQuestion =
      /[?？]\s*$/u.test(trimmedIntent) ||
      /(?:\b(?:neden|niçin|niye|nasıl|ne demek|sorun|çözüm|komut|ifade|kelime|cümle|geçtiği zaman|geçtiği için|bahset|konuşalım|açıkla|incele)\b)/iu.test(trimmedIntent);
    if (command === '/video-uret' || command === '/video-üret' || /^\/video-[uü]ret(?:\s|$)/iu.test(trimmedIntent)) {
      // ID yalnızca bağımsız sayı olarak alınır; MP4 içindeki 4 sayı sayılmaz.
      const idMatch = message.replace(/^\/video-[uü]ret/iu, '').match(/(?:^|[^\w])(\d+)(?=$|[^\w])/);
      const contentId = idMatch ? Number(idMatch[1]) : null;
      const origin = selfOrigin();
      const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
      const steps: string[] = [];
      try {
        // id verildiyse ve içerik hâlâ taslaksa önce "videolu onay" al (kullanıcının açık isteği)
        if (contentId) {
          let row: typeof contentItems.$inferSelect | undefined;
          try {
            [row] = await db.select().from(contentItems).where(eq(contentItems.id, contentId)).limit(1);
          } catch {
            return NextResponse.json({ reply: '❌ Veritabanına erişemedim; biraz sonra tekrar dene.' });
          }
          if (!row) {
            return NextResponse.json({ reply: `❌ İçerik #${contentId} bulunamadı.` });
          }
          if (row.status === 'draft') {
            const reviewRes = await fetch(origin + '/api/content/review', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                cookie: req.headers.get('cookie') || '',
              },
              body: JSON.stringify({ id: contentId, action: 'approve_video' }),
              cache: 'no-store',
            });
            if (!reviewRes.ok) {
              const rData: unknown = await reviewRes.json().catch(() => null);
              const rErr = rData && typeof rData === 'object' && 'error' in rData ? String((rData as { error: unknown }).error) : `HTTP ${reviewRes.status}`;
              return NextResponse.json({ reply: `❌ Taslak #${contentId} onaylanamadı: ${rErr}` });
            }
            steps.push(`#${contentId} videolu onaylandı`);
          } else if (row.status === 'approved') {
            steps.push(`#${contentId} zaten onaylı`);
          } else if (row.status === 'ready') {
            steps.push(`#${contentId} videosu daha önce üretilmiş`);
          } else {
            return NextResponse.json({ reply: `ℹ️ İçerik #${contentId} durumu "${row.status}"; üretim yalnızca taslak/onaylı içeriklerden tetiklenebilir.` });
          }
        }

        // UZUN İŞ: üretimin bitmesini BEKLEME — ateşle ve hemen geri dön.
        // Edge'in idle-kesmesi artık bu çağrıyı öldüremez; her aşama logEvent'e düşer.
        const startedAt = Date.now();
        void fetch(origin + '/api/automation/produce', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'x-mira-key': secret } : {}),
          },
          body: JSON.stringify(contentId ? { contentId } : {}),
          cache: 'no-store',
        })
          .then(async (r) => {
            const raw = await r.text().catch(() => '');
            let parsed: Record<string, unknown> | null = null;
            try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = null; }
            if (!r.ok) {
              void logEvent({ level: 'error', source: 'chat/video', message: `Üretim red döndü: HTTP ${r.status} — ${raw.slice(0, 160)}`, meta: { contentId } });
            } else if (parsed && (parsed.ok === false || parsed.produced === false || parsed.blocked === true)) {
              const why = String(parsed.error ?? parsed.message ?? raw.slice(0, 160));
              void logEvent({ level: 'warn', source: 'chat/video', message: `Üretim tamamlanamadı: ${why.slice(0, 180)}${parsed.reason ? ` | sebep: ${String(parsed.reason).slice(0, 120)}` : ''}`, meta: { contentId } });
            } else {
              void logEvent({ level: 'success', source: 'chat/video', message: `Chat tetiklemesiyle video üretimi tamamlandı (${Math.round((Date.now() - startedAt) / 1000)} sn)`, meta: { contentId } });
            }
          })
          .catch((err: unknown) => {
            const cause = err && typeof err === 'object' && 'cause' in err ? String((err as { cause?: unknown }).cause) : '';
            const msg = err instanceof Error ? err.message : String(err);
            void logEvent({ level: 'error', source: 'chat/video', message: `Üretim çağrısı yerine ulaşamadı: ${msg}${cause ? ` (${cause})` : ''}`, meta: { contentId, ms: Date.now() - startedAt } });
          });
        void logEvent({ level: 'info', source: 'chat/video', message: `Video üretimi arka planda tetiklendi${contentId ? ` #${contentId}` : ' (otomatik sıradaki onaylı içerik)'}`, meta: { contentId } });
        return NextResponse.json({
          reply: `🎬 **Video üretimi başladı.**\n\n${steps.length ? `**Adımlar:** ${steps.join(' → ')}\n\n` : ''}İşlem arka planda sürüyor (senaryo → ses → görseller → altyazı → MP4). Bitince Telegram bildirimi düşer; istersen **/logs** ekranından satır satır izleyebilirsin. YouTube'a yükleme bu adımın parçası değil.`,
          emotion: 'happy',
        });
      } catch (err: unknown) {
        const message2 = err instanceof Error ? err.message : 'bağlantı hatası';
        void logEvent({ level: 'error', source: 'chat/video', message: `Üretim ön-uçu patladı: ${message2.slice(0, 200)}` });
        return NextResponse.json({ reply: `❌ Üretim isteği gönderilemedi: ${message2}` });
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

    // Explicit request: analyze the drafts already stored in the content depot.
    // Route to the real analysis endpoint instead of asking the user to resend drafts.
    const asksToAnalyzeStoredDrafts =
      /(?:taslak|içerik deposu|işçi taslakları).{0,120}(?:analiz|incele|değerlendir)|(?:analiz|incele|değerlendir).{0,120}(?:taslak|içerik deposu|işçi taslakları)/iu.test(message);

    if (asksToAnalyzeStoredDrafts) {
      try {
        const base = selfOrigin();
        const response = await fetchWithTimeoutMs(`${base}/api/automation/analyze-drafts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
          body: JSON.stringify({ source: "chat" }),
        }, VIDEO_TIMEOUT_MS);
        const data = await response.json().catch(() => ({})) as {
          ok?: boolean;
          analyzed?: boolean;
          count?: number;
          message?: string;
          report?: string;
          provider?: string;
          model?: string;
          error?: string;
        };

        if (!response.ok || data.ok === false) {
          return NextResponse.json({
            reply: `Taslak analizi başlatılamadı. HTTP ${response.status}. ${data.error || data.message || "Analiz servisi hata döndürdü."}`,
            emotion: "focused",
          });
        }

        if (data.analyzed && data.report) {
          return NextResponse.json({
            reply: `📊 Kayıtlı taslak analizi tamamlandı. İncelenen taslak: ${data.count ?? 0}. Model: ${data.provider ?? "bilinmiyor"} / ${data.model ?? "bilinmiyor"}.\n\n${data.report}`,
            emotion: "focused",
          });
        }

        return NextResponse.json({
          reply: data.message || `Analiz servisi yeni analiz yapmadı. İncelenen taslak sayısı: ${data.count ?? 0}. Taslakların kayıtlı senaryo metinleri veya önceki analiz durumları kontrol edilmeli.`,
          emotion: "focused",
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error("[Chat] Stored-draft analysis failed:", reason);
        return NextResponse.json({
          reply: `Kayıtlı taslak analiz servisine ulaşılamadı: ${reason.slice(0, 250)}`,
          emotion: "focused",
        }, { status: 502 });
      }
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

    // Drive-only requests must call the real Drive API; never let the LLM invent a catalogue.
    const mentionsDrive = /(?:google\s*drive|\bdrive\b|baslik\.md|video_\d+\.mp4|uzun_video_\d+\.mp4)/iu.test(message);
    const mentionsYoutubeOrChannel = /(?:youtube|\bkanal\b|yayınlanmış videolar|yüklenmiş videolar)/iu.test(message);
    const asksForDriveAction = /(?:dosya|katalog|liste|başlık|başlik|baslik|video|mp4|klasör|klasor|içerik|icerik|kontrol|incele|bak|say|doğrula|dogrula|sağlam|saglam|indir|oku)/iu.test(message);
    const asksForDriveOnlyAudit = mentionsDrive && asksForDriveAction && !mentionsYoutubeOrChannel;

    if (asksForDriveOnlyAudit) {
      try {
        const origin = selfOrigin();
        // Natural-language Drive import: prepare the requested numbered Short without uploading it.
        const prepareVideoMatch = message.match(/(?:drive(?:'daki|'ta|da|dan)?|google\s*drive|video)?[\s\S]{0,80}?(?:video\s*)?(\d{1,3})\s*(?:numaralı|numarali|no(?:'lu)?|numara(?:lı|li)?)\s*video(?:yu|yı)?|video_(\d{1,3})\.mp4/iu);
        const asksToPrepareDriveVideo = Boolean(prepareVideoMatch) &&
          /(?:hazırla|hazirla|içe\s*aktar|ice\s*aktar|içeri\s*al|iceri\s*al|sisteme\s*al|mira'ya\s*aktar)/iu.test(message) &&
          !/(?:youtube|kanal).{0,30}(?:yükle|yayınla|planla)|(?:yükle|yayınla|planla).{0,30}(?:youtube|kanal)/iu.test(message);
        if (asksToPrepareDriveVideo && prepareVideoMatch) {
          const videoNumber = Number(prepareVideoMatch[1] || prepareVideoMatch[2]);
          const catalogResponse = await fetchWithTimeoutMs(origin + "/api/drive/catalog", {
            headers: { cookie: cookieHeader },
          }, 45000);
          const catalogData = await catalogResponse.json().catch(() => ({})) as {
            ok?: boolean; error?: string;
            videos?: { shorts?: Array<{ id: string; name: string; size?: string }> };
          };
          if (!catalogResponse.ok || !catalogData.ok) {
            return NextResponse.json({
              reply: "Drive videosunu hazırlayamadım. Katalog okunamadı (HTTP " + catalogResponse.status + "): " + (catalogData.error || "bilinmeyen hata") + ".",
              emotion: "focused",
            }, { status: catalogResponse.status >= 400 ? catalogResponse.status : 502 });
          }
          const targetName = "video_" + videoNumber + ".mp4";
          const target = (catalogData.videos?.shorts || []).find((file) => file.name.toLocaleLowerCase("tr-TR") === targetName);
          if (!target?.id) {
            return NextResponse.json({
              reply: "Drive kataloğunda " + targetName + " bulunamadı. Hiçbir dosya içe aktarılmadı.",
              emotion: "focused",
            });
          }
          const prepareResponse = await fetchWithTimeoutMs(origin + "/api/drive/prepare-upload", {
            method: "POST",
            headers: { "Content-Type": "application/json", cookie: cookieHeader },
            body: JSON.stringify({ fileId: target.id, videoNumber }),
          }, 150000);
          const prepareData = await prepareResponse.json().catch(() => ({})) as {
            ok?: boolean; alreadyImported?: boolean; contentId?: number; title?: string; error?: string;
            uploadApproved?: boolean; message?: string;
          };
          if (!prepareResponse.ok || !prepareData.ok) {
            return NextResponse.json({
              reply: targetName + " içe aktarılamadı. HTTP " + prepareResponse.status + ": " + (prepareData.error || "işlem sonucu doğrulanamadı") + ".",
              emotion: "focused",
            }, { status: prepareResponse.status >= 400 ? prepareResponse.status : 502 });
          }
          return NextResponse.json({
            reply: prepareData.alreadyImported
              ? targetName + " daha önce Mira'ya aktarılmış. Kayıt: " + (prepareData.contentId ?? "bilinmiyor") + "; başlık: " + (prepareData.title || "bilinmiyor") + ". YouTube'a yüklenmedi."
              : targetName + " Mira'ya aktarıldı ve metadata eşleştirmesi yapıldı. Kayıt: " + (prepareData.contentId ?? "oluşturuldu") + "; başlık: " + (prepareData.title || "baslik.md'den okundu") + ". YouTube'a yüklenmedi; yükleme için ayrıca açık onay gerekiyor.",
            emotion: "focused",
          });
        }

        const fileMatch = message.match(/\b((?:video|uzun_video)_\d+\.mp4)\b/iu);
        const asksForIntegrityTest = Boolean(fileMatch) && /(?:sağlam|saglam|geçerli|gecerli|doğrula|dogrula|indir|test|kontrol|çalışıyor|calisiyor|bozuk|açılıyor|aciliyor|analiz|incele|özellik|ozellik|süre|sure|çözünürlük|cozunurluk|fps|ses|kaç\s*(?:saniye|dakika)|teknik bilgi)/iu.test(message);
        const asksForTitleDocument = /(?:baslik\.md|başlık|başlik|başlıkları|başliklari|konu listesi|başlık listesi)/iu.test(message);

        if (asksForIntegrityTest && fileMatch) {
          const fileName = fileMatch[1];
          const response = await fetchWithTimeoutMs(
            `${origin}/api/drive/test-download?file=${encodeURIComponent(fileName)}`,
            { headers: { cookie: cookieHeader } },
            150000,
          );
          const result = await response.json().catch(() => ({})) as {
            ok?: boolean; name?: string; expectedBytes?: number; actualBytes?: number;
            exactSizeMatch?: boolean; mimeType?: string; mp4SignatureValid?: boolean;
            durationSeconds?: number | null; width?: number | null; height?: number | null;
            frameRate?: number | null; hasAudio?: boolean; shortsReady?: boolean;
            message?: string; error?: string; downloadHttpStatus?: number | null;
          };
          const size = (value?: number) => typeof value === "number" ? `${value.toLocaleString("tr-TR")} bayt` : "bilinmiyor";
          return NextResponse.json({
            reply: response.ok && result.ok
              ? [
                  `Drive kontrolü gerçekten tamamlandı: ${result.name}. İndirilen boyut: ${size(result.actualBytes)}; Drive boyutuyla eşleşme: evet; MIME: ${result.mimeType}; MP4 imzası: geçerli.`,
                  result.durationSeconds != null ? `Süre: ${result.durationSeconds} saniye.` : "Süre bilgisi alınamadı.",
                  result.width != null && result.height != null ? `Çözünürlük: ${result.width}×${result.height}.` : "Çözünürlük bilgisi alınamadı.",
                  result.frameRate != null ? `Kare hızı: ${result.frameRate} fps.` : "Kare hızı bilgisi alınamadı.",
                  typeof result.hasAudio === "boolean" ? `Ses akışı: ${result.hasAudio ? "var" : "yok"}.` : "Ses akışı bilgisi alınamadı.",
                  typeof result.shortsReady === "boolean" ? `Dikey Shorts ölçütü (3 dakikaya kadar): ${result.shortsReady ? "uygun" : "uygun değil"}.` : "",
                  result.message || ""
                ].filter(Boolean).join(" ")
              : `Drive dosya kontrolü başarısız: ${result.name || fileName}. HTTP: ${response.status}; hata: ${result.error || result.message || "Dosya doğrulanamadı"}. Dosyanın sağlam olduğunu söyleyemem.`,
            emotion: "focused",
          }, { status: response.ok && result.ok ? 200 : 502 });
        }

        const endpoint = asksForTitleDocument ? "/api/drive/catalog" : "/api/drive/files";
        const response = await fetchWithTimeoutMs(`${origin}${endpoint}`, {
          headers: { cookie: cookieHeader },
        }, 45000);
        const data = await response.json().catch(() => ({})) as {
          ok?: boolean; error?: string; count?: number;
          files?: Array<{ name: string; size?: string; mimeType?: string }>;
          document?: { name?: string; characters?: number; mimeType?: string };
          titleCandidates?: Array<{ line: number; kind: string; title: string }>;
          videos?: { shorts?: Array<{ name: string; size?: string }>; longVideos?: Array<{ name: string; size?: string }> };
          documentText?: string;
        };
        if (!response.ok || !data.ok) {
          return NextResponse.json({
            reply: `Drive'a gerçek erişim denemesi başarısız oldu. Endpoint: ${endpoint}; HTTP ${response.status}; hata: ${data.error || "Drive yanıtı doğrulanamadı"}. Dosyaları gördüğümü iddia etmeyeceğim.`,
            emotion: "focused",
          }, { status: response.status >= 400 ? response.status : 502 });
        }

        if (endpoint === "/api/drive/catalog") {
          const shorts = data.videos?.shorts || [];
          const longVideos = data.videos?.longVideos || [];
          const titles = (data.titleCandidates || []).map((item) => `L${item.line}: ${item.title}`).join("\n");
          const formatCatalogFile = (item: { name: string; size?: string }) =>
            `${item.name} (${item.size ? `${Number(item.size).toLocaleString("tr-TR")} bayt` : "boyut bilgisi yok"})`;
          const body = [
            `Drive API'den canlı okuma tamamlandı. Dosya: ${data.document?.name || "baslik.md"}; metin uzunluğu: ${data.document?.characters ?? 0} karakter.`,
            `Video listesi: ${shorts.length} Shorts, ${longVideos.length} uzun video.`,
            shorts.length ? `Shorts: ${shorts.map(formatCatalogFile).join(", ")}` : "Shorts dosyası bulunamadı.",
            longVideos.length ? `Uzun videolar: ${longVideos.map(formatCatalogFile).join(", ")}` : "Uzun video dosyası bulunamadı.",
            titles ? `baslik.md başlıkları:\n${titles}` : "baslik.md içinde başlık/listelenen madde bulunamadı.",
            "Not: Bu işlem dosyaları listeledi ve baslik.md dosyasını okudu; MP4 dosyalarının sağlamlığı ayrıca test edilmediyse doğrulanmış sayılmaz."
          ].join("\n\n");
          return NextResponse.json({ reply: body, emotion: "focused" });
        }

        const files = data.files || [];
        const shorts = files.filter((item) => /^video_\d+\.mp4$/iu.test(item.name))
          .sort((a, b) => Number(a.name.match(/\d+/u)?.[0] || 0) - Number(b.name.match(/\d+/u)?.[0] || 0));
        const longVideos = files.filter((item) => /^uzun_video_\d+\.mp4$/iu.test(item.name))
          .sort((a, b) => Number(a.name.match(/\d+/u)?.[0] || 0) - Number(b.name.match(/\d+/u)?.[0] || 0));
        const other = files.filter((item) => !/^(?:video|uzun_video)_\d+\.mp4$/iu.test(item.name));
        const format = (item: { name: string; size?: string }) => `${item.name} (${item.size ? `${Number(item.size).toLocaleString("tr-TR")} bayt` : "boyut bilgisi yok"})`;
        return NextResponse.json({
          reply: [
            `Drive API'den canlı dosya listesi alındı: ${data.count ?? files.length} dosya.`,
            `Shorts dosyaları (${shorts.length}): ${shorts.length ? shorts.map(format).join(", ") : "bulunamadı"}`,
            `Uzun videolar (${longVideos.length}): ${longVideos.length ? longVideos.map(format).join(", ") : "bulunamadı"}`,
            other.length ? `Diğer dosyalar: ${other.map(format).join(", ")}` : "Diğer dosya yok.",
            "Not: Bu, Drive listesinin canlı okunduğunu doğrular; video dosyalarının indirilebilir/sağlam olduğunu ayrıca test etmeden iddia etmiyorum."
          ].join("\n\n"),
          emotion: "focused",
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error("[Chat] Drive-only audit failed:", reason);
        return NextResponse.json({
          reply: `Drive kontrolü tamamlanamadı; dosyaları gördüğümü söylemeyeceğim. Hata: ${reason.slice(0, 300)}`,
          emotion: "focused",
        }, { status: 502 });
      }
    }

    // Read-only channel + Drive analysis: compare the actual YouTube uploads with real Drive files.
    const asksForChannelAudit =
      /(?:kanal.{0,60}(?:analiz|incele|durum|video|yüklen)|(?:önce|daha önce|zaten).{0,40}(?:yüklenmiş|yayınlanmış)|(?:yüklenmemiş|tekrar yükle|çakışan video|youtube videoları)|video_\d+\.mp4|youtube.{0,100}(?:drive|mp4|planlı yükle|yükleme akışı)|drive.{0,100}(?:mp4|yükle|planla))/iu.test(message);

    if (asksForChannelAudit) {
      try {
        const origin = selfOrigin();
        const [youtubeResponse, driveResponse] = await Promise.all([
          fetchWithTimeoutMs(`${origin}/api/youtube/videos?limit=200`, { headers: { cookie: cookieHeader } }, 30000),
          fetchWithTimeoutMs(`${origin}/api/drive/catalog`, { headers: { cookie: cookieHeader } }, 30000),
        ]);
        const youtubeData = await youtubeResponse.json().catch(() => ({})) as {
          ok?: boolean; error?: string; channelTitle?: string; channelId?: string; count?: number;
          videos?: Array<{ videoId: string; title: string; publishedAt: string | null; privacyStatus: string | null; url: string }>;
        };
        const driveData = await driveResponse.json().catch(() => ({})) as {
          ok?: boolean; error?: string; document?: { name?: string; characters?: number };
          documentText?: string; titleCandidates?: Array<{ line: number; kind: string; title: string }>;
          videos?: { shorts?: Array<{ name: string; id?: string }>; longVideos?: Array<{ name: string; id?: string }> };
        };
        if (!youtubeResponse.ok || !youtubeData.ok) {
          return NextResponse.json({
            reply: `YouTube kanal analizi için gerçek video listesi alınamadı: ${youtubeData.error || `HTTP ${youtubeResponse.status}`}. Kanalın incelendiğini varsaymayacağım.`,
            emotion: "focused",
          }, { status: youtubeResponse.status >= 400 ? youtubeResponse.status : 502 });
        }

        const auditContext = [
          "YOUTUBE KANAL DENETİMİ — bu istekte kanalın gerçek yüklemeler listesi YouTube API'sinden okundu.",
          "Yalnızca aşağıdaki canlı verileri ve Drive kataloğunu kullan. Başlıklar benziyor diye kesin eşleşme iddia etme; eşleşmeleri 'kesin', 'olası' veya 'belirsiz' diye ayır.",
          `Kanal: ${youtubeData.channelTitle || "bilinmiyor"}; kanal ID: ${youtubeData.channelId || "bilinmiyor"}; listelenen video: ${youtubeData.count ?? youtubeData.videos?.length ?? 0}`,
          "YouTube'da zaten bulunan videolar (kimlik, başlık, tarih ve gizlilik):",
          JSON.stringify(youtubeData.videos || []),
          "Drive kataloğu:",
          driveData.ok
            ? JSON.stringify({ document: driveData.document, shorts: driveData.videos?.shorts, longVideos: driveData.videos?.longVideos, titleCandidates: driveData.titleCandidates, documentText: driveData.documentText })
            : `Drive kataloğu okunamadı: ${driveData.error || `HTTP ${driveResponse.status}`}`,
          "GÜVENLİK: Bu denetim salt okunurdur. Hiçbir video yükleme, planlama, yorum ekleme/sabitleme veya mevcut yayın takvimini değiştirme. Kullanıcı istemedikçe bu denetim yalnızca rapor üretir.",
        ].join("\n");

        const namesBothTargetFiles =
          /video_11\.mp4[\s\S]{0,240}video_12\.mp4|video_12\.mp4[\s\S]{0,240}video_11\.mp4/iu.test(message);
        const hasUploadIntent =
          /(?:yükle|yükleme|planla|programla|yayına hazırla|işleme al|ilerle|tetikle)/iu.test(message) &&
          !/(?:yükleme|yükle|planla|programla).{0,35}(?:yapma|etme|dur|iptal|istemiyorum)|(?:sakın|kesinlikle).{0,25}(?:yükle|planla)/iu.test(message);
        const requestedCountMatch = message.match(/\b([2-4])\s*(?:tane\s*)?(?:video|shorts)|\b(iki|üç|uc|dört|dort)\s*(?:tane\s*)?(?:video|shorts)/iu);
        const wantsScheduledUploads =
          (hasUploadIntent && Boolean(requestedCountMatch) && /(?:kanal|youtube|drive|video|shorts)/iu.test(message)) ||
          (namesBothTargetFiles && hasUploadIntent) ||
          /(?:kanal|youtube|drive).{0,100}(?:yükle|yüklesin|planla|programla).{0,80}(?:iki|2)\s*(?:tane|adet)?|(?:iki|2)\s*(?:tane|adet).{0,100}(?:yükle|yüklesin|planla|programla)/iu.test(message);
        if (wantsScheduledUploads) {
          const scheduleText = [...history.map((item) => item.content), message].join("\n");
          const slots = requestedScheduleSlots(scheduleText);
          if (!slots) {
            const auditResult = await think(message, history, "", "flirty", `${memoryContext}\n\n${auditContext}`, "", privateMode);
            return NextResponse.json({
              reply: `${auditResult.reply || "Kanal analizi tamamlandı."}\n\nYükleme başlatmadım: konuşmada 2–4 adet geçerli, gelecekteki yayın saati açıkça bulunamadı. Hiçbir video yüklenmedi.`,
              emotion: auditResult.emotion || "focused",
            });
          }

          const selectionPrompt = [
            "Sadece JSON döndür; açıklama, markdown çiti veya başka metin yazma.",
            "Gerçek YouTube kanalındaki mevcut videolar ile Google Drive katalogunu karşılaştır.",
            `Kanalda bulunmayan, metadata bilgileri doğrulanabilen tam olarak ${slots.length} Shorts dosyası seç. Öncelik video_11.mp4, sonra video_12.mp4; bunlar zaten yüklenmişse sıradaki yüklenmemiş dosyaları seç.`,
            "Yalnızca baslik.md içeriğinden doğrulayabildiğin başlık, açıklama, etiket ve yorum bilgilerini kullan. Bir dosyanın metaverisi belirsizse onu seçme. Aynı videoyu tekrar yükleme.",
            "Şema: {\"videos\":[{\"fileName\":\"video_11.mp4\",\"title\":\"...\",\"description\":\"...\",\"tags\":[\"...\"],\"comment\":\"...\"},{...}]}. Tam olarak istenen sayıda farklı dosya olmalı; aksi durumda {\"videos\":[]} döndür.",
            auditContext,
          ].join("\n");
          const selection = await think(selectionPrompt, history, "", "flirty", memoryContext, "", privateMode);
          const jsonMatch = (selection.reply || "").match(/\{[\s\S]*\}/);
          let parsed: { videos?: Array<{ fileName?: string; title?: string; description?: string; tags?: string[]; comment?: string }> } = {};
          try { parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {}; } catch {}
          const candidates = Array.isArray(parsed.videos) ? parsed.videos : [];
          // The model may choose filenames, but metadata must come from the exact VIDEO N block in baslik.md.
          // Do not accept model-generated titles/descriptions/tags as proof of a file-to-metadata match.
          const validFiles = new Set((driveData.videos?.shorts || []).map((file) => file.name));
          const usable = candidates.flatMap((item) => {
            if (typeof item.fileName !== "string" || !validFiles.has(item.fileName)) return [];
            const numberMatch = item.fileName.match(/^video_(\d+)\.mp4$/iu);
            if (!numberMatch || !driveData.documentText) return [];
            try {
              const metadata = readDriveVideoMetadata(driveData.documentText, Number(numberMatch[1]));
              if (!metadata.title.trim() || !metadata.description.trim() || metadata.tags.length === 0) return [];
              return [{
                fileName: item.fileName,
                title: metadata.title,
                description: metadata.description,
                tags: metadata.tags,
                comment: metadata.pinnedComment,
              }];
            } catch {
              return [];
            }
          }).slice(0, slots.length);
          if (usable.length !== slots.length || new Set(usable.map((item) => item.fileName)).size !== usable.length) {
            return NextResponse.json({
              reply: "Kanal ve Drive analizini yaptım ancak istenen sayıdaki videonun başlık/açıklama/yorum eşleşmesini güvenilir biçimde doğrulayamadım. Güvenlik için hiçbir video yüklemedim.\n\n" + (selection.reply || ""),
              emotion: "focused",
            });
          }

          const plan = {
            slots,
            uploads: usable.map((candidate, index) => ({
              fileName: candidate.fileName,
              title: candidate.title.trim(),
              description: candidate.description,
              tags: candidate.tags,
              comment: candidate.comment,
              publishAt: slots[index],
            })),
          };
          const [pendingPlan] = await db.insert(operations).values({
            action: "youtube_drive_schedule_pending",
            status: "pending",
            summary: `Kullanıcı onayı bekleniyor: ${plan.uploads.length} Drive videosunun YouTube'da planlanması`,
            platform: "youtube",
            metadata: plan,
          }).returning({ id: operations.id });
          const planLines = plan.uploads.map((item, index) =>
            `${index + 1}. ${item.fileName} — ${item.title} — Türkiye saati: ${new Date(item.publishAt).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}`
          );
          return NextResponse.json({
            reply: [
              `${plan.uploads.length} video için planı hazırladım; henüz YouTube'a hiçbir dosya yüklenmedi.`,
              ...planLines,
              "Başlık, açıklama ve etiketler Drive'daki baslik.md içeriğine göre seçildi. Yükleme öncesinde dosya ve mükerrer kayıt kontrolleri yeniden yapılacak.",
              "Bu planı uygulamak için yeni mesaj olarak **Planı onayla** yaz. İptal etmek için **Planı iptal et** yaz.",
              `Onay kaydı: #${pendingPlan.id}. Plan 30 dakika içinde onaylanmazsa geçersiz sayılacak.`,
            ].join("\n"),
            emotion: "focused",
          });
        }

        const auditResult = await think(message, history, "", "flirty", `${memoryContext}\n\n${auditContext}`, "", privateMode);
        return NextResponse.json({
          reply: auditResult.reply || "Kanal verilerini aldım ancak güvenilir bir analiz oluşturamadım.",
          emotion: auditResult.emotion || "focused",
        });
      } catch (auditError) {
        const reason = auditError instanceof Error ? auditError.message : String(auditError);
        console.error("[Chat] YouTube channel audit failed:", reason);
        return NextResponse.json({
          reply: `Kanal analizi tamamlanamadı: ${reason.slice(0, 250)}. Analiz yapılmış gibi göstermeyeceğim.`,
          emotion: "focused",
        }, { status: 502 });
      }
    }

    // Read-only Google Drive access for natural chat requests.
    // OAuth being connected is not enough: explicitly fetch the catalog and pass its
    // verified contents into the model so Mira can answer from the real files.
    const asksAboutDriveFiles =
      /(?:google\s*drive|\bdrive\b|baslik\.md|başlık\s+dosyası|yayın\s+planı|yayin\s+plani|video\s+dosyaları|video\s+dosyalari|kalan\s+videolar|shorts\s+dosyaları|shorts\s+dosyalari|içerik|icerik|senaryo|mp4|video\s+(?:üret|uret|bul|dosyaları|dosyalari)|başlık|baslik|taslak|konu\s+(?:üret|uret|bul))/iu.test(message);

    if (asksAboutDriveFiles) {
      try {
        const origin = selfOrigin();
        const driveResponse = await fetchWithTimeoutMs(
          `${origin}/api/drive/catalog`,
          { headers: { cookie: cookieHeader } },
          15000,
        );
        const driveData = await driveResponse.json() as {
          ok?: boolean;
          error?: string;
          document?: { name?: string; characters?: number };
          documentText?: string;
          titleCandidates?: Array<{ line: number; kind: string; title: string }>;
          videos?: { shorts?: Array<{ name: string; id?: string }>; longVideos?: Array<{ name: string; id?: string }> };
        };

        if (!driveResponse.ok || !driveData.ok) {
          return NextResponse.json({
            reply: `Google Drive dosyalarını okuyamadım. Gerçek hata: ${driveData.error || `HTTP ${driveResponse.status}`}. Dosyalara eriştiğimi varsaymayacağım.`,
            emotion: "focused",
          }, { status: driveResponse.status >= 400 ? driveResponse.status : 502 });
        }

        const driveContext = [
          "GOOGLE DRIVE KATALOĞU — aşağıdaki veriler bu istekte canlı API'den okundu.",
          "Yalnızca bu verilerde bulunan gerçekleri kullan. Tarih veya video-başlık eşleşmesi belgede açıkça yoksa tahmin etme.",
          `Belge: ${driveData.document?.name || "baslik.md"}; karakter sayısı: ${driveData.document?.characters ?? 0}`,
          "Başlık satırları:",
          JSON.stringify(driveData.titleCandidates || []),
          "Shorts dosyaları:",
          JSON.stringify(driveData.videos?.shorts || []),
          "Uzun video dosyaları:",
          JSON.stringify(driveData.videos?.longVideos || []),
          "baslik.md tam metni:",
          driveData.documentText || "(Belge metni boş.)",
        ].join("\n");

        const driveResult = await think(
          message,
          history,
          "",
          "flirty",
          `${memoryContext}\n\n${driveContext}`,
          "",
          privateMode,
        );

        return NextResponse.json({
          reply: driveResult.reply || "Drive dosyalarını okudum ancak soruya güvenilir bir yanıt oluşturamadım.",
          emotion: driveResult.emotion || "focused",
        });
      } catch (driveError) {
        const reason = driveError instanceof Error ? driveError.message : String(driveError);
        console.error("[Chat] Google Drive read failed:", reason);
        return NextResponse.json({
          reply: `Google Drive okuma işlemi başarısız oldu: ${reason.slice(0, 220)}. İşlem yapılmış gibi göstermeyeceğim.`,
          emotion: "focused",
        }, { status: 502 });
      }
    }

    const result = await think(message, history, "", "flirty", memoryContext, "", privateMode);

    // Taslak kaydı yalnızca açık bir üretim isteğiyle yapılır; konu hakkında konuşmak,
    // taslakları listelemek veya "video üret" komutunu tartışmak kayıt başlatmaz.
        if (command === '/paylas-icerik' || /^\/paylas-icerik(?:\s|$)/iu.test(trimmedIntent)) {
      const topic = message.replace(/^\/paylas-icerik\s*/iu, "").trim();
      if (!topic) {
        return NextResponse.json({
          reply: "Lütfen bir konu belirt: `/paylas-icerik <konu>`\nÖrnek: `/paylas-icerik Karadelikler ve Zaman Bükülmesi`",
          emotion: "focused",
        });
      }
      const title = topic.slice(0, 160);
      try {
        if (await isPermanentlyDeletedTopic(db, [title, topic])) {
          return NextResponse.json({
            reply: `Bu konu ("${title}") daha önce kalıcı olarak silinmiş. Lütfen başka bir konu seç.`,
            emotion: "focused",
          });
        }
        const [draft] = await db.insert(contentItems).values({
          title,
          platform: "youtube_shorts",
          status: "queued",
          topic,
        }).returning();

        await db.insert(tasks).values({
          title: `Araştırma konusu: ${title}`,
          status: "pending",
          source: "mira_manual_topic",
          notes: JSON.stringify({ contentId: draft.id, topic, manualTopic: true }),
        });

        await db.insert(operations).values({
          action: "autonomous_content_draft",
          summary: `Mira standart şablon motoruna devretti (#${draft.id}): ${title}`,
          status: "queued",
          platform: draft.platform,
          metadata: { contentId: draft.id, topic, title, source: "chat_paylas_icerik" },
        });

        const origin = selfOrigin();
        const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "";
        fetch(`${origin}/api/automation/worker?contentId=${draft.id}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-mira-key": secret },
          body: JSON.stringify({ manualTopic: true }),
        }).catch((e) => console.error("[Chat/Paylas] Worker tetikleme hatası:", e));

        return NextResponse.json({
          reply: `🚀 **"${title}"** konusu standart Bilgi Dozu şablon motoruna devredildi (Taslak #${draft.id}).\n\n📌 9 zorunlu bölüm (KANCA, SESLENDİRME, EKRAN METNİ, GÖRSEL TASARIMI, SES VE MÜZİK, KAYNAK, AÇIKLAMA, ETİKETLER ve TASARIM JSON) hazırlanıyor ve kaynak doğrulaması yapılıyor.\n\nDurumu kontrol etmek için: \`/taslak ${draft.id}\` veya \`/taslak-list\``,
          emotion: "focused",
        });
      } catch (err) {
        console.error("[Chat/Paylas] Hata:", err);
        return NextResponse.json({
          reply: `❌ Konu kuyruğa alınırken veritabanı hatası oluştu: ${err instanceof Error ? err.message : String(err)}`,
          emotion: "focused",
        });
      }
    }

    const isShareContentCommand = /^\/paylas-icerik(?:\s|$)/iu.test(trimmedIntent);
    const hasExplicitDraftCommand =
      isShareContentCommand ||
      /^(?:(?:lütfen|bana)\s+)*(?:bir\s+)?(?:taslak|senaryo|içerik)\s+(?:oluştur|hazırla|üret|yaz)\s*[:：-]\s*\S/iu.test(trimmedIntent);
    // Prompt şablonları ve konu isteyen talimat metinleri içerik üretim komutu değildir.
    // Bunlar "yaz/üret", "Telegram" gibi kelimeler içerse bile taslak veya bildirim yan etkisi oluşturamaz.
    const isPromptTemplateOrClarification =
      /sen\s+(?:usta|uzman|profesyonel)\s+bir\s+.{0,120}(?:yazar(?:ısın|sın)?|yazarı)|thumb[\s-]?stop|hangi\s+konu\s+için|konuyu\s+ver|konu(?:yu)?\s+ver,?\s*hemen\s+yazayım/iu.test(trimmedIntent);
    // Explicit slash command is authoritative: topic questions like "astronotlar neden uzar?"
    // must still create a draft. Natural-language requests retain the discussion guard.
    const asksForContentDraft =
      !isPromptTemplateOrClarification &&
      (isShareContentCommand ||
        (!isDiscussionOrQuestion &&
          (hasExplicitDraftCommand ||
            (/\b(?:oluştur|hazırla|üret|yaz)\s*[.!…]*$/iu.test(trimmedIntent) &&
              /\b(?:taslak|shorts|reels|video|içerik|senaryo)\b/iu.test(trimmedIntent)))));
    // Telegram kelimesinin geçmesi tek başına gerçek mesaj gönderme yetkisi değildir.
    // Yalnızca açık gönderme/test isteğinde Telegram API çağrısı yapılır.
    const asksForTelegramNotification =
      !isPromptTemplateOrClarification &&
      /(?:telegram(?:'a|a)?\s+(?:bildirim|mesaj)\s+(?:gönder|yolla|at)|(?:bildirim|mesaj)\s+(?:gönder|yolla|at)\s+(?:telegram(?:'a|a)?|telegram üzerinden)|telegram\s+(?:bağlantısını|bildirimini)\s+test\s+et|telefonuma\s+bildirim\s+gönder|haber\s+ver\s+(?:telegramdan|telegram üzerinden))/iu.test(message);
    let hasUsableDraftReply =
      typeof result.reply === "string" &&
      result.reply.trim().length > 40 &&
      !/^Model bağlantısı başarısız:/iu.test(result.reply.trim());

    // Model metnindeki işlem iddiaları kanıt değildir. Sahte taslak numarası ve
    // gönderim başarı cümlelerini kaldır; gerçek başarıyı yalnızca aşağıdaki API/DB sonuçları ekler.
    const modelClaimedFakeAction =
      /taslak\s*(?:no|numarası|numara)\s*[:#]?\s*\d+|telegram\s+(?:bildirim(?:i|ini)?|mesaj(?:ı|ını)?)\s+(?:gönderildi|gönderdim|yollandı|atıldı|ilettim)|(?:taslak|bildirim)\s+(?:başarıyla\s+)?(?:kaydedildi|oluşturuldu|gönderildi)/iu.test(result.reply);
    result.reply = result.reply
      .replace(/[^\n]*(?:taslak\s*(?:no|numarası|numara)\s*[:#]?\s*\d+|telegram\s+(?:bildirim(?:i|ini)?|mesaj(?:ı|ını)?)\s+(?:gönderildi|gönderdim|yollandı|atıldı|ilettim)|(?:taslak|bildirim)\s+(?:başarıyla\s+)?(?:kaydedildi|oluşturuldu|gönderildi))[^\n]*(?:\n|$)/giu, "")
      .trim();
    if (!result.reply && modelClaimedFakeAction) {
      result.reply = "Bu işlem için doğrulanmış bir sonuç henüz yok; taslak veya Telegram gönderimi gerçekleşti diyemem.";
    } else if (modelClaimedFakeAction && !asksForContentDraft && !asksForTelegramNotification) {
      result.reply += "\n\nNot: Bu sohbette taslak kaydı veya Telegram gönderimi yapılmadı; bu işlem iddiası doğrulanmış değil.";
    }

    hasUsableDraftReply =
      hasUsableDraftReply &&
      !/^Bu işlem için doğrulanmış bir sonuç henüz yok/iu.test(result.reply);

    if (asksForContentDraft && hasUsableDraftReply) {
      const firstReplyHeading = result.reply.split(/\r?\n/u).map((line) => line.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/^\*\*(.*?)\*\*$/, "$1").trim()).find((line) => line.length > 0);
      const title = isShareContentCommand
        ? (firstReplyHeading || "Yeni YouTube Shorts taslağı").slice(0, 160)
        : message.trim().replace(/^(?:bana|lütfen)\s*/iu, "").slice(0, 160) || "Yeni YouTube Shorts taslağı";
      const topic = message.trim().replace(/^\/paylas-icerik\s*/iu, "").slice(0, 2000) || message.trim().slice(0, 2000);

      try {
        if (await isPermanentlyDeletedTopic(db, [title, topic])) {
          result.reply += "\n\nBu başlık/konu daha önce kalıcı olarak silindi; yeni taslak olarak kaydedilmedi.";
        } else {
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