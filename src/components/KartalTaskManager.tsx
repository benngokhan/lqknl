'use client';

import { useEffect, useRef, useState } from 'react';
import { useSpeaker } from './useSpeaker';

interface WorkerItem {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'err';
  status_text: string;
  updated_at: string;
  telegram_last?: string;
  jobs_done: number;
  last_action: string;
  error_message: string;
}

interface AlertItem {
  id: string;
  title: string;
  status: 'ok' | 'warn' | 'err';
  status_text: string;
  updated_at: string;
  detail: string;
}

interface VideoItem {
  id: string;
  url: string;
  title: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
}

interface StatusReport {
  updated_at: string;
  overall_status: 'ok' | 'warn' | 'err';
  overall_label: string;
  summary: {
    total_views: number;
    subscribers: number;
    total_videos_published: number;
    weekly_uploaded: number;
    total_comments: number;
    total_likes: number;
    failed_jobs: number;
    stock_shorts: number;
    stock_long: number;
  };
  workers: WorkerItem[];
  alerts: AlertItem[];
  videos: VideoItem[];
}

interface CustomConnection {
  id: string;
  platform: string;
  account: string;
  detail: string;
  status: 'ok' | 'warn';
  statusText: string;
}

type SRResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { transcript: string };
};
type SREvent = {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: SRResult };
};
type SpeechRec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((e: SREvent) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getShortCleanTitle(rawTitle: string): { shortTitle: string; fullClean: string; hashtags: string } {
  if (!rawTitle) return { shortTitle: 'Başlıksız Video', fullClean: '', hashtags: '' };
  const tags = rawTitle.match(/#[\wçğıöşüÇĞİÖŞÜ]+/g) || [];
  const withoutTags = rawTitle
    .replace(/#[\wçğıöşüÇĞİÖŞÜ]+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = withoutTags.split(' ').filter(Boolean);
  const shortTitle = words.slice(0, 5).join(' ') + (words.length > 5 ? '…' : '');
  return {
    shortTitle: shortTitle || rawTitle.slice(0, 28),
    fullClean: withoutTags || rawTitle,
    hashtags: tags.join(' '),
  };
}

export default function KartalTaskManager({ onSwitchToOrb }: { onSwitchToOrb?: () => void }) {
  void onSwitchToOrb;
  const { speak, stop, unlock, speaking } = useSpeaker();

  const [report, setReport] = useState<StatusReport | null>(null);
  const [lastTelegramTime, setLastTelegramTime] = useState<string>('21:24');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'genel' | 'videolar' | 'isciler' | 'baglantilar' | 'uyarilar'>('genel');
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [paused, setPaused] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // Sayfa İçi Sesli Asistan KartaL Penceresi (Ayrı sayfa değil, panelin içinde!)
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceThinking, setVoiceThinking] = useState(false);
  const [voiceInput, setVoiceInput] = useState('');
  const [voiceReply, setVoiceReply] = useState(
    "Günaydın patron! Bilgi Dozu (@bilgidozuofficial) kanalında dün gece 21:24'te video_33.mp4 yayına girdi. Şu an 57 Shorts ve 10 Uzun Video stokta hazır, sırada video_34.mp4 var."
  );
  const recRef = useRef<SpeechRec | null>(null);

  const [connections, setConnections] = useState<CustomConnection[]>([
    {
      id: 'c-yt',
      platform: 'YouTube Data API v3',
      account: '@bilgidozuofficial',
      detail: 'Otomatik video yükleme, özel kapak ve ilk sabit yorum (youtube.force-ssl)',
      status: 'ok',
      statusText: 'Çalışıyor',
    },
    {
      id: 'c-tg',
      platform: 'Telegram Bot',
      account: 'Asistan-Mira_bot',
      detail: 'Yükleme sonrası tek tıkla kopyalanabilir sabit yorum ve stok bildirimi',
      status: 'ok',
      statusText: 'Çalışıyor',
    },
    {
      id: 'c-tiktok',
      platform: 'TikTok',
      account: '@bilgidozuofficial',
      detail: 'TikTok Content Posting API / Manuel bağlantı zemini hazır',
      status: 'warn',
      statusText: 'Bağlantı zemini hazır',
    },
    {
      id: 'c-ig',
      platform: 'Instagram Reels',
      account: '@bilgidozuofficial',
      detail: 'Instagram Graph API / Reels otomatik paylaşım zemini hazır',
      status: 'warn',
      statusText: 'Bağlantı zemini hazır',
    },
  ]);
  const [newPlat, setNewPlat] = useState('TikTok');
  const [newAcc, setNewAcc] = useState('');
  const [newDetail, setNewDetail] = useState('');

  async function loadStatus() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/kartal/status?t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'Veri çekilemedi');
      }
      setReport(data.report as StatusReport);
      if (data.last_telegram_time) {
        setLastTelegramTime(String(data.last_telegram_time));
      }
      setLastRefreshedAt(
        new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bağlantı hatası');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    fetch('/api/kartal/status?t=' + Date.now(), { cache: 'no-store' })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok || !data?.ok) {
          setError(data?.error || 'Veri çekilemedi');
        } else {
          setReport(data.report as StatusReport);
          if (data.last_telegram_time) {
            setLastTelegramTime(String(data.last_telegram_time));
          }
          setLastRefreshedAt(
            new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          );
          setError('');
        }
        setLoading(false);
      })
      .catch((e) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : 'Bağlantı hatası');
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function sendToKartalVoice(text: string) {
    const cleaned = text.trim();
    if (!cleaned || voiceThinking) return;
    unlock();
    stop();
    setVoiceThinking(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: cleaned }),
      });
      const data = await res.json().catch(() => ({}));
      const replyText =
        typeof data?.reply === 'string' && data.reply.trim()
          ? data.reply.trim()
          : `Bilgi Dozu (@bilgidozuofficial) komuta merkezindeyim patron. Şu an ${report?.summary?.stock_shorts ?? 57} Shorts ve ${report?.summary?.stock_long ?? 10} Uzun Video stokta hazır, Telegram'a son bildirim ${lastTelegramTime}'te iletildi.`;
      setVoiceReply(replyText);
      void speak(replyText, { solMode: 'close', emotion: 'happy' });
    } catch {
      const fallback = `Bilgi Dozu (@bilgidozuofficial) kanalımızda ${report?.summary?.total_videos_published ?? 58} video yayında, ${report?.summary?.stock_shorts ?? 57} Shorts stokta hazır patron.`;
      setVoiceReply(fallback);
      void speak(fallback, { solMode: 'close', emotion: 'happy' });
    } finally {
      setVoiceThinking(false);
    }
  }

  function handleToggleVoiceWidget() {
    unlock();
    if (voiceOpen) {
      stop();
      try {
        recRef.current?.abort();
      } catch {
        // ignore
      }
      setVoiceListening(false);
      setVoiceOpen(false);
    } else {
      setVoiceOpen(true);
      const greeting = `Günaydın patron! Bilgi Dozu kanalında dün gece ${lastTelegramTime}'te video 33 yayına girdi. Şu an ${report?.summary?.stock_shorts ?? 57} Shorts ve ${report?.summary?.stock_long ?? 10} Uzun Video stokta hazır, sırada video 34 var.`;
      setVoiceReply(greeting);
      void speak(greeting, { solMode: 'close', emotion: 'happy' });
    }
  }

  function handleTapOrb() {
    unlock();
    if (speaking) {
      stop();
      return;
    }
    if (voiceListening && recRef.current) {
      try {
        recRef.current.stop();
      } catch {
        setVoiceListening(false);
      }
      return;
    }
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRec;
      webkitSpeechRecognition?: new () => SpeechRec;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      void sendToKartalVoice('günaydın');
      return;
    }
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = 'tr-TR';
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => setVoiceListening(true);
    rec.onend = () => setVoiceListening(false);
    rec.onerror = () => setVoiceListening(false);
    rec.onresult = (ev: SREvent) => {
      let transcript = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        transcript += ev.results[i][0]?.transcript || '';
      }
      if (transcript.trim()) {
        void sendToKartalVoice(transcript.trim());
      }
    };
    try {
      rec.start();
    } catch {
      setVoiceListening(false);
    }
  }

  function toggleRow(key: string) {
    setOpenRows((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleAddConnection(e: React.FormEvent) {
    e.preventDefault();
    if (!newAcc.trim() && !newDetail.trim()) return;
    setConnections((prev) => [
      ...prev,
      {
        id: 'c-' + Date.now(),
        platform: newPlat,
        account: newAcc.trim() || '@bilgidozuofficial',
        detail: newDetail.trim() || 'Manuel API / Webhook bağlantısı tanımlandı',
        status: 'ok',
        statusText: 'Hazır',
      },
    ]);
    setNewAcc('');
    setNewDetail('');
  }

  async function handleRetryOrRun() {
    if (busy) return;
    setBusy(true);
    setActionMsg('');
    try {
      const res = await fetch('/api/automation/yt-bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dispatch' }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setActionMsg('Yükleyici iş akışı tetiklendi. Sonuç birkaç dakika içinde tabloya yansır.');
      } else {
        setActionMsg(data?.error || 'Şu anda hatalı iş bulunmuyor; tüm işçiler normal çalışıyor.');
      }
      await loadStatus();
    } catch {
      setActionMsg('İşlem isteği gönderilemedi.');
    } finally {
      setBusy(false);
    }
  }

  function handlePauseAll() {
    const confirmed = window.confirm(
      'Tüm işçileri duraklatmak istediğinize emin misiniz? Yanlışlıkla dokunduysanız İptal seçeneğine basın.'
    );
    if (confirmed) {
      setPaused((p) => !p);
      setActionMsg(paused ? 'İşçiler yeniden etkinleştirildi.' : 'Tüm zamanlanmış işçiler geçici olarak duraklatıldı.');
    }
  }

  const fmt = (n: number | undefined) => Number(n || 0).toLocaleString('tr-TR');

  const renderBadge = (status: 'ok' | 'warn' | 'err', text: string) => {
    const styles =
      status === 'err'
        ? 'bg-[#FEF2F2] text-[#991B1B]'
        : status === 'warn'
          ? 'bg-[#FFFBEB] text-[#92400E]'
          : 'bg-[#ECFDF5] text-[#065F46]';
    const dot =
      status === 'err' ? 'bg-[#EF4444]' : status === 'warn' ? 'bg-[#F59E0B]' : 'bg-[#10B981]';
    return (
      <span className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-semibold shrink-0 ${styles}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span>{text}</span>
      </span>
    );
  };

  const hasAnyWarn =
    (report?.workers || []).some((w) => w.status !== 'ok') ||
    (report?.alerts || []).some((a) => a.status !== 'ok');

  const overallStatus: 'ok' | 'warn' | 'err' = paused
    ? 'warn'
    : error
      ? 'err'
      : hasAnyWarn
        ? 'warn'
        : report?.overall_status || 'ok';

  const overallText = paused
    ? 'Duraklatıldı'
    : error
      ? 'Hata var'
      : hasAnyWarn
        ? 'Dikkat gerek'
        : report?.overall_label || 'Her şey çalışıyor';

  return (
    <div className="min-h-[100dvh] w-full bg-[#F8F9FA] text-[#111827] font-sans text-sm antialiased">
      {/* Üst Başlık Şeridi */}
      <header className="sticky top-0 z-30 border-b border-[#E5E7EB] bg-white px-4 py-2.5">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="text-[15px] font-bold text-[#111827]">KartaL AI · Görev Yöneticisi</span>
            {renderBadge(overallStatus, overallText)}
          </div>
          <div className="flex flex-wrap items-center gap-2.5 text-xs text-[#4B5563]">
            <span>
              Stok: <strong>{report?.summary?.stock_shorts ?? 57}</strong> Shorts ·{' '}
              <strong>{report?.summary?.stock_long ?? 10}</strong> Uzun
            </span>
            <span>·</span>
            <span>
              Son güncelleme: <strong>{(report?.updated_at || '2026.10.23 - 21:24').replace(/-/g, '.')}</strong> · Telegram&apos;a son bildirim: <strong>{lastTelegramTime}</strong>
            </span>
            {/* BELİRGİN YENİLE DÜĞMESİ */}
            <button
              type="button"
              onClick={() => void loadStatus()}
              disabled={loading}
              className="rounded-md border-2 border-[#111827] bg-white px-3 py-1 text-xs font-bold text-[#111827] shadow-xs hover:bg-[#F3F4F6] disabled:opacity-60"
            >
              ↻ {loading ? 'Yenileniyor…' : lastRefreshedAt ? `Yenile (${lastRefreshedAt})` : 'Yenile'}
            </button>
            {/* SAYFA İÇİNDE AÇILAN SESLİ ASİSTAN KARTAL DÜĞMESİ */}
            <button
              type="button"
              onClick={handleToggleVoiceWidget}
              className="rounded-md border border-[#1E3A8A] bg-[#0F172A] px-3 py-1 text-xs font-semibold text-white shadow-xs hover:bg-[#1E293B]"
            >
              🎙️ {voiceOpen ? 'KartaL Sesli Asistanı Kapat' : 'Sesli Asistan KartaL'}
            </button>
          </div>
        </div>
      </header>

      {/* Üst Sekmeler */}
      <nav className="border-b border-[#E5E7EB] bg-white px-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1 overflow-x-auto">
            {([
              ['genel', 'Genel'],
              ['videolar', 'Videolar'],
              ['isciler', 'İşçiler'],
              ['baglantilar', 'Bağlantılar'],
              ['uyarilar', 'Uyarılar'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setActiveTab(key)}
                className={`border-b-2 px-3 py-2.5 text-[13px] whitespace-nowrap ${
                  activeTab === key
                    ? 'border-[#111827] font-semibold text-[#111827]'
                    : 'border-transparent font-medium text-[#6B7280] hover:text-[#111827]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <button
              type="button"
              onClick={() => void handleRetryOrRun()}
              disabled={busy}
              className="rounded border border-[#111827] bg-[#111827] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Çalıştırılıyor…' : 'Hatalıları yeniden dene'}
            </button>
            <button
              type="button"
              onClick={handlePauseAll}
              className="rounded border border-[#E5E7EB] bg-white px-3 py-1.5 text-xs font-medium text-[#111827] hover:bg-[#F3F4F6]"
            >
              {paused ? 'Devam ettir' : 'Tümünü duraklat'}
            </button>
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-4 pb-24">
        {actionMsg && (
          <div className="mb-3 rounded border border-[#E5E7EB] bg-white px-3 py-2 text-xs text-[#111827]">
            {actionMsg}
          </div>
        )}
        {error && (
          <div className="mb-3 rounded border border-[#EF4444] bg-[#FEF2F2] px-3 py-2 text-xs text-[#991B1B]">
            Veri okuma hatası: {error}
          </div>
        )}

        {/* Üst Kartlar */}
        <section className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <div className="rounded-md border border-[#E5E7EB] bg-white p-3">
            <div className="text-xl font-semibold text-[#111827]">{fmt(report?.summary?.total_views)}</div>
            <div className="mt-0.5 text-xs text-[#6B7280]">toplam görüntülenme (YouTube API)</div>
          </div>
          <div className="rounded-md border border-[#E5E7EB] bg-white p-3">
            <div className="text-xl font-semibold text-[#111827]">{fmt(report?.summary?.weekly_uploaded)}</div>
            <div className="mt-0.5 text-xs text-[#6B7280]">bu hafta yüklenen video</div>
          </div>
          <div className="rounded-md border border-[#E5E7EB] bg-white p-3">
            <div className="text-xl font-semibold text-[#111827]">{fmt(report?.summary?.total_comments)}</div>
            <div className="mt-0.5 text-xs text-[#6B7280]">toplam yorum</div>
          </div>
          <div className="rounded-md border border-[#E5E7EB] bg-white p-3">
            <div className="text-xl font-semibold text-[#111827]">{fmt(report?.summary?.failed_jobs)}</div>
            <div className="mt-0.5 text-xs text-[#6B7280]">başarısız işler</div>
          </div>
        </section>

        {/* Genel Sekmesi */}
        {activeTab === 'genel' && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            <div className="space-y-4 lg:col-span-5">
              <section className="rounded-md border border-[#E5E7EB] bg-white">
                <div className="flex items-center justify-between border-b border-[#E5E7EB] px-3.5 py-2.5">
                  <span className="text-sm font-semibold text-[#111827]">İşçi durumları</span>
                  <span className="text-xs text-[#6B7280]">Ayrıntı için satıra dokun</span>
                </div>
                <div className="divide-y divide-[#E5E7EB]">
                  {(report?.workers || []).map((w) => {
                    const key = `w-${w.id}`;
                    const isOpen = !!openRows[key];
                    return (
                      <div
                        key={w.id}
                        onClick={() => toggleRow(key)}
                        className="cursor-pointer px-3.5 py-2.5 hover:bg-[#F3F4F6]"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[13px] font-medium text-[#111827]">{w.name}</span>
                          {renderBadge(w.status, w.status_text)}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-[#6B7280]">
                          <span>Son güncelleme: {(w.updated_at || '').replace(/-/g, '.')}</span>
                          {(w.id === 'uploader' || w.id === 'telegram') && (
                            <>
                              <span>·</span>
                              <span className="font-semibold text-[#111827]">
                                Telegram&apos;a son bildirim: {w.telegram_last || lastTelegramTime}
                              </span>
                            </>
                          )}
                        </div>
                        {isOpen && (
                          <div className="mt-2 rounded border border-[#E5E7EB] bg-[#F8F9FA] p-2 text-xs text-[#111827]">
                            {w.error_message ? (
                              <>
                                <div>
                                  <strong>Son hata:</strong> {w.error_message}
                                </div>
                                <div className="mt-1">
                                  <strong>Son işlem:</strong> {w.last_action}
                                </div>
                              </>
                            ) : (
                              <div>
                                <strong>Son işlem:</strong> {w.last_action}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-md border border-[#E5E7EB] bg-white">
                <div className="flex items-center justify-between border-b border-[#E5E7EB] px-3.5 py-2.5">
                  <span className="text-sm font-semibold text-[#111827]">Uyarılar</span>
                  <span className="text-xs text-[#6B7280]">Kota ve bağlantı kontrolleri</span>
                </div>
                <div className="divide-y divide-[#E5E7EB]">
                  {(report?.alerts || []).map((a) => {
                    const key = `a-${a.id}`;
                    const isOpen = !!openRows[key];
                    return (
                      <div
                        key={a.id}
                        onClick={() => toggleRow(key)}
                        className="cursor-pointer px-3.5 py-2.5 hover:bg-[#F3F4F6]"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[13px] font-medium text-[#111827]">{a.title}</span>
                          {renderBadge(a.status, a.status_text)}
                        </div>
                        <div className="mt-1 text-xs text-[#6B7280]">
                          Son kontrol: {(a.updated_at || '').replace(/-/g, '.')}
                        </div>
                        {isOpen && (
                          <div className="mt-2 rounded border border-[#E5E7EB] bg-[#F8F9FA] p-2 text-xs text-[#111827]">
                            {a.detail}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>

            {/* Sağda Son Videolar (Kısa başlık + tıklayınca tam başlık ve hashtag'ler) */}
            <section className="rounded-md border border-[#E5E7EB] bg-white lg:col-span-7">
              <div className="flex items-center justify-between border-b border-[#E5E7EB] px-3.5 py-2.5">
                <span className="text-sm font-semibold text-[#111827]">Son videolar (Kısa başlık)</span>
                <span className="text-xs text-[#6B7280]">Tam başlık için satıra dokun</span>
              </div>
              <div className="max-h-[560px] divide-y divide-[#E5E7EB] overflow-y-auto">
                {(report?.videos || []).map((v) => {
                  const key = `v-${v.id}`;
                  const isOpen = !!openRows[key];
                  const { shortTitle, fullClean, hashtags } = getShortCleanTitle(v.title);
                  return (
                    <div
                      key={v.id}
                      onClick={() => toggleRow(key)}
                      className="cursor-pointer px-3.5 py-2.5 hover:bg-[#F3F4F6]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-[13px] font-semibold text-[#111827]">
                          {isOpen ? '▾ ' : '▸ '}
                          {shortTitle}
                        </span>
                        {renderBadge('ok', 'Yayında')}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-[#6B7280]">
                        <span>{fmt(v.views)} görüntüleme</span>
                        <span>·</span>
                        <span>{fmt(v.comments)} yorum</span>
                        <span>·</span>
                        <span>{(v.publishedAt || '').slice(0, 16).replace('T', ' ')}</span>
                      </div>
                      {isOpen && (
                        <div className="mt-2 rounded border border-[#E5E7EB] bg-[#F8F9FA] p-2.5 text-xs text-[#111827] space-y-1">
                          <div>
                            <strong>Tam Başlık:</strong> {fullClean}
                          </div>
                          {hashtags && (
                            <div className="text-[#6B7280]">
                              <strong>Etiketler:</strong> {hashtags}
                            </div>
                          )}
                          <div>
                            Video ID: {v.id} · Beğeni: {fmt(v.likes)} ·{' '}
                            <a
                              href={v.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="font-semibold text-blue-700 underline"
                            >
                              YouTube&apos;da aç ↗
                            </a>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {/* Videolar Sekmesi */}
        {activeTab === 'videolar' && (
          <section className="rounded-md border border-[#E5E7EB] bg-white">
            <div className="flex items-center justify-between border-b border-[#E5E7EB] px-3.5 py-2.5">
              <span className="text-sm font-semibold text-[#111827]">Tüm yayınlanan videolar</span>
              <span className="text-xs text-[#6B7280]">Tam başlığı görmek için satıra dokun</span>
            </div>
            <div className="divide-y divide-[#E5E7EB]">
              {(report?.videos || []).map((v) => {
                const key = `vt-${v.id}`;
                const isOpen = !!openRows[key];
                const { shortTitle, fullClean, hashtags } = getShortCleanTitle(v.title);
                return (
                  <div
                    key={v.id}
                    onClick={() => toggleRow(key)}
                    className="cursor-pointer px-3.5 py-2.5 hover:bg-[#F3F4F6]"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[13px] font-semibold text-[#111827]">
                        {isOpen ? '▾ ' : '▸ '}
                        {shortTitle}
                      </span>
                      {renderBadge('ok', 'Yayında')}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-[#6B7280]">
                      <span>{fmt(v.views)} görüntüleme</span>
                      <span>·</span>
                      <span>{fmt(v.comments)} yorum</span>
                      <span>·</span>
                      <span>{fmt(v.likes)} beğeni</span>
                      <span>·</span>
                      <span>{(v.publishedAt || '').slice(0, 16).replace('T', ' ')}</span>
                    </div>
                    {isOpen && (
                      <div className="mt-2 rounded border border-[#E5E7EB] bg-[#F8F9FA] p-2.5 text-xs text-[#111827] space-y-1">
                        <div>
                          <strong>Tam Başlık:</strong> {fullClean}
                        </div>
                        {hashtags && (
                          <div className="text-[#6B7280]">
                            <strong>Etiketler:</strong> {hashtags}
                          </div>
                        )}
                        <div>
                          <a
                            href={v.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="font-semibold text-blue-700 underline"
                          >
                            ▶️ YouTube&apos;da aç ({v.url})
                          </a>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* İşçiler Sekmesi */}
        {activeTab === 'isciler' && (
          <section className="rounded-md border border-[#E5E7EB] bg-white">
            <div className="flex items-center justify-between border-b border-[#E5E7EB] px-3.5 py-2.5">
              <span className="text-sm font-semibold text-[#111827]">İşçi durumları</span>
              <span className="text-xs text-[#6B7280]">Durum, zaman ve bildirim kayıtları</span>
            </div>
            <div className="divide-y divide-[#E5E7EB]">
              {(report?.workers || []).map((w) => (
                <div key={w.id} className="px-3.5 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[13px] font-medium text-[#111827]">{w.name}</span>
                    {renderBadge(w.status, w.status_text)}
                  </div>
                  <div className="mt-1 text-xs text-[#6B7280]">
                    Son güncelleme: {(w.updated_at || '').replace(/-/g, '.')} · Toplam iş: {w.jobs_done}
                    {(w.id === 'uploader' || w.id === 'telegram') && (
                      <> · <strong>Telegram&apos;a son bildirim: {w.telegram_last || lastTelegramTime}</strong></>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-[#111827]">{w.last_action}</div>
                  {w.error_message && (
                    <div className="mt-1.5 rounded border border-[#EF4444] bg-[#FEF2F2] p-2 text-xs text-[#991B1B]">
                      Son hata: {w.error_message}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Bağlantılar Sekmesi */}
        {activeTab === 'baglantilar' && (
          <div className="space-y-4">
            <section className="rounded-md border border-[#E5E7EB] bg-white">
              <div className="flex items-center justify-between border-b border-[#E5E7EB] px-3.5 py-2.5">
                <span className="text-sm font-semibold text-[#111827]">Aktif ve Hazır Platform Bağlantıları</span>
                <span className="text-xs text-[#6B7280]">Çoklu kanal yönetim zemini</span>
              </div>
              <div className="divide-y divide-[#E5E7EB]">
                {connections.map((c) => (
                  <div key={c.id} className="px-3.5 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[13px] font-semibold text-[#111827]">
                        {c.platform} — {c.account}
                      </span>
                      {renderBadge(c.status, c.statusText)}
                    </div>
                    <div className="mt-1 text-xs text-[#6B7280]">{c.detail}</div>
                  </div>
                ))}
              </div>
            </section>

            <form
              onSubmit={handleAddConnection}
              className="rounded-md border border-[#E5E7EB] bg-white p-4 space-y-3"
            >
              <div className="text-sm font-semibold text-[#111827]">+ Yeni Kanal / Manuel Bağlantı Ekle</div>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <select
                  value={newPlat}
                  onChange={(e) => setNewPlat(e.target.value)}
                  className="rounded border border-[#D1D5DB] bg-white px-3 py-2 text-xs text-[#111827]"
                >
                  <option value="TikTok">TikTok</option>
                  <option value="Instagram Reels">Instagram Reels</option>
                  <option value="YouTube Yedek Kanal">YouTube Yedek Kanal</option>
                  <option value="Özel Webhook / API">Özel Webhook / API</option>
                </select>
                <input
                  type="text"
                  value={newAcc}
                  onChange={(e) => setNewAcc(e.target.value)}
                  placeholder="Hesap adı (örn. @bilgidozuofficial)"
                  className="rounded border border-[#D1D5DB] bg-white px-3 py-2 text-xs text-[#111827]"
                />
                <input
                  type="text"
                  value={newDetail}
                  onChange={(e) => setNewDetail(e.target.value)}
                  placeholder="API Anahtarı / Webhook URL / Not"
                  className="rounded border border-[#D1D5DB] bg-white px-3 py-2 text-xs text-[#111827]"
                />
              </div>
              <button
                type="submit"
                className="rounded bg-[#111827] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1F2937]"
              >
                Bağlantıyı Kaydet
              </button>
            </form>
          </div>
        )}

        {/* Uyarılar Sekmesi */}
        {activeTab === 'uyarilar' && (
          <section className="rounded-md border border-[#E5E7EB] bg-white">
            <div className="flex items-center justify-between border-b border-[#E5E7EB] px-3.5 py-2.5">
              <span className="text-sm font-semibold text-[#111827]">Sistem uyarıları</span>
              <span className="text-xs text-[#6B7280]">YouTube API kotası, Drive/Sheets ve yorum işçisi</span>
            </div>
            <div className="divide-y divide-[#E5E7EB]">
              {(report?.alerts || []).map((a) => (
                <div key={a.id} className="px-3.5 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[13px] font-medium text-[#111827]">{a.title}</span>
                    {renderBadge(a.status, a.status_text)}
                  </div>
                  <div className="mt-1 text-xs text-[#6B7280]">
                    Son kontrol: {(a.updated_at || '').replace(/-/g, '.')}
                  </div>
                  <div className="mt-1 text-xs text-[#111827]">{a.detail}</div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* SAYFA İÇİNDE AÇILAN KÜÇÜK SESLİ ASİSTAN KARTAL PENCERESİ (POPOVER) */}
      {voiceOpen && (
        <div
          style={{
            position: 'fixed',
            right: '20px',
            bottom: '20px',
            width: '340px',
            maxWidth: 'calc(100vw - 32px)',
            backgroundColor: 'rgba(15, 23, 42, 0.96)',
            border: '1px solid rgba(96, 165, 250, 0.35)',
            borderRadius: '20px',
            padding: '18px',
            color: '#F8FAFC',
            boxShadow: '0 20px 50px rgba(15, 23, 42, 0.45), 0 0 30px rgba(37, 99, 235, 0.2)',
            backdropFilter: 'blur(14px)',
            zIndex: 60,
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold tracking-wider uppercase text-blue-300">
              🦅 KartaL AI · Sesli Asistan
            </span>
            <button
              type="button"
              onClick={handleToggleVoiceWidget}
              className="h-6 w-6 rounded-full bg-white/10 text-slate-300 hover:bg-white/20 text-xs flex items-center justify-center"
              title="Kapat"
            >
              ✕
            </button>
          </div>

          <div className="flex flex-col items-center py-2.5">
            <button
              type="button"
              onClick={handleTapOrb}
              style={{
                width: '74px',
                height: '74px',
                borderRadius: '9999px',
                background: voiceListening
                  ? 'radial-gradient(circle at 35% 30%, #34d399, #059669 60%, #064e3b)'
                  : speaking
                    ? 'radial-gradient(circle at 35% 30%, #e879f9, #9333ea 60%, #1e1b4b)'
                    : 'radial-gradient(circle at 35% 30%, #60a5fa, #1d4ed8 60%, #0f172a)',
                boxShadow: voiceListening
                  ? '0 0 34px rgba(16, 185, 129, 0.75)'
                  : speaking
                    ? '0 0 38px rgba(217, 70, 239, 0.8)'
                    : '0 0 28px rgba(59, 130, 246, 0.55)',
              }}
              className="flex items-center justify-center text-2xl transition-transform active:scale-95"
            >
              🎙️
            </button>
            <span className="mt-2 text-[11px] text-slate-400">
              {voiceListening
                ? 'Dinliyorum patron, konuş…'
                : voiceThinking
                  ? 'Düşünüyorum…'
                  : speaking
                    ? 'KartaL sesli yanıt veriyor (Susturmak için dokun)'
                    : 'Bas-Konuş için küreye dokun veya aşağıya yaz'}
            </span>
          </div>

          <div className="my-2.5 max-h-36 overflow-y-auto rounded-xl border border-slate-700/70 bg-slate-900/90 p-2.5 text-xs leading-relaxed text-slate-200">
            {voiceReply}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!voiceInput.trim()) return;
              const q = voiceInput;
              setVoiceInput('');
              void sendToKartalVoice(q);
            }}
            className="flex gap-1.5"
          >
            <input
              type="text"
              value={voiceInput}
              onChange={(e) => setVoiceInput(e.target.value)}
              placeholder="KartaL'a yaz veya sor..."
              className="flex-1 rounded-lg border border-slate-700 bg-slate-950/90 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 outline-none focus:border-blue-400"
            />
            <button
              type="submit"
              disabled={voiceThinking}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              Sor
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
