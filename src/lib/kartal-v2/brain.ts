/** KartaL: small, auditable intent router. All capabilities are injected; the model never runs tools. */
export type Turn = { role: 'user' | 'assistant'; content: string };
export type Source = { title: string; url: string };
export type ResearchHit = { title: string; snippet: string; url: string };
export type Reply = { ok: boolean; reply: string; kind: string; sources?: Source[]; performed?: boolean };
export type Services = {
  model: (message: string, history: Turn[]) => Promise<string | null>;
  research: (query: string) => Promise<ResearchHit[]>;
  workers: () => Promise<string>;
  drive: (query: string) => Promise<string>;
  createTask: (title: string) => Promise<string>;
};

function fold(s: string): string {
  return s.normalize('NFKC').toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

// The :free suffix on an OpenRouter *router* is not a free-price guarantee.
export function safeOpenRouterModel(value: string): boolean {
  return value === 'openrouter/free' || (/^[a-z0-9._-]+\/[a-z0-9._-]+:free$/i.test(value) && !value.toLowerCase().startsWith('openrouter/'));
}

export function hasCredential(s: string): boolean {
  return /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|sifre|şifre|password)\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9._-]{16,})/iu.test(s);
}

export type Intent = { kind: 'hello' | 'research' | 'workers' | 'drive' | 'task' | 'video' | 'blocked' | 'device' | 'reminder' | 'chat'; argument?: string };

export function classify(message: string): Intent {
  const raw = message.normalize('NFKC').trim();
  const n = fold(raw);
  if (/^(?:hey )?(?:kartal|selam|merhaba|gunaydin|iyi aksamlar|iyi gunler)[!.?\s]*$/.test(n)) return { kind: 'hello' };
  if (/\bvideo\s+(?:uret|uretelim|olustur|hazirla|yap)\b/.test(n)) return { kind: 'video' };
  // Never convert a language-model suggestion into a privileged action.
  if (/\b(?:sil|silelim|silinsin|cop[e]? at|hesabi kapat|odem[e]? yap|para gonder|havale|sat[i]?n al|yay[i]?nla|paylas|mesaj gonder|mail gonder|e.?posta gonder|yukle|sifreyi degistir)\b/.test(n)) return { kind: 'blocked' };
  const task = raw.match(/^\s*(?:görev\s+ekle|gorev\s+ekle)(?:\s*[:：-]\s*|\s+)(.{1,250})$/iu);
  if (task) return { kind: 'task', argument: task[1].trim() };
  if (/\b(?:hatirlat|hatirlatir|hatirlatacak|uyandir)\w*/.test(n) || /\balarm\w*.*\b(?:kur|ayarla)/.test(n)) return { kind: 'reminder' };
  if (/\b(?:isci\w*|worker\w*|workflow\w*|is akisi\w*)/.test(n) && /\b(?:durum\w*|kontrol\w*|nasil|liste\w*|sonuc\w*)/.test(n)) return { kind: 'workers' };
  if (/\b(?:google )?drive\b/.test(n) && /\b(?:dosya\w*|klasor\w*|liste\w*|stok\w*|ara|bul|durum\w*)/.test(n)) {
    const tail = raw.replace(/^.*?\bdrive(?:['’]?(?:daki|deki|dan|den|da|de))?/iu, '').trim();
    const argument = tail.split(/\s+/).filter((word) => {
      const w = fold(word).replace(/^[^\w]+|[^\w]+$/g, '');
      return w && !/^(?:dosya\w*|klasor\w*|liste\w*|goster\w*|ara|bul|durum\w*|stok\w*|lutfen|nedir|nasil)$/.test(w);
    }).join(' ');
    return { kind: 'drive', argument };
  }
  if (((/\b(?:telefonda|tablette|telefona|tablete|cihazda)\b/.test(n)) || (/\b(?:chrome|youtube|whatsapp|instagram|telegram|kamera)\b/.test(n))) && /\b(?:ac|git|dokun|tikla|yaz|uygulama|kapat)\b/.test(n)) return { kind: 'device' };
  const wiki = /(?:[iİ]nternet(?:te|ten)?|web(?:de|den)?|wikipedia|vikipedi|google(?:da|de)?)\s+(?:hakkinda\s+)?(.+?)(?:\s+(?:arastir|ara|bul|ara ve ozetle|ara ve anlat))?[.!?\s]*$/iu.exec(raw);
  if (wiki && /\b(?:arastir|ara|bul|vikipedi|wikipedia)\b/.test(n)) {
    const query = wiki[1].replace(/\s+(?:araştır|ara|bul|ara ve özetle|ara ve anlat)[.!?\s]*$/iu, '').trim();
    if (query) return { kind: 'research', argument: query.slice(0, 200) };
  }
  return { kind: 'chat' };
}

export function sanitizeHistory(value: unknown): Turn[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Turn => Boolean(item) && typeof item === 'object' &&
    ((item as Turn).role === 'user' || (item as Turn).role === 'assistant') && typeof (item as Turn).content === 'string')
    .slice(-12).map((item) => ({ role: item.role, content: item.content.trim().slice(0, 1800) }))
    .filter((item) => item.content && !hasCredential(item.content));
}

export async function handleKartal(messageValue: unknown, historyValue: unknown, svc: Services): Promise<Reply> {
  if (typeof messageValue !== 'string' || !messageValue.trim()) return { ok: false, kind: 'input', reply: 'Bir mesaj yaz veya konuş.' };
  const message = messageValue.trim();
  if (message.length > 3000) return { ok: false, kind: 'input', reply: 'Mesaj çok uzun; 3000 karaktere kadar yaz.' };
  if (hasCredential(message)) return { ok: false, kind: 'sensitive', reply: 'Şifre ve anahtarları sohbete yazma. Resmî bağlantı veya ayarlar ekranını kullan.' };
  const intent = classify(message);
  try {
    if (intent.kind === 'hello') return { ok: true, kind: 'hello', reply: 'Buradayım reis. Bana yazabilir veya konuşabilirsin.' };
    if (intent.kind === 'video') return { ok: true, kind: 'video', reply: 'Video üretimini bu panelden başlatmıyorum. Senin belirlediğin Arena tetikleme düzeni korunuyor; şu an video üretilmedi.', performed: false };
    if (intent.kind === 'blocked') return { ok: true, kind: 'blocked', reply: 'Bu işlem para, silme, yayın veya dışa gönderim içerebilir. Buradan otomatik yapmadım; açık onay ve uygun bağlantı gerekir.', performed: false };
    if (intent.kind === 'device') return { ok: true, kind: 'device', reply: 'Tablet işlemine doğrudan erişimim henüz doğrulanmadı; uygulamayı açmadım ve ekrana dokunmadım.', performed: false };
    if (intent.kind === 'reminder') return { ok: true, kind: 'reminder', reply: 'Bu sohbetten alarm veya bildirim kuramıyorum; hatırlatma ayarlanmadı. İstersen görev kaydı tutabilirim, ancak bu bildirim göndermez.', performed: false };
    if (intent.kind === 'task') {
      const title = intent.argument || '';
      if (!title || hasCredential(title)) return { ok: false, kind: 'input', reply: 'Görev başlığını kontrol et; şifre veya anahtar ekleme.' };
      const created = await svc.createTask(title);
      return { ok: true, kind: 'task', reply: `Görev kaydedildi: ${created}. Bu kayıt tek başına telefon bildirimi oluşturmaz.`, performed: true };
    }
    if (intent.kind === 'workers') return { ok: true, kind: 'workers', reply: await svc.workers(), performed: false };
    if (intent.kind === 'drive') return { ok: true, kind: 'drive', reply: await svc.drive(intent.argument || ''), performed: false };
    if (intent.kind === 'research') {
      const hits = await svc.research(intent.argument || '');
      if (!hits.length) return { ok: true, kind: 'research', reply: `“${intent.argument}” için kaynak bulamadım. Farklı bir arama dene.`, sources: [] };
      const lines = hits.slice(0, 4).map((hit, i) => `${i + 1}. ${hit.title}: ${hit.snippet}`);
      return { ok: true, kind: 'research', reply: `Vikipedi'de bulduklarım:\n${lines.join('\n')}\n\nBunlar arama özetleridir; ayrıntılar için kaynakları aç.`, sources: hits.slice(0, 4).map(({ title, url }) => ({ title, url })) };
    }
    const answer = await svc.model(message, sanitizeHistory(historyValue));
    if (!answer || !answer.trim()) return { ok: false, kind: 'unavailable', reply: 'Yapay zekâ bağlantısı şu an meşgul veya erişilemiyor. Ücretsiz model kotası dolmuş olabilir; biraz sonra yeniden dene. Hiçbir işlem yapılmadı.' };
    const clean = answer.trim().slice(0, 5000);
    if (hasCredential(clean)) return { ok: false, kind: 'sensitive', reply: 'Yanıtta hassas bilgi olabileceği için göstermedim.' };
    // Action claims from a model are not evidence of real side effects.
    const foldedAnswer = fold(clean);
    if (/\b(?:sildim|yayinladim|yukledim|gonderdim|odeme yaptim|hatirlatici kurdum)\b/.test(foldedAnswer) || /\b(?:uygulama|dosya|video|gorev|hatirlatici|alarm)\w*.{0,50}\b(?:actim|kapattim|tasidim|olusturdum|ekledim|kurdum)\b/.test(foldedAnswer)) {
      return { ok: true, kind: 'chat', reply: 'Bu sohbet yanıtıyla cihazda, dosyada veya hesapta bir işlem yapılmadı. İşlem isteğini açıkça belirtirsen hangi bağlantının gerektiğini söyleyebilirim.', performed: false };
    }
    return { ok: true, kind: 'chat', reply: clean, performed: false };
  } catch {
    if (intent.kind === 'task') return { ok: false, kind: 'task', reply: 'Görev kaydının sonucu doğrulanamadı. Tekrar eklemeden önce görev listesini kontrol et.', performed: false };
    return { ok: false, kind: intent.kind, reply: 'İstenen bağlantı veya araç şu anda yanıt vermedi. İşlem tamamlandı demeyeceğim; yeniden deneyebilirsin.', performed: false };
  }
}
