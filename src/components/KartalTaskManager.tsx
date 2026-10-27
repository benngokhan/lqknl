'use client';

import { useEffect, useRef, useState } from 'react';
import { useSpeaker } from './useSpeaker';
import { PAYLASIM_KITLERI } from '../data/paylasim_kitleri';

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

interface GhWorkflow {
  id: number;
  name: string;
  state: string;
  path: string;
}

interface GhRun {
  id: number;
  runNumber: number;
  workflowName: string;
  event: string;
  conclusion: string | null;
  createdAt: string;
  durationSec: number | null;
  displayTitle: string;
  htmlUrl: string;
}

interface GhRepoBlock {
  key: string;
  repo: string;
  label: string;
  url: string;
  error?: string;
  workflows: GhWorkflow[];
  runs: GhRun[];
}

interface GhRunsResponse {
  ok: boolean;
  fetchedAt: string;
  repos: GhRepoBlock[];
}

export default function KartalTaskManager({ onSwitchToOrb }: { onSwitchToOrb?: () => void }) {
  void onSwitchToOrb;
  const { speak, stop, unlock, speaking, wordIndex, ampRef } = useSpeaker();

  const [report, setReport] = useState<StatusReport | null>(null);
  const [lastTelegramTime, setLastTelegramTime] = useState<string>('21:24');
  const [lastUploadFile, setLastUploadFile] = useState<string>('');
  const [lastUploadUrl, setLastUploadUrl] = useState<string>('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'genel' | 'videolar' | 'paylasim' | 'isciler' | 'baglantilar' | 'uyarilar' | 'github'>('genel');
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [paused, setPaused] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // Menü / "Şimdi paylaş" paneli
  const [morePanelOpen, setMorePanelOpen] = useState(false);
  const [ghRuns, setGhRuns] = useState<GhRunsResponse | null>(null);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghError, setGhError] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadType, setUploadType] = useState<'auto' | 'short' | 'long'>('auto');
  const [uploadDryRun, setUploadDryRun] = useState(false);

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
  const restartBudgetRef = useRef<number>(4); // dıgıdı spam'ini yok eden sınır: her dinleme turunda 4 geri alma hakkı

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
          `+${v.likes - prev.likes} yeni beğeni`,
          getShortCleanTitle(v.title).shortTitle,
          `Toplam ${v.likes} beğeni · ${v.views.toLocaleString('tr-TR')} izlenme`
        );
        shown = true;
        break;
      }
      if (prev && v.views > prev.views) {
        triggerLeftPopup(
          `+${v.views - prev.views} yeni izlenme`,
          getShortCleanTitle(v.title).shortTitle,
          `Canlı: ${v.views.toLocaleString('tr-TR')} izlenme · ${v.likes} beğeni`
        );
        shown = true;
        break;
      }
    }

    if ((!hadPrev || isManualOrInitial) && !shown) {
      const topLiked = vids.find((v) => v.likes > 0) || vids[0];
      if (topLiked) {
        triggerLeftPopup(
          `YouTube canlı beğeni bildirimi`,
          getShortCleanTitle(topLiked.title).shortTitle,
          `${topLiked.likes} beğeni · ${topLiked.views.toLocaleString('tr-TR')} izlenme`
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
      if (data.last_upload_file) {
        setLastUploadFile(String(data.last_upload_file));
        setLastUploadUrl(String(data.last_upload_url || ''));
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
            if (data.last_upload_file) {
              setLastUploadFile(String(data.last_upload_file));
              setLastUploadUrl(String(data.last_upload_url || ''));
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
      const sonDosya = lastUploadFile || '';
      const sonNo = /video_(\d+)/.exec(sonDosya)?.[1] || '';
      const siraNo = sonNo ? `video_${Number(sonNo) + 1}` : '';
      const greeting = sonDosya
        ? `Ben KartaL kanka! Kanalda en son ${sonDosya} yayına girdi. Stokta ${report?.summary?.stock_shorts ?? ''} Shorts ve ${report?.summary?.stock_long ?? ''} Uzun Video hazır duruyor${siraNo ? `, sıradaki ${siraNo}` : ''}. Bugünkü otomatik turlar 14:15, 18:15 ve 21:15'te. Ne bakalım?`
        : `Ben KartaL kanka! Bugünkü otomatik yayın turları 14:15, 18:15 ve 21:15'te. Ne bakalım?`;
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

  // Android Chrome'da ardışık tekrarlanan kelimeleri ("iyiyim iyiyim iyiyim" -> "iyiyim") temizler
  function cleanRepeatedSpeechWords(raw: string): string {
    const tokens = raw.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const out: string[] = [];
    for (const tok of tokens) {
      const prev = out[out.length - 1];
      if (prev && prev.toLocaleLowerCase('tr-TR') === tok.toLocaleLowerCase('tr-TR')) {
        continue;
      }
      out.push(tok);
    }
    return out.join(' ');
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
    const fullText = cleanRepeatedSpeechWords(
      (finalTranscriptRef.current + ' ' + interimTranscriptRef.current).replace(/\s+/g, ' ').trim()
    );
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
    // Konuşma durduktan 2.8 sn sonra cümleyi tamamlayıp gönderir (sürekli yeniden başlatma yapmaz)
    silenceTimerRef.current = setTimeout(() => {
      finishAndSendSpeech();
    }, 2800);
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
    restartBudgetRef.current = 4;
    finalTranscriptRef.current = '';
    interimTranscriptRef.current = '';
    setVoiceInterim('');

    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = 'tr-TR';
    // Android Chrome'da "dıgıdı dıgıdı" yeniden başlatma bildirimini ve kelime tekrarını önlemek için continuous=false
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      setVoiceListening(true);
      resetSilenceTimer();
    };
    rec.onresult = (ev: SREvent) => {
      restartBudgetRef.current = 4; // gerçek konuşma algılandıkça bütçe tazelenir
      let latestFinal = '';
      let latestInterim = '';
      for (let i = 0; i < ev.results.length; i++) {
        const chunk = ev.results[i][0]?.transcript || '';
        if (ev.results[i].isFinal) {
          latestFinal = chunk;
        } else {
          latestInterim = chunk;
        }
      }
      if (latestFinal) {
        finalTranscriptRef.current = cleanRepeatedSpeechWords(latestFinal);
      }
      interimTranscriptRef.current = cleanRepeatedSpeechWords(latestInterim);
      const preview = cleanRepeatedSpeechWords(
        (finalTranscriptRef.current || interimTranscriptRef.current).replace(/\s+/g, ' ').trim()
      );
      if (preview) {
        if (subtitleFadeTimerRef.current) clearTimeout(subtitleFadeTimerRef.current);
        setSubtitleSpeaker('user');
        setVoiceInterim(preview);
        setSubtitleVisible(true);
      }
      resetSilenceTimer();
    };
    rec.onerror = () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      setVoiceListening(false);
    };
    rec.onend = () => {
      // BÜTÇELİ cankurtaran: mobil Chrome'un nefes arasına otomatik kapanmasına karşı
      // en fazla 4 geri alma (~4x150ms) — dıgıdı spam'ine dönüş YASAK.
      if (!manualStopRef.current && restartBudgetRef.current > 0) {
        restartBudgetRef.current -= 1;
        window.setTimeout(() => {
          if (!manualStopRef.current) {
            try {
              rec.start();
            } catch {
              // yutulur
            }
          }
        }, 150);
        return;
      }
      if (!manualStopRef.current) {
        finishAndSendSpeech();
      } else {
        setVoiceListening(false);
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
    const confirmed = window.confirm(
      'Yükleyici işçisi hemen çalıştırılsın mı? Sıradaki video zamanlanmış saati beklemeden yüklenecek.'
    );
    if (!confirmed) return;
    setBusy(true);
    setActionMsg('');
    try {
      const res = await fetch('/api/automation/yt-bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upload_now', videoType: 'auto' }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setActionMsg(data.message || 'Yükleyici iş akışı tetiklendi. Sonuç birkaç dakika içinde tabloya yansır.');
      } else {
        setActionMsg(data?.error || 'Yükleyici başlatılamadı.');
      }
      await loadStatus();
    } catch {
      setActionMsg('İstek gönderilemedi.');
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

  async function handleUploadNow() {
    if (busy) return;
    setBusy(true);
    setActionMsg('');
    setUploadOpen(false);
    try {
      const res = await fetch('/api/automation/yt-bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: uploadDryRun ? 'dry_run' : 'upload_now', videoType: uploadType }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setActionMsg(data.message || (uploadDryRun ? 'Dry-run doğrulama akışı başlatıldı.' : 'Yükleme işçisi başlatıldı.'));
        void loadStatus(false);
      } else {
        setActionMsg(data?.error || 'İşçi başlatılamadı.');
      }
    } catch {
      setActionMsg('İstek gönderilemedi.');
    } finally {
      setBusy(false);
    }
  }

  function confirmUploadNow() {
    const kind = uploadType === 'long' ? 'uzun video' : uploadType === 'short' ? 'Short' : 'otomatik (prime-time)';
    const message = uploadDryRun
      ? `Dry-run (sadece test) çalıştırılacak: ${kind}. Video yüklenmez; tablo ve Drive bağlantısı doğrulanır. Emin misin?`
      : `Sıradaki video HEMEN yüklenecek (${kind}) — zamanlanmış saat beklemeden. Emin misin?`;
    if (!window.confirm(message)) return;
    void handleUploadNow();
  }

  async function handleTelegramTest() {
    if (busy) return;
    const confirmed = window.confirm(
      "Telegram'a test mesajı gönderilsin mi? Sohbetine '✅ Mira Telegram test bildirimi' düşmeli."
    );
    if (!confirmed) return;
    setBusy(true);
    setActionMsg('');
    try {
      const res = await fetch('/api/automation/telegram-test', { method: 'POST' });
      const data = await res.json().catch(() => null);
      setActionMsg(
        res.ok && data?.ok
          ? 'Telegram test mesajı gönderildi.'
          : data?.error || 'Telegram testi başarısız oldu.'
      );
    } catch {
      setActionMsg('Telegram test isteği gönderilemedi.');
    } finally {
      setBusy(false);
    }
  }

  const fmtDate = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
    const now = new Date();
    const hm = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    if (sameDay(d, now)) return `Bugün ${hm}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, yesterday)) return `Dün ${hm}`;
    return `${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} ${hm}`;
  };

  const fmt = (n: number | undefined) => Number(n || 0).toLocaleString('tr-TR');

  const fmtDur = (sec?: number | null) => {
    if (!sec || sec < 1) return '—';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}dk ${s}sn` : `${s}sn`;
  };

  async function loadGithubRuns(force = false) {
    if (ghLoading) return;
    if (ghRuns && !force) return;
    setGhLoading(true);
    setGhError('');
    try {
      const res = await fetch('/api/automation/github-runs', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || 'GitHub verisi çekilemedi.');
      setGhRuns(data as GhRunsResponse);
    } catch (e) {
      setGhError(e instanceof Error ? e.message : 'GitHub verisi çekilemedi.');
    } finally {
      setGhLoading(false);
    }
  }

  async function handleWorkflowToggle(repo: string, workflowId: number, enable: boolean, label: string) {
    const message = enable
      ? `"${label}" akışı yeniden başlatılacak; zamanlanmış cron'lar tekrar çalışacak. Emin misin?`
      : `"${label}" akışı GitHub'da DURDURULACAK; zamanlanmış cron'lar (otomatik paylaşımlar) durur. Emin misin?`;
    if (!window.confirm(message)) return;
    if (busy) return;
    setBusy(true);
    setActionMsg('');
    try {
      const res = await fetch('/api/automation/github-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, workflowId, action: enable ? 'enable' : 'disable' }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setActionMsg(enable ? 'Akış yeniden başlatıldı (cron aktif).' : 'Akış durduruldu (cron kapalı).');
        await loadGithubRuns(true);
      } else {
        setActionMsg(data?.error || 'Akış durumu değiştirilemedi.');
      }
    } catch {
      setActionMsg('İstek gönderilemedi.');
    } finally {
      setBusy(false);
    }
  }

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
      {/* Üst Başlık */}
      <header className="sticky top-0 z-30 border-b border-[#E5E7EB] bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center gap-2.5 px-5 pt-3.5">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              overallStatus === 'err' ? 'bg-[#EF4444]' : overallStatus === 'warn' ? 'bg-[#F59E0B]' : 'bg-[#10B981]'
            }`}
            title={overallText}
          />
          <span className="text-[15px] font-semibold tracking-tight text-[#111827]">KartaL AI</span>
          {overallStatus !== 'ok' && (
            <span className={`text-xs ${overallStatus === 'err' ? 'text-[#B91C1C]' : 'text-[#92400E]'}`}>
              {overallText}
            </span>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              title="Yenile"
              onClick={() => void loadStatus()}
              disabled={loading}
              className="flex h-8 w-8 items-center justify-center rounded-full text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#111827] disabled:opacity-50"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
            </button>
            <button
              type="button"
              title={voiceOpen ? 'Sesli asistanı kapat' : 'Sesli Asistan KartaL'}
              onClick={handleToggleVoiceWidget}
              className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
                voiceOpen ? 'bg-[#111827] text-white' : 'text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111827]'
              }`}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
                <path d="M12 18v4" />
              </svg>
            </button>
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl flex-wrap gap-x-3 gap-y-0.5 px-5 pb-2.5 pt-1.5 text-[11px] text-[#9CA3AF]">
          <span>
            Stok {report ? `${report.summary.stock_shorts} Shorts · ${report.summary.stock_long} Uzun` : '—'}
          </span>
          <span>Son güncelleme {(report?.updated_at || '—').replace(/-/g, '.')}</span>
          <span>Telegram {lastTelegramTime}</span>
          {lastRefreshedAt && <span>yenilendi {lastRefreshedAt}</span>}
        </div>
      </header>

      {/* Sekmeler */}
      <nav className="border-b border-[#E5E7EB] bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5">
          {([
            ['genel', 'Genel'],
            ['videolar', 'Videolar'],
            ['paylasim', 'Paylaşım'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveTab(key)}
              className={`border-b-2 px-0.5 py-3 text-[13px] whitespace-nowrap transition ${
                activeTab === key
                  ? 'border-[#111827] font-semibold text-[#111827]'
                  : 'border-transparent text-[#6B7280] hover:text-[#111827]'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setMorePanelOpen(true)}
            className={`flex items-center gap-1 border-b-2 px-0.5 py-3 text-[13px] whitespace-nowrap transition ${
              activeTab === 'isciler' ||
              activeTab === 'baglantilar' ||
              activeTab === 'uyarilar' ||
              activeTab === 'github'
                ? 'border-[#111827] font-semibold text-[#111827]'
                : 'border-transparent text-[#6B7280] hover:text-[#111827]'
            }`}
          >
            Daha fazla
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      </nav>

      {/* Şimdi paylaş penceresi */}
      {uploadOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
          onClick={() => setUploadOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-[#E5E7EB] bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[15px] font-semibold text-[#111827]">Şimdi paylaş</h3>
            <p className="mt-1 text-xs leading-5 text-[#6B7280]">
              Zamanlayıcıyı beklemeden GitHub Actions yükleyici işçisini başlatır. Zamanlanmış yayın
              saatleri (14:15 / 18:15 / 21:15) aynen çalışmaya devam eder.
            </p>
            <div className="mt-4 grid grid-cols-3 gap-2">
              {([
                ['auto', 'Otomatik'],
                ['short', 'Shorts'],
                ['long', 'Uzun Video'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setUploadType(key)}
                  className={`rounded-md border px-2 py-2.5 text-xs transition ${
                    uploadType === key
                      ? 'border-[#111827] bg-[#111827] font-semibold text-white'
                      : 'border-[#E5E7EB] text-[#374151] hover:border-[#9CA3AF]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="mt-3.5 flex items-start gap-2 text-xs leading-5 text-[#374151]">
              <input
                type="checkbox"
                checked={uploadDryRun}
                onChange={(e) => setUploadDryRun(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-[#111827]"
              />
              Sadece test (dry-run — video yüklemez, yalnızca tablo ve Drive bağlantısını doğrular)
            </label>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setUploadOpen(false)}
                className="rounded-md px-3.5 py-2 text-xs text-[#6B7280] hover:text-[#111827]"
              >
                Vazgeç
              </button>
              <button
                type="button"
                onClick={confirmUploadNow}
                disabled={busy}
                className="rounded-md bg-[#111827] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1F2937] disabled:opacity-50"
              >
                {busy ? 'Başlatılıyor…' : 'Başlat'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Daha Fazla paneli */}
      {morePanelOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
          onClick={() => setMorePanelOpen(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl border border-[#E5E7EB] bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#E5E7EB] px-5 py-3.5">
              <h3 className="text-[15px] font-semibold text-[#111827]">Daha fazla</h3>
              <button
                type="button"
                onClick={() => setMorePanelOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-full text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#111827]"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-4">
              <div className="text-[11px] font-semibold tracking-wider text-[#9CA3AF] uppercase">Sayfalar</div>
              <div className="mt-1 divide-y divide-[#E5E7EB]">
                {([
                  ['isciler', 'İşçiler', 'Durumlar ve kontroller'],
                  ['baglantilar', 'Bağlantılar', 'Drive köprüleri ve platformlar'],
                  ['uyarilar', 'Uyarılar', 'Kota ve sistem uyarıları'],
                  ['github', 'GitHub', 'Actions çalıştırmaları ve cron anahtarları'],
                ] as const).map(([key, label, desc]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setActiveTab(key);
                      setMorePanelOpen(false);
                      if (key === 'github') void loadGithubRuns();
                    }}
                    className="flex w-full items-baseline justify-between gap-3 py-3 text-left transition hover:bg-[#FAFAFA]"
                  >
                    <span className="text-[13.5px] font-semibold text-[#111827]">{label}</span>
                    <span className="min-w-0 flex-1 truncate text-right text-xs text-[#9CA3AF]">{desc}</span>
                  </button>
                ))}
              </div>

              <div className="mt-5 text-[11px] font-semibold tracking-wider text-[#9CA3AF] uppercase">İşlemler</div>
              <div className="mt-1 divide-y divide-[#E5E7EB]">
                <button
                  type="button"
                  onClick={() => {
                    setMorePanelOpen(false);
                    setUploadOpen(true);
                  }}
                  className="block w-full py-3 text-left text-[13.5px] font-medium text-[#111827] transition hover:bg-[#FAFAFA]"
                >
                  Şimdi paylaş…
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMorePanelOpen(false);
                    void handleTelegramTest();
                  }}
                  className="block w-full py-3 text-left text-[13.5px] font-medium text-[#111827] transition hover:bg-[#FAFAFA]"
                >
                  Telegram&apos;ı test et
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMorePanelOpen(false);
                    void handleRetryOrRun();
                  }}
                  className="block w-full py-3 text-left text-[13.5px] font-medium text-[#111827] transition hover:bg-[#FAFAFA]"
                >
                  Yükleyiciyi çalıştır
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMorePanelOpen(false);
                    handlePauseAll();
                  }}
                  className="block w-full py-3 text-left text-[13.5px] font-medium text-[#111827] transition hover:bg-[#FAFAFA]"
                >
                  {paused ? 'Devam ettir' : 'Tümünü duraklat'}
                </button>
              </div>
              <p className="mt-3 text-[11px] leading-5 text-[#9CA3AF]">
                Her işlem çalışmadan önce &quot;Emin misin?&quot; onayı sorar; hiçbir tuş tek başına işlem yapmaz.
              </p>
            </div>
          </div>
        </div>
      )}
      <main className="mx-auto max-w-6xl px-4 py-4 pb-24">
        {actionMsg && (
          <div className="mb-4 border-l-2 border-[#111827] pl-3 text-[13px] leading-5 text-[#111827]">{actionMsg}</div>
        )}
        {error && (
          <div className="mb-4 border-l-2 border-[#EF4444] pl-3 text-[13px] leading-5 text-[#B91C1C]">
            Veri okuma hatası: {error}
          </div>
        )}

        {/* Genel Sekmesi */}
        {activeTab === 'genel' && (
          <div>
            {/* Tek vurgu: ana sayı */}
            <section className="flex items-end justify-between gap-4 pb-6 pt-2">
              <div className="min-w-0">
                <div className="text-[52px] font-semibold leading-none tracking-tight tabular-nums text-[#111827] sm:text-[60px]">
                  {fmt(report?.summary?.total_views)}
                </div>
                <div className="mt-2.5 text-[13px] text-[#6B7280]">toplam görüntülenme</div>
              </div>
              <div className="shrink-0 pb-1 text-right text-[13px] leading-5 text-[#6B7280]">
                <div>
                  {fmt(report?.summary?.weekly_uploaded)} bu hafta · {fmt(report?.summary?.total_comments)} yorum
                </div>
                <div className={report?.summary?.failed_jobs ? 'font-semibold text-[#B91C1C]' : 'text-[#9CA3AF]'}>
                  {fmt(report?.summary?.failed_jobs)} hata
                </div>
              </div>
            </section>

            {/* Bugünkü yayınlar — kutusuz, çizgi ve boşlukla */}
            <section className="border-t border-[#E5E7EB] py-6">
              <div className="flex items-baseline justify-between">
                <h2 className="text-[13px] font-semibold text-[#111827]">Bugünkü yayınlar</h2>
                <span className="text-xs text-[#9CA3AF]">
                  stok {report?.summary?.stock_shorts ?? '—'} · {report?.summary?.stock_long ?? '—'}
                </span>
              </div>
              <div className="mt-3.5 grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6">
                <div className="border-t-2 border-[#111827] pt-2.5">
                  <div className="text-[17px] font-semibold tabular-nums text-[#111827]">14:15</div>
                  <div className="mt-0.5 text-xs text-[#6B7280]">Öğle Kuşağı · Shorts</div>
                </div>
                <div className="border-t border-[#D1D5DB] pt-2.5">
                  <div className="text-[17px] font-semibold tabular-nums text-[#111827]">18:15</div>
                  <div className="mt-0.5 text-xs text-[#6B7280]">Akşamüstü · Shorts</div>
                </div>
                <div className="border-t border-[#D1D5DB] pt-2.5">
                  <div className="text-[17px] font-semibold tabular-nums text-[#111827]">21:15</div>
                  <div className="mt-0.5 text-xs text-[#6B7280]">Prime-Time · tek gün Shorts / çift gün Uzun</div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-[#6B7280]">
                <span>
                  Sıradaki:{' '}
                  <strong className="font-semibold text-[#111827]">
                    {lastUploadFile && /video_(\d+)/.test(lastUploadFile)
                      ? `video_${Number(/video_(\d+)/.exec(lastUploadFile)![1]) + 1}.mp4`
                      : '—'}
                  </strong>
                </span>
                {lastUploadUrl && (
                  <a
                    href={lastUploadUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-dotted underline-offset-2 hover:text-[#111827]"
                  >
                    son atılan {lastUploadFile || '—'}
                  </a>
                )}
                <a
                  href="https://drive.google.com/drive/folders/1MBjwKp1DXoxLiCAkds84MowZAFMOK7Br"
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted underline-offset-2 hover:text-[#111827]"
                  title="Yayın kuyruğu — Lobi'deki her video buraya otomatik akıyor"
                >
                  Lobi onaysız kuyruğa akıyor
                </a>
              </div>
            </section>

            {/* Son videolar */}
            <section className="border-t border-[#E5E7EB] py-6">
              <div className="flex items-baseline justify-between">
                <h2 className="text-[13px] font-semibold text-[#111827]">Son videolar</h2>
                <button
                  type="button"
                  onClick={() => setActiveTab('videolar')}
                  className="text-xs text-[#6B7280] underline-offset-2 hover:text-[#111827] hover:underline"
                >
                  Tümünü gör
                </button>
              </div>
              <div className="mt-1 divide-y divide-[#E5E7EB]">
                {(report?.videos || []).map((v) => {
                  const key = `v-${v.id}`;
                  const isOpen = !!openRows[key];
                  const { shortTitle, fullClean, hashtags } = getShortCleanTitle(v.title);
                  return (
                    <div
                      key={v.id}
                      onClick={() => toggleRow(key)}
                      className="cursor-pointer py-3.5 transition hover:bg-[#FAFAFA]"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="truncate text-[13.5px] font-semibold text-[#111827]">{shortTitle}</div>
                          <div className="mt-1 text-xs text-[#9CA3AF]">{fmtDate(v.publishedAt)}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[13.5px] font-semibold tabular-nums text-[#111827]">{fmt(v.views)}</div>
                          <div className="mt-0.5 text-[11px] text-[#9CA3AF]">görüntülenme</div>
                        </div>
                      </div>
                      {isOpen && (
                        <div className="mt-3 space-y-1.5 border-l border-[#E5E7EB] pl-3.5 text-xs leading-5 text-[#374151]">
                          <div>
                            <span className="text-[#9CA3AF]">Tam başlık:</span> {fullClean}
                          </div>
                          {hashtags && (
                            <div>
                              <span className="text-[#9CA3AF]">Etiketler:</span> {hashtags}
                            </div>
                          )}
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1">
                            <span className="text-[#9CA3AF]">Beğeni {fmt(v.likes)}</span>
                            <a
                              href={v.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-[#111827] underline decoration-dotted underline-offset-2 hover:text-[#374151]"
                            >
                              YouTube&apos;da aç
                            </a>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                const caption = `${fullClean}\n\nDaha fazla bilgi dozu için @bilgidozuofficial hesabını takip etmeyi unutma! 🧠🪐\n\n#bilgidozu #bilim #ilginçbilgiler #keşfet #fyp #reels`;
                                void navigator.clipboard.writeText(caption);
                                setActionMsg(`"${shortTitle}" için TikTok & Reels metni kopyalandı.`);
                              }}
                              className="text-[#6B7280] underline decoration-dotted underline-offset-2 hover:text-[#111827]"
                            >
                              Reels metnini kopyala
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {!(report?.videos || []).length && (
                  <div className="py-6 text-center text-xs text-[#9CA3AF]">Henüz video yok.</div>
                )}
              </div>
            </section>
          </div>
        )}
        {/* Videolar Sekmesi */}
        {activeTab === 'videolar' && (
          <section className="pb-2">
            <div className="flex items-baseline justify-between pb-1 pt-1">
              <h2 className="text-[13px] font-semibold text-[#111827]">Tüm videolar</h2>
              <span className="text-xs text-[#9CA3AF]">önizleme · sayılar · analiz için satıra dokun</span>
            </div>
            <div className="divide-y divide-[#E5E7EB] border-t border-[#E5E7EB]">
              {(report?.videos || []).map((v) => {
                const key = `vt-${v.id}`;
                const isOpen = !!openRows[key];
                const { shortTitle, fullClean, hashtags } = getShortCleanTitle(v.title);
                const likeRate = v.views > 0 ? ((v.likes / v.views) * 100).toFixed(1) : null;
                return (
                  <div key={v.id} onClick={() => toggleRow(key)} className="cursor-pointer py-4 transition hover:bg-[#FAFAFA]">
                    <div className="flex items-start gap-3.5">
                      {/* 1) Onizleme */}
                      <div className="h-[54px] w-24 shrink-0 overflow-hidden rounded-md border border-[#E5E7EB] bg-[#F3F4F6]">
                        <img
                          src={`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            e.currentTarget.style.visibility = 'hidden';
                          }}
                        />
                      </div>
                      {/* 2) Baslik + tarih */}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-semibold text-[#111827]">{shortTitle}</div>
                        <div className="mt-0.5 text-xs text-[#9CA3AF]">{fmtDate(v.publishedAt)}</div>
                        {/* 3) Istatistikler */}
                        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                          <span>
                            <span className="font-semibold tabular-nums text-[#111827]">{fmt(v.views)}</span>{' '}
                            <span className="text-[#9CA3AF]">izlenme</span>
                          </span>
                          <span>
                            <span className="font-semibold tabular-nums text-[#111827]">{fmt(v.likes)}</span>{' '}
                            <span className="text-[#9CA3AF]">beğeni</span>
                          </span>
                          <span>
                            <span className="font-semibold tabular-nums text-[#111827]">{fmt(v.comments)}</span>{' '}
                            <span className="text-[#9CA3AF]">yorum</span>
                          </span>
                        </div>
                      </div>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`mt-1 shrink-0 text-[#9CA3AF] transition ${isOpen ? 'rotate-180' : ''}`}
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </div>
                    {/* 4) Acilir analiz */}
                    {isOpen && (
                      <div className="mt-3 space-y-1.5 border-l border-[#E5E7EB] pl-3.5 text-xs leading-5 text-[#374151]">
                        <div>
                          <span className="text-[#9CA3AF]">Tam başlık:</span> {fullClean}
                        </div>
                        {hashtags && (
                          <div className="truncate">
                            <span className="text-[#9CA3AF]">Etiketler:</span> {hashtags}
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1">
                          {likeRate && (
                            <span className="text-[#9CA3AF]">Beğeni oranı %{likeRate}</span>
                          )}
                          <span className="text-[#9CA3AF]">Video ID: {v.id}</span>
                          <a
                            href={v.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-[#111827] underline decoration-dotted underline-offset-2 hover:text-[#374151]"
                          >
                            YouTube&apos;da aç
                          </a>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const caption = `${fullClean}\n\nDaha fazla bilgi dozu için @bilgidozuofficial hesabını takip etmeyi unutma! 🧠🪐\n\n#bilgidozu #bilim #ilginçbilgiler #keşfet #fyp #reels`;
                              void navigator.clipboard.writeText(caption);
                              setActionMsg(`"${shortTitle}" için TikTok & Reels metni kopyalandı.`);
                            }}
                            className="text-[#6B7280] underline decoration-dotted underline-offset-2 hover:text-[#111827]"
                          >
                            Reels metnini kopyala
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {!(report?.videos || []).length && (
                <div className="py-6 text-center text-xs text-[#9CA3AF]">Henüz video yok.</div>
              )}
            </div>
          </section>
        )}

        {/* Paylaşım Kitleri Sekmesi */}
        {activeTab === 'paylasim' && (
          <section className="pb-2">
            <div className="flex items-baseline justify-between pb-1 pt-1">
              <h2 className="text-[13px] font-semibold text-[#111827]">Instagram / TikTok — manuel paylaşım kitleri</h2>
              <span className="text-xs text-[#9CA3AF]">açıklama + sabit yorum hazır, kopyala-yapıştır</span>
            </div>
            <div className="space-y-1 border-t border-[#E5E7EB] py-3 text-xs leading-5 text-[#6B7280]">
              <div>
                <span className="font-semibold text-[#374151]">Kurallar:</span> VPN kapalı · günde en fazla 2 video (12:45 ve 21:45) ·
                paylaşınca 10-15 dk uygulamada kal · sabit yorumu kendin ilk yorum olarak at + pinle.
              </div>
              <div>
                Video dosyaları:{' '}
                <a
                  href="https://drive.google.com/drive/folders/1w8tz_lv7iMFsRRCaTKUSY_ri0F107rz_"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-[#111827] underline decoration-dotted underline-offset-2"
                >
                  Drive &quot;KartaL Stok&quot;
                </a>{' '}
                (karttaki <code className="text-[#374151]">video_XX.mp4</code> adıyla aynı dosya)
              </div>
            </div>
            <div className="divide-y divide-[#E5E7EB] border-t border-[#E5E7EB]">
              {PAYLASIM_KITLERI.map((k) => (
                <div key={k.no} className="py-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-[#111827]">{k.dosya}</div>
                      <div className="mt-0.5 text-xs text-[#9CA3AF]">
                        Drive: {k.driveAdi} · {k.gunSlot !== '—' ? `plan: ${k.gunSlot}` : 'plan: yayında'}
                      </div>
                    </div>
                    {k.durum !== 'yayinda' && renderBadge('warn', 'SIRADA')}
                  </div>
                  <div className="mt-2.5 text-xs leading-6 text-[#374151] whitespace-pre-wrap">{k.caption}</div>
                  <div className="mt-2.5 border-l-2 border-[#D97706] pl-3 text-xs leading-6 text-[#374151]">
                    <span className="font-semibold">Sabit yorum:</span> {k.yorum}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(k.caption);
                        setActionMsg(`"${k.driveAdi}" açıklaması kopyalandı.`);
                      }}
                      className="text-[#111827] underline decoration-dotted underline-offset-2 hover:text-[#374151]"
                    >
                      Açıklamayı kopyala
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(k.yorum);
                        setActionMsg(`"${k.driveAdi}" sabit yorumu kopyalandı.`);
                      }}
                      className="text-[#111827] underline decoration-dotted underline-offset-2 hover:text-[#374151]"
                    >
                      Sabit yorumu kopyala
                    </button>
                    <a href={k.ytUrl} target="_blank" rel="noopener noreferrer" className="text-[#6B7280] underline decoration-dotted underline-offset-2 hover:text-[#111827]">
                      YouTube&apos;da aç
                    </a>
                    {k.not && <span className="text-[#9CA3AF]">{k.not}</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
        {/* İşçiler Sekmesi */}
        {activeTab === 'isciler' && (
          <section className="pb-2">
            <div className="flex flex-wrap items-center gap-2 border-b border-[#E5E7EB] py-3.5">
              <span className="mr-1 text-xs text-[#9CA3AF]">Kontroller</span>
              <button
                type="button"
                onClick={() => setUploadOpen(true)}
                className="rounded-md bg-[#111827] px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-[#1F2937]"
              >
                Şimdi paylaş
              </button>
              <button
                type="button"
                onClick={() => void handleTelegramTest()}
                disabled={busy}
                className="rounded-md border border-[#E5E7EB] px-3.5 py-1.5 text-xs text-[#111827] transition hover:border-[#9CA3AF] disabled:opacity-50"
              >
                Telegram&apos;ı test et
              </button>
              <button
                type="button"
                onClick={handlePauseAll}
                className="rounded-md border border-[#E5E7EB] px-3.5 py-1.5 text-xs text-[#111827] transition hover:border-[#9CA3AF]"
              >
                {paused ? 'Devam ettir' : 'Tümünü duraklat'}
              </button>
              <a
                href="https://github.com/benngokhan/yt_auto_uploader/actions/workflows/youtube-drive-uploader.yml"
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-xs text-[#6B7280] underline decoration-dotted underline-offset-2 hover:text-[#111827]"
              >
                GitHub Actions akışları
              </a>
            </div>
            <div className="flex items-baseline justify-between pb-1 pt-5">
              <h2 className="text-[13px] font-semibold text-[#111827]">İşçi durumları</h2>
              <span className="text-xs text-[#9CA3AF]">yeşil: aktif · sarı: beklemede · kırmızı: hata</span>
            </div>
            <div className="divide-y divide-[#E5E7EB] border-t border-[#E5E7EB]">
              {(report?.workers || []).map((w) => (
                <div key={w.id} className="py-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[13px] font-medium text-[#111827]">{w.name}</span>
                    {renderBadge(w.status, w.status_text)}
                  </div>
                  <div className="mt-1 text-xs text-[#9CA3AF]">
                    Son güncelleme {(w.updated_at || '').replace(/-/g, '.')} · Toplam iş {w.jobs_done}
                    {(w.id === 'uploader' || w.id === 'telegram') && (
                      <> · Telegram {w.telegram_last || lastTelegramTime}</>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-[#374151]">{w.last_action}</div>
                  {w.error_message && (
                    <div className="mt-1.5 border-l-2 border-[#EF4444] pl-2.5 text-xs text-[#B91C1C]">
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
          <div className="space-y-6 pt-1">
            <section>
              <div className="flex items-baseline justify-between pb-1">
                <h2 className="text-[13px] font-semibold text-[#111827]">Drive klasörleri ve köprüler</h2>
                <span className="text-xs text-[#9CA3AF]">tek dokun</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-[#E5E7EB] pt-3 text-xs">
                <a href="https://drive.google.com/drive/folders/1JULlauO1eFpXgGdZKdZZDyqesSdkeT6f" target="_blank" rel="noreferrer"
                  className="rounded-md border border-[#E5E7EB] px-2.5 py-1.5 text-[#374151] transition hover:border-[#9CA3AF]">
                  Lobi · hazır videolar
                </a>
                <a href="https://drive.google.com/drive/folders/1w8tz_lv7iMFsRRCaTKUSY_ri0F107rz_" target="_blank" rel="noreferrer"
                  className="rounded-md border border-[#E5E7EB] px-2.5 py-1.5 text-[#374151] transition hover:border-[#9CA3AF]">
                  KartaL Stok · yayın kuyruğu
                </a>
                <a href="https://drive.google.com/drive/folders/1XKZJ12HyAvZkjgiG38ys3HOMhZ42d_jJ" target="_blank" rel="noreferrer"
                  className="rounded-md border border-[#E5E7EB] px-2.5 py-1.5 text-[#374151] transition hover:border-[#9CA3AF]">
                  Kapaklar
                </a>
                <a href="https://www.instagram.com/bilgidozuofficial" target="_blank" rel="noreferrer"
                  className="rounded-md border border-[#E5E7EB] px-2.5 py-1.5 text-[#374151] transition hover:border-[#9CA3AF]">
                  Instagram
                </a>
                <a href="https://www.tiktok.com/@bilgidozuofficial" target="_blank" rel="noreferrer"
                  className="rounded-md border border-[#E5E7EB] px-2.5 py-1.5 text-[#374151] transition hover:border-[#9CA3AF]">
                  TikTok
                </a>
                <button
                  type="button"
                  onClick={() => {
                    const bio =
                      '🧠 Her gün 1 doz gerçek bilim, uzay ve insan beyninin sırları!\n🪐 Kaynaklı & doğruluk kontrolünden geçmiş içerikler\n👇 Uzun belgesellerimiz için YouTube kanalımız:\nhttps://www.youtube.com/@bilgidozuofficial';
                    void navigator.clipboard.writeText(bio);
                    setActionMsg('Profil biyografisi panoya kopyalandı.');
                  }}
                  className="rounded-md bg-[#111827] px-2.5 py-1.5 font-semibold text-white transition hover:bg-[#1F2937]"
                >
                  Biyografiyi kopyala
                </button>
                <a href="/bilgidozu-logo.png" target="_blank" rel="noreferrer"
                  className="rounded-md border border-[#E5E7EB] px-2.5 py-1.5 text-[#374151] transition hover:border-[#9CA3AF]">
                  Logo indir
                </a>
              </div>
            </section>

            <section>
              <div className="flex items-baseline justify-between pb-1">
                <h2 className="text-[13px] font-semibold text-[#111827]">Platform bağlantıları</h2>
                <span className="text-xs text-[#9CA3AF]">canlı durum göstergesi</span>
              </div>
              <div className="divide-y divide-[#E5E7EB] border-t border-[#E5E7EB]">
                {connections.map((c) => (
                  <div key={c.id} className="py-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[13px] font-semibold text-[#111827]">
                        {c.platform} — {c.account}
                      </span>
                      {renderBadge(c.status, c.statusText)}
                    </div>
                    <div className="mt-1 text-xs text-[#9CA3AF]">{c.detail}</div>
                  </div>
                ))}
              </div>
            </section>

            <form onSubmit={handleAddConnection} className="border-t border-[#E5E7EB] pt-5">
              <div className="text-[13px] font-semibold text-[#111827]">Yeni kanal / manuel bağlantı ekle</div>
              <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <select
                  value={newPlat}
                  onChange={(e) => setNewPlat(e.target.value)}
                  className="rounded-md border border-[#E5E7EB] bg-white px-3 py-2 text-xs text-[#111827] focus:border-[#111827] focus:outline-none"
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
                  className="rounded-md border border-[#E5E7EB] bg-white px-3 py-2 text-xs text-[#111827] focus:border-[#111827] focus:outline-none"
                />
                <input
                  type="text"
                  value={newDetail}
                  onChange={(e) => setNewDetail(e.target.value)}
                  placeholder="API anahtarı / webhook URL / not"
                  className="rounded-md border border-[#E5E7EB] bg-white px-3 py-2 text-xs text-[#111827] focus:border-[#111827] focus:outline-none"
                />
              </div>
              <button
                type="submit"
                className="mt-3 rounded-md bg-[#111827] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1F2937]"
              >
                Bağlantıyı kaydet
              </button>
            </form>
          </div>
        )}
        {/* GitHub Sekmesi */}
        {activeTab === 'github' && (
          <section className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-1 pt-1">
              <h2 className="text-[13px] font-semibold text-[#111827]">GitHub Actions işçileri</h2>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void loadGithubRuns(true)}
                  disabled={ghLoading}
                  className="text-xs text-[#6B7280] underline decoration-dotted underline-offset-2 hover:text-[#111827] disabled:opacity-50"
                >
                  {ghLoading ? 'Yenileniyor…' : 'Yenile'}
                </button>
                <a
                  href="https://github.com/benngokhan/yt_auto_uploader/actions"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-[#6B7280] underline decoration-dotted underline-offset-2 hover:text-[#111827]"
                >
                  GitHub&apos;da aç
                </a>
              </div>
            </div>
            {ghError && (
              <div className="border-l-2 border-[#EF4444] py-2 pl-3 text-xs text-[#B91C1C]">{ghError}</div>
            )}
            {ghLoading && !ghRuns && (
              <div className="space-y-2 border-t border-[#E5E7EB] pt-4 text-xs text-[#9CA3AF]">
                <div className="h-3 w-1/3 animate-pulse rounded bg-[#E5E7EB]" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-[#E5E7EB]" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-[#E5E7EB]" />
              </div>
            )}
            {(ghRuns?.repos || []).map((r) => (
              <div key={r.key} className="border-t border-[#E5E7EB] py-5 first:border-t-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="text-[13px] font-semibold text-[#111827]">{r.label}</span>{' '}
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-[#9CA3AF] underline decoration-dotted underline-offset-2 hover:text-[#111827]"
                    >
                      {r.repo}
                    </a>
                  </div>
                  {r.key === 'uploader' && (
                    <button
                      type="button"
                      onClick={() => setUploadOpen(true)}
                      className="rounded-md bg-[#111827] px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-[#1F2937]"
                    >
                      Şimdi paylaş
                    </button>
                  )}
                </div>
                {r.error ? (
                  <div className="mt-2 border-l-2 border-[#EF4444] pl-3 text-xs text-[#B91C1C]">{r.error}</div>
                ) : (
                  <>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
                      {r.workflows.map((wf) => (
                        <span
                          key={wf.id}
                          className="inline-flex items-center gap-2 rounded-md border border-[#E5E7EB] px-2.5 py-1.5 text-[#374151]"
                        >
                          {wf.name}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              handleWorkflowToggle(
                                r.repo,
                                wf.id,
                                wf.state !== 'active',
                                wf.name
                              )
                            }
                            className={`font-semibold underline decoration-dotted underline-offset-2 disabled:opacity-50 ${
                              wf.state === 'active'
                                ? 'text-[#B91C1C] hover:text-[#7F1D1D]'
                                : 'text-[#047857] hover:text-[#065F46]'
                            }`}
                          >
                            {wf.state === 'active' ? 'Durdur' : 'Başlat'}
                          </button>
                          {wf.state !== 'active' && renderBadge('warn', 'DURDURULDU')}
                        </span>
                      ))}
                    </div>
                    <div className="mt-1 divide-y divide-[#E5E7EB]">
                      {r.runs.map((run) => {
                        const dot =
                          run.conclusion === 'success'
                            ? 'bg-[#10B981]'
                            : run.conclusion === 'failure'
                              ? 'bg-[#EF4444]'
                              : run.conclusion === 'cancelled' || run.conclusion === 'skipped'
                                ? 'bg-[#F59E0B]'
                                : 'bg-[#9CA3AF]';
                        const eventLabel =
                          run.event === 'schedule'
                            ? 'zamanlanmış'
                            : run.event === 'workflow_dispatch'
                              ? 'manuel'
                              : run.event;
                        return (
                          <a
                            key={run.id}
                            href={run.htmlUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-start gap-2.5 py-2.5 transition hover:bg-[#FAFAFA]"
                          >
                            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium text-[#111827]">
                                {run.workflowName} #{run.runNumber}
                              </span>
                              <span className="mt-0.5 block truncate text-xs text-[#9CA3AF]">
                                {run.displayTitle} · {eventLabel} · {fmtDate(run.createdAt)} · {fmtDur(run.durationSec)}
                              </span>
                            </span>
                          </a>
                        );
                      })}
                      {!r.runs.length && (
                        <div className="py-4 text-center text-xs text-[#9CA3AF]">Çalıştırma kaydı yok.</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
            {ghRuns && !ghRuns.repos.length && (
              <div className="py-6 text-center text-xs text-[#9CA3AF]">Veri yok.</div>
            )}
            <p className="border-t border-[#E5E7EB] pt-4 text-[11px] leading-5 text-[#9CA3AF]">
              &quot;Durdur&quot; seçeneği GitHub&apos;da workflow&apos;u gerçekten devre dışı bırakır —
              zamanlanmış cron&apos;lar durur. &quot;Başlat&quot; yeniden etkinleştirir. Her işlem onay ister.
            </p>
          </section>
        )}

        {/* Uyarılar Sekmesi */}
        {activeTab === 'uyarilar' && (
          <section className="pb-2">
            <div className="flex items-baseline justify-between pb-1 pt-1">
              <h2 className="text-[13px] font-semibold text-[#111827]">Sistem uyarıları</h2>
              <span className="text-xs text-[#9CA3AF]">yeşil: yeterli · kırmızı: kota/sorun</span>
            </div>
            <div className="divide-y divide-[#E5E7EB]">
              {(report?.alerts || []).map((a) => (
                <div key={a.id} className="py-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[13px] font-medium text-[#111827]">{a.title}</span>
                    {renderBadge(a.status, a.status_text)}
                  </div>
                  <div className="mt-1 text-xs text-[#9CA3AF]">
                    Son kontrol {(a.updated_at || '').replace(/-/g, '.')}
                  </div>
                  <div className="mt-1 text-xs text-[#374151]">{a.detail}</div>
                </div>
              ))}
              {!(report?.alerts || []).length && (
                <div className="py-6 text-center text-xs text-[#9CA3AF]">Uyarı yok.</div>
              )}
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

        // Premium Kraliyet Altını & Elektrik Camgöbeği KartaL (Rengi bozan hue-rotate YOK!)
        const brightness = isActive ? 1.06 + rawAmp * 0.16 : 1.02;
        const contrast = isActive ? 1.08 + rawAmp * 0.08 : 1.04;
        const floatY = Math.sin(waveTick * 0.06) * (isActive ? 4 : 2);
        const eagleScale = 1 + (speaking ? rawAmp * 0.05 : voiceListening ? 0.025 : 0);

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

        // Kartal üzerindeki premium altın & camgöbeği yıldız parıltı koordinatları
        const sparkles = [
          { x: '17%', y: '26%', phase: 0.0, size: 6, gold: true },
          { x: '31%', y: '42%', phase: 1.3, size: 5, gold: false },
          { x: '50%', y: '53%', phase: 2.4, size: 12, gold: false },
          { x: '69%', y: '42%', phase: 3.7, size: 5, gold: false },
          { x: '83%', y: '26%', phase: 4.9, size: 6, gold: true },
          { x: '25%', y: '58%', phase: 2.1, size: 5, gold: true },
          { x: '75%', y: '58%', phase: 0.8, size: 5, gold: true },
        ];

        return (
          <div
            className="fixed bottom-2 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center pointer-events-none select-none w-full max-w-2xl px-3"
            aria-live="polite"
          >
            {/* 1. ÜST KATMAN: PREMİUM ALTIN-CAMGÖBEĞİ ZIRHLI KARTAL (SENİN CAPCUT BOYUTUNDA: 320px-360px) */}
            <div className="relative flex flex-col items-center pointer-events-auto">
              {/* Zarif kapatma düğmesi (X) */}
              <button
                type="button"
                onClick={handleToggleVoiceWidget}
                title="KartaL Sesli Asistanı Kapat"
                className="absolute right-1 top-1 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-amber-400/60 bg-slate-900/80 text-xs font-semibold text-amber-300 shadow-md backdrop-blur-xs transition hover:scale-110 hover:bg-slate-800"
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
                      : 'Konuşmak için KartaL üzerine dokun'
                }
                style={{
                  transform: `translateY(${floatY}px) scale(${eagleScale})`,
                }}
                className="relative flex items-center justify-center focus:outline-none transition-transform duration-100 active:scale-95"
              >
                {/* Göğüs Enerji Çekirdeği Nabız Halkası (Sadece konuşurken/dinlerken parlar) */}
                {isActive && (
                  <span
                    style={{
                      left: '50%',
                      top: '53%',
                      width: `${46 + rawAmp * 34}px`,
                      height: `${46 + rawAmp * 34}px`,
                      transform: 'translate(-50%, -50%)',
                      background:
                        'radial-gradient(circle, rgba(56,189,248,0.55) 0%, rgba(245,158,11,0.28) 55%, rgba(0,0,0,0) 75%)',
                    }}
                    className="pointer-events-none absolute rounded-full blur-[2px]"
                  />
                )}

                {/* 4K Keskinlikte Tok Altın-Camgöbeği Hologram Kartal Görseli */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/kartal-hologram.png?v=2"
                  alt="KartaL AI Hologram"
                  style={{
                    filter: `brightness(${brightness}) contrast(${contrast}) drop-shadow(0 6px 14px rgba(15,23,42,0.38)) drop-shadow(0 0 ${
                      isActive ? Math.round(10 + rawAmp * 16) : 5
                    }px ${
                      voiceListening
                        ? 'rgba(245,158,11,0.75)'
                        : speaking
                          ? 'rgba(14,165,233,0.85)'
                          : 'rgba(14,165,233,0.35)'
                    })`,
                  }}
                  className="w-[310px] sm:w-[360px] h-auto object-contain pointer-events-none select-none transition-[filter] duration-100"
                />

                {/* Konuşurken & Dinlerken Kartal Üzerinde Altın & Camgöbeği Kıvılcımlar */}
                {isActive &&
                  sparkles.map((sp, idx) => {
                    const pulse = 0.5 + 0.5 * Math.sin(waveTick * 0.22 + sp.phase);
                    const col = sp.gold ? '#fbbf24' : '#38bdf8';
                    return (
                      <span
                        key={idx}
                        style={{
                          left: sp.x,
                          top: sp.y,
                          width: `${sp.size + pulse * 5 * rawAmp}px`,
                          height: `${sp.size + pulse * 5 * rawAmp}px`,
                          backgroundColor: '#ffffff',
                          opacity: 0.4 + pulse * 0.6,
                          boxShadow: `0 0 ${6 + pulse * 10}px ${col}, 0 0 ${12 + pulse * 16}px ${col}`,
                          transform: `translate(-50%, -50%) rotate(45deg) scale(${0.65 + pulse * 0.7})`,
                        }}
                        className="pointer-events-none absolute rounded-[2px] transition-transform duration-75"
                      />
                    );
                  })}
              </button>
            </div>

            {/* 2. ORTA KATMAN: ARKASINDA FON OLMAYAN ŞEFFAF HOLOGRAM SES DALGASI (ALTIN + CAMGÖBEĞİ) */}
            <div className="-mt-3 flex items-center justify-center pointer-events-none">
              <svg
                viewBox="0 0 360 54"
                className="w-[290px] sm:w-[330px] h-12 overflow-visible"
                style={{
                  filter: 'drop-shadow(0 0 6px rgba(14,165,233,0.45))',
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
                  className="text-sm sm:text-[15px] font-semibold tracking-tight text-emerald-700"
                >
                  {voiceInterim}
                </p>
              ) : activeChunkWords.length > 0 ? (
                <p
                  style={{
                    textShadow:
                      '0 0 14px rgba(255,255,255,0.98), 0 0 6px rgba(255,255,255,0.98), 0 2px 10px rgba(14,165,233,0.3)',
                  }}
                  className="text-sm sm:text-[15px] font-semibold tracking-tight text-[#0369A1] leading-snug"
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
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
              </svg>
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
