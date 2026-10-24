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
  const { speak, stop, unlock, speaking, wordIndex, ampRef } = useSpeaker();

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
  const [voiceInterim, setVoiceInterim] = useState('');
  const [voiceReply, setVoiceReply] = useState('');
  const [subtitleVisible, setSubtitleVisible] = useState(false);
  const [subtitleSpeaker, setSubtitleSpeaker] = useState<'user' | 'kartal'>('kartal');
  const [waveTick, setWaveTick] = useState(0);
  const [waveAmp, setWaveAmp] = useState(0.1);
  const subtitleFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recRef = useRef<SpeechRec | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalTranscriptRef = useRef<string>('');
  const interimTranscriptRef = useRef<string>('');
  const manualStopRef = useRef<boolean>(false);

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
  const [livePopup, setLivePopup] = useState<{
    visible: boolean;
    badge: string;
    title: string;
    detail: string;
  } | null>(null);
  const popupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevStatsRef = useRef<Record<string, { likes: number; views: number }>>({});

  function triggerLeftPopup(badge: string, title: string, detail: string) {
    if (popupTimerRef.current) {
      clearTimeout(popupTimerRef.current);
    }
    setLivePopup({ visible: true, badge, title, detail });
    popupTimerRef.current = setTimeout(() => {
      setLivePopup((prev) => (prev ? { ...prev, visible: false } : null));
    }, 2800);
  }

  function evaluatePopupFromReport(rep: StatusReport, isManualOrInitial: boolean) {
    const vids: VideoItem[] = Array.isArray(rep?.videos) ? rep.videos : [];
    const prevMap = prevStatsRef.current;
    const hadPrev = Object.keys(prevMap).length > 0;
    let shown = false;

    for (const v of vids) {
      const prev = prevMap[v.id];
      if (prev && v.likes > prev.likes) {
        triggerLeftPopup(
          `❤️ +${v.likes - prev.likes} Yeni Beğeni!`,
          getShortCleanTitle(v.title).shortTitle,
          `Toplam ${v.likes} beğeni · ${v.views.toLocaleString('tr-TR')} izlenme`
        );
        shown = true;
        break;
      }
      if (prev && v.views > prev.views) {
        triggerLeftPopup(
          `👁️ +${v.views - prev.views} Yeni İzlenme!`,
          getShortCleanTitle(v.title).shortTitle,
          `Canlı: ${v.views.toLocaleString('tr-TR')} izlenme · ❤️ ${v.likes} beğeni`
        );
        shown = true;
        break;
      }
    }

    if ((!hadPrev || isManualOrInitial) && !shown) {
      const topLiked = vids.find((v) => v.likes > 0) || vids[0];
      if (topLiked) {
        triggerLeftPopup(
          `❤️ YouTube Canlı Beğeni Bildirimi`,
          getShortCleanTitle(topLiked.title).shortTitle,
          `👍 ${topLiked.likes} Beğeni · 👁️ ${topLiked.views.toLocaleString('tr-TR')} İzlenme`
        );
      }
    }

    const nextMap: Record<string, { likes: number; views: number }> = {};
    for (const v of vids) {
      nextMap[v.id] = { likes: v.likes, views: v.views };
    }
    prevStatsRef.current = nextMap;
  }

  async function loadStatus(force = true) {
    setLoading(true);
    setError('');
    try {
      const url = `/api/kartal/status?t=${Date.now()}${force ? '&force=1' : ''}`;
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'Veri çekilemedi');
      }
      const rep = data.report as StatusReport;
      setReport(rep);
      evaluatePopupFromReport(rep, force);
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
    const poll = (initial: boolean) => {
      fetch(`/api/kartal/status?t=${Date.now()}${initial ? '&force=1' : ''}`, { cache: 'no-store' })
        .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
        .then(({ ok, data }) => {
          if (!active) return;
          if (!ok || !data?.ok) {
            if (initial) setError(data?.error || 'Veri çekilemedi');
          } else {
            const rep = data.report as StatusReport;
            setReport(rep);
            evaluatePopupFromReport(rep, initial);
            if (data.last_telegram_time) {
              setLastTelegramTime(String(data.last_telegram_time));
            }
            setLastRefreshedAt(
              new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            );
            setError('');
          }
          if (initial) setLoading(false);
        })
        .catch((e) => {
          if (!active) return;
          if (initial) {
            setError(e instanceof Error ? e.message : 'Bağlantı hatası');
            setLoading(false);
          }
        });
    };
    poll(true);
    const timer = setInterval(() => poll(false), 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Canlı ses dalgası (waveform) animasyon döngüsü
  useEffect(() => {
    if (!voiceOpen) return;
    let raf = 0;
    let mounted = true;
    const loop = () => {
      if (!mounted) return;
      setWaveTick((t) => (t + 1) % 10000);
      setWaveAmp(ampRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
    };
  }, [voiceOpen, ampRef]);

  function scheduleSubtitleDissolve(delayMs = 1900) {
    if (subtitleFadeTimerRef.current) {
      clearTimeout(subtitleFadeTimerRef.current);
    }
    subtitleFadeTimerRef.current = setTimeout(() => {
      setSubtitleVisible(false);
    }, delayMs);
  }

  async function sendToKartalVoice(text: string) {
    const cleaned = text.trim();
    if (!cleaned || voiceThinking) return;
    unlock();
    stop();
    if (subtitleFadeTimerRef.current) {
      clearTimeout(subtitleFadeTimerRef.current);
    }
    setSubtitleSpeaker('user');
    setVoiceInterim(cleaned);
    setSubtitleVisible(true);
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
          : `Bilgi Dozu komuta merkezindeyim patron. Şu an ${report?.summary?.stock_shorts ?? 57} Shorts ve ${report?.summary?.stock_long ?? 10} Uzun Video stokta hazır.`;
      setVoiceInterim('');
      setVoiceReply(replyText);
      setSubtitleSpeaker('kartal');
      setSubtitleVisible(true);
      void speak(replyText, {
        solMode: 'close',
        emotion: 'happy',
        onEnd: () => {
          scheduleSubtitleDissolve(1800);
        },
      });
    } catch {
      const fallback = `Bilgi Dozu kanalımızda ${report?.summary?.total_videos_published ?? 58} video yayında, ${report?.summary?.stock_shorts ?? 57} Shorts stokta hazır patron.`;
      setVoiceInterim('');
      setVoiceReply(fallback);
      setSubtitleSpeaker('kartal');
      setSubtitleVisible(true);
      void speak(fallback, {
        solMode: 'close',
        emotion: 'happy',
        onEnd: () => {
          scheduleSubtitleDissolve(1800);
        },
      });
    } finally {
      setVoiceThinking(false);
    }
  }

  function handleToggleVoiceWidget() {
    unlock();
    if (voiceOpen) {
      stop();
      if (subtitleFadeTimerRef.current) {
        clearTimeout(subtitleFadeTimerRef.current);
      }
      try {
        recRef.current?.abort();
      } catch {
        // ignore
      }
      setVoiceListening(false);
      setSubtitleVisible(false);
      setVoiceOpen(false);
    } else {
      // İlk açılışta otomatik mikrofon izni istemez; Kartal alt-ortaya süzülür ve karşılama özetini sesli + canlı altyazılı söyler
      setVoiceOpen(true);
      const greeting = `Ben KartaL patron! Dün gece ${lastTelegramTime}'te video 33 yayına girdi. Şu an ${report?.summary?.stock_shorts ?? 57} Shorts ve ${report?.summary?.stock_long ?? 10} Uzun Video stokta hazır, sırada video 34 var.`;
      setVoiceReply(greeting);
      setSubtitleSpeaker('kartal');
      setSubtitleVisible(true);
      void speak(greeting, {
        solMode: 'close',
        emotion: 'happy',
        onEnd: () => {
          scheduleSubtitleDissolve(1800);
        },
      });
    }
  }

  function finishAndSendSpeech() {
    manualStopRef.current = true;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    try {
      recRef.current?.stop();
    } catch {
      // ignore
    }
    setVoiceListening(false);
    const fullText = (finalTranscriptRef.current + ' ' + interimTranscriptRef.current).replace(/\s+/g, ' ').trim();
    finalTranscriptRef.current = '';
    interimTranscriptRef.current = '';
    setVoiceInterim('');
    if (fullText) {
      void sendToKartalVoice(fullText);
    }
  }

  function resetSilenceTimer() {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }
    // 5.5 saniye boyunca yeni kelime gelmezse konuşma tamamlandı kabul edip gönderir
    silenceTimerRef.current = setTimeout(() => {
      finishAndSendSpeech();
    }, 5500);
  }

  function handleTapOrb() {
    unlock();
    if (speaking) {
      stop();
      return;
    }
    if (voiceListening) {
      finishAndSendSpeech();
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
    manualStopRef.current = false;
    finalTranscriptRef.current = '';
    interimTranscriptRef.current = '';
    setVoiceInterim('');

    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = 'tr-TR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      setVoiceListening(true);
      resetSilenceTimer();
    };
    rec.onresult = (ev: SREvent) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const chunk = ev.results[i][0]?.transcript || '';
        if (ev.results[i].isFinal) {
          finalTranscriptRef.current += ' ' + chunk;
        } else {
          interim += chunk;
        }
      }
      interimTranscriptRef.current = interim;
      const preview = (finalTranscriptRef.current + ' ' + interim).replace(/\s+/g, ' ').trim();
      if (preview) {
        if (subtitleFadeTimerRef.current) clearTimeout(subtitleFadeTimerRef.current);
        setSubtitleSpeaker('user');
        setVoiceInterim(preview);
        setSubtitleVisible(true);
      }
      resetSilenceTimer();
    };
    rec.onerror = () => {
      if (manualStopRef.current) {
        setVoiceListening(false);
      }
    };
    rec.onend = () => {
      // Tarayıcı 2 saniyelik nefes arasında kendi kendine kapattıysa ve henüz 5.5 sn sessizlik dolmadıysa yeniden başlat
      if (!manualStopRef.current && silenceTimerRef.current) {
        try {
          rec.start();
          return;
        } catch {
          // ignore
        }
      }
      setVoiceListening(false);
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
          <div className="space-y-4">
            <div className="space-y-4">
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

      {/* SAYFANIN EN ALT-ORTA BÖLÜMÜNDE SÜZÜLEN YAPAY ZEKA KARTAL + SES DALGASI + AKIŞKAN ALTYAZI HUD */}
      {voiceOpen && (() => {
        const isActive = speaking || voiceListening || voiceThinking;
        const rawAmp = speaking
          ? Math.min(1, Math.max(0.22, waveAmp * 2.5))
          : voiceListening
            ? 0.55
            : voiceThinking
              ? 0.35
              : 0.08;

        // Konuşurken ve dinlerken Kartal'ın üstündeki parıltıların renk değiştirmesi ve parlaması
        const hueShift = speaking
          ? Math.round(Math.sin(waveTick * 0.14) * 48 + rawAmp * 35)
          : voiceListening
            ? Math.round(Math.sin(waveTick * 0.1) * 35 - 25)
            : voiceThinking
              ? Math.round((waveTick * 4) % 360)
              : 0;
        const brightness = isActive ? 1.08 + rawAmp * 0.32 : 1.02;
        const saturate = isActive ? 1.25 + rawAmp * 0.55 : 1.08;
        const floatY = Math.sin(waveTick * 0.06) * (isActive ? 5 : 2.5);
        const eagleScale = 1 + (speaking ? rawAmp * 0.07 : voiceListening ? 0.03 : 0);

        // Sese duyarlı aktif cümle / kelime penceresi (cümle bitince akışkan silinir)
        const words = voiceReply ? voiceReply.split(/\s+/).filter(Boolean) : [];
        let activeChunkWords: string[] = [];
        let activeLocalIdx = -1;
        if (subtitleSpeaker === 'kartal' && words.length > 0) {
          const chunkSize = 10;
          const safeWordIdx = wordIndex >= 0 ? Math.min(wordIndex, words.length - 1) : 0;
          const chunkStart = Math.floor(safeWordIdx / chunkSize) * chunkSize;
          activeChunkWords = words.slice(chunkStart, chunkStart + chunkSize);
          activeLocalIdx = wordIndex >= 0 ? safeWordIdx - chunkStart : -1;
        }

        // Kartal üzerindeki canlı parıltı (sparkle) koordinatları
        const sparkles = [
          { x: '18%', y: '28%', phase: 0.0, size: 7 },
          { x: '31%', y: '44%', phase: 1.3, size: 6 },
          { x: '50%', y: '56%', phase: 2.4, size: 11 },
          { x: '69%', y: '44%', phase: 3.7, size: 6 },
          { x: '82%', y: '28%', phase: 4.9, size: 7 },
          { x: '24%', y: '62%', phase: 2.1, size: 5 },
          { x: '76%', y: '62%', phase: 0.8, size: 5 },
          { x: '50%', y: '24%', phase: 3.1, size: 6 },
        ];

        return (
          <div
            className="fixed bottom-3 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center pointer-events-none select-none w-full max-w-2xl px-4"
            aria-live="polite"
          >
            {/* 1. ÜST KATMAN: ŞEFFAF HOLOGRAM KARTAL (KONUŞUNCA PARILTILARI PARLAR VE RENK DEĞİŞTİRİR) */}
            <div className="relative flex flex-col items-center pointer-events-auto">
              {/* Zarif kapatma düğmesi */}
              <button
                type="button"
                onClick={handleToggleVoiceWidget}
                title="KartaL Sesli Asistanı Kapat"
                className="absolute -right-2 top-1 z-20 flex h-6 w-6 items-center justify-center rounded-full border border-sky-400/40 bg-white/85 text-[11px] font-bold text-sky-800 shadow-sm backdrop-blur-xs transition hover:scale-110 hover:bg-sky-50"
              >
                ✕
              </button>

              <button
                type="button"
                onClick={handleTapOrb}
                title={
                  speaking
                    ? 'KartaL konuşuyor (Susturmak için dokun)'
                    : voiceListening
                      ? 'Seni dinliyor (Göndermek için dokun)'
                      : 'KartaL ile konuşmak için dokun'
                }
                style={{
                  transform: `translateY(${floatY}px) scale(${eagleScale})`,
                }}
                className="relative flex items-center justify-center focus:outline-none transition-transform duration-100 active:scale-95"
              >
                {/* Şeffaf Hologram Kartal Görseli */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/kartal-hologram.png"
                  alt="KartaL AI Hologram"
                  style={{
                    filter: `hue-rotate(${hueShift}deg) brightness(${brightness}) saturate(${saturate}) drop-shadow(0 0 ${
                      isActive ? Math.round(12 + rawAmp * 18) : 6
                    }px ${
                      voiceListening
                        ? 'rgba(16,185,129,0.75)'
                        : speaking
                          ? 'rgba(14,165,233,0.85)'
                          : 'rgba(56,189,248,0.35)'
                    })`,
                  }}
                  className="w-64 sm:w-80 h-auto object-contain pointer-events-none select-none transition-[filter] duration-100"
                />

                {/* Konuşurken & Dinlerken Kartal Üzerinde Parlayan ve Renk Değiştiren Parıltılar */}
                {isActive &&
                  sparkles.map((sp, idx) => {
                    const pulse = 0.5 + 0.5 * Math.sin(waveTick * 0.24 + sp.phase);
                    const colorList = ['#38bdf8', '#facc15', '#34d399', '#e879f9'];
                    const col = colorList[(idx + Math.floor(waveTick / 8)) % colorList.length];
                    return (
                      <span
                        key={idx}
                        style={{
                          left: sp.x,
                          top: sp.y,
                          width: `${sp.size + pulse * 6 * rawAmp}px`,
                          height: `${sp.size + pulse * 6 * rawAmp}px`,
                          backgroundColor: col,
                          opacity: 0.35 + pulse * 0.65,
                          boxShadow: `0 0 ${8 + pulse * 14}px ${col}, 0 0 ${16 + pulse * 20}px ${col}`,
                          transform: `translate(-50%, -50%) scale(${0.7 + pulse * 0.8})`,
                        }}
                        className="pointer-events-none absolute rounded-full transition-transform duration-75"
                      />
                    );
                  })}
              </button>
            </div>

            {/* 2. ORTA KATMAN: ARKASINDA FON OLMAYAN ŞEFFAF HOLOGRAM SES DALGASI (ALTIN + CAMGÖBEĞİ) */}
            <div className="-mt-2 flex items-center justify-center pointer-events-none">
              <svg
                viewBox="0 0 360 54"
                className="w-64 sm:w-72 h-12 overflow-visible"
                style={{
                  filter: `hue-rotate(${Math.round(hueShift * 0.6)}deg) drop-shadow(0 0 6px rgba(14,165,233,0.45))`,
                }}
              >
                {/* Merkez İnce Enerji Ekseni */}
                <line
                  x1="16"
                  y1="27"
                  x2="344"
                  y2="27"
                  stroke="#0ea5e9"
                  strokeWidth="1.2"
                  opacity="0.55"
                />

                {/* Akışkan Sinüs Dalgaları (Camgöbeği & Altın) */}
                {(() => {
                  const ptsCyan: string[] = [];
                  const ptsGold: string[] = [];
                  for (let x = 20; x <= 340; x += 6) {
                    const nx = (x - 180) / 145;
                    const env = Math.exp(-2.6 * nx * nx);
                    const amp = isActive ? 4 + rawAmp * 18 : 2.5;
                    const y1 = 27 + Math.sin(nx * 8 - waveTick * 0.22) * amp * env;
                    const y2 = 27 + Math.cos(nx * 6.5 + waveTick * 0.18) * (amp * 0.85) * env;
                    ptsCyan.push(`${x},${y1.toFixed(1)}`);
                    ptsGold.push(`${x},${y2.toFixed(1)}`);
                  }
                  return (
                    <>
                      <polyline
                        fill="none"
                        stroke="#06b6d4"
                        strokeWidth="1.8"
                        opacity="0.85"
                        points={ptsCyan.join(' ')}
                      />
                      <polyline
                        fill="none"
                        stroke="#eab308"
                        strokeWidth="1.5"
                        opacity="0.8"
                        points={ptsGold.join(' ')}
                      />
                    </>
                  );
                })()}

                {/* Uçları Noktalı Hologram Frekans Çubukları */}
                {Array.from({ length: 31 }).map((_, idx) => {
                  const bx = 30 + idx * 10;
                  const nx = (bx - 180) / 140;
                  const env = Math.exp(-2.4 * nx * nx);
                  const wv =
                    0.55 * Math.abs(Math.sin(idx * 0.48 - waveTick * 0.24)) +
                    0.45 * Math.abs(Math.cos(idx * 0.31 + waveTick * 0.16));
                  const halfH = isActive
                    ? Math.max(2, wv * 21 * env * (0.45 + rawAmp * 0.85))
                    : Math.max(1.5, wv * 5 * env);
                  const isGold = idx % 3 === 1;
                  const barColor = isGold ? '#eab308' : '#06b6d4';
                  const tipColor = isGold ? '#0ea5e9' : '#f59e0b';
                  return (
                    <g key={idx}>
                      <line
                        x1={bx}
                        y1={27 - halfH}
                        x2={bx}
                        y2={27 + halfH}
                        stroke={barColor}
                        strokeWidth="2.2"
                        strokeLinecap="round"
                      />
                      {halfH > 4 && (
                        <>
                          <circle cx={bx} cy={27 - halfH - 2.2} r="1.7" fill={tipColor} />
                          <circle cx={bx} cy={27 + halfH + 2.2} r="1.7" fill={tipColor} />
                        </>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* 3. ALT KATMAN: ARKASINDA FON OLMAYAN, SESE DUYARLI VE CÜMLE BİTİNCE ERİYEREK SİLİNEN ALTYAZI */}
            <div
              className={`mt-0.5 min-h-[34px] max-w-xl text-center transition-all duration-700 ease-out ${
                subtitleVisible && (voiceInterim || activeChunkWords.length > 0)
                  ? 'opacity-100 translate-y-0 blur-0 scale-100'
                  : 'opacity-0 translate-y-1.5 blur-[3px] scale-95 pointer-events-none'
              }`}
            >
              {subtitleSpeaker === 'user' && voiceInterim ? (
                <p
                  style={{
                    textShadow:
                      '0 0 12px rgba(255,255,255,0.98), 0 0 6px rgba(255,255,255,0.95), 0 1px 8px rgba(16,185,129,0.35)',
                  }}
                  className="text-sm sm:text-[15px] font-bold tracking-tight text-emerald-700"
                >
                  {voiceInterim}
                </p>
              ) : activeChunkWords.length > 0 ? (
                <p
                  style={{
                    textShadow:
                      '0 0 14px rgba(255,255,255,0.98), 0 0 6px rgba(255,255,255,0.98), 0 2px 10px rgba(14,165,233,0.3)',
                  }}
                  className="text-sm sm:text-[15px] font-bold tracking-tight text-[#0369A1] leading-snug"
                >
                  {activeChunkWords.map((w, i) => (
                    <span
                      key={i}
                      className={`mr-1.5 transition-colors duration-150 ${
                        i === activeLocalIdx
                          ? 'text-[#D97706] font-extrabold'
                          : i < activeLocalIdx
                            ? 'text-[#075985]'
                            : 'text-[#0284C7]'
                      }`}
                    >
                      {w}
                    </span>
                  ))}
                </p>
              ) : null}
            </div>
          </div>
        );
      })()}

      {/* EKRANIN SOL TARAFINDA SAYDAM YOUTUBE BEĞENİ / ETKİLEŞİM POPUP'I (2.8 SN GÖRÜNÜP KAYBOLUR) */}
      {livePopup && (
        <div
          className={`fixed left-5 bottom-7 z-50 pointer-events-none transition-all duration-500 ease-out ${
            livePopup.visible
              ? 'opacity-100 translate-x-0 scale-100'
              : 'opacity-0 -translate-x-5 scale-95'
          }`}
        >
          <div className="flex max-w-xs items-start gap-3 rounded-2xl border border-white/25 bg-slate-900/65 px-4 py-3 text-white shadow-2xl backdrop-blur-md">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-rose-500/80 text-sm shadow">
              ❤️
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold tracking-wide text-rose-300">
                {livePopup.badge}
              </div>
              <div className="mt-0.5 truncate text-xs font-semibold text-white">
                {livePopup.title}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-200/90">
                {livePopup.detail}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
