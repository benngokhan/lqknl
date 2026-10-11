'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSpeaker } from '@/components/useSpeaker';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  imageUrl?: string;
}

interface ContentDraft {
  id: number;
  title: string;
  platform: string;
  topic: string | null;
  status: string;
  generatedScript: string | null;
  generation: { provider?: string | null; model?: string | null } | null;
}

interface DraftAnalysis {
  report: string | null;
  createdAt: string | null;
  titles: Array<{ id: number; title: string }>;
  provider: string | null;
  model: string | null;
}

const COMMANDS = [
  { command: '/yardım', description: 'Mira komutlarını gösterir' },
  { command: '/durum', description: 'Mira ve veritabanı durumunu kontrol eder' },
  { command: '/taslak ', description: 'Kayıtlı taslağın tam metnini gösterir' },
  { command: '/n8n', description: 'n8n bağlantı durumunu kontrol eder' },
  { command: '/n8n-ajan ', description: 'n8n için yeni ajan oluşturma isteği başlatır' },
  { command: '/yt-viral ', description: 'YouTube Shorts otomasyonunu başlatır' },
  { command: '/oku ', description: 'GitHub reposundan dosya içeriğini okur' },
];

function renderAnalysisReport(report: string): ReactNode[] {
  const lines = report.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;

  const isTableSeparator = (line: string) =>
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

  const parseCells = (line: string) =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) =>
      cell.trim().replace(/<br\s*\/?\s*>/gi, '\n')
    );

  while (i < lines.length) {
    if (lines[i].trim().startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = parseCells(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(parseCells(lines[i]));
        i += 1;
      }
      blocks.push(
        <div key={`table-${i}`} className="max-w-full overflow-x-auto rounded-lg border border-slate-700">
          <table className="w-full min-w-[900px] border-collapse text-left text-xs sm:text-sm">
            <thead className="bg-slate-800 text-slate-100">
              <tr>
                {headers.map((header, index) => (
                  <th key={index} className="border-b border-slate-600 px-3 py-3 font-semibold align-top">{header.replace(/\*\*/g, '')}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className={rowIndex % 2 === 0 ? 'bg-slate-900' : 'bg-slate-800/60'}>
                  {headers.map((_, cellIndex) => (
                    <td key={cellIndex} className="border-b border-slate-700 px-3 py-3 align-top whitespace-pre-wrap break-words text-slate-200">
                      {(row[cellIndex] ?? '').replace(/\*\*/g, '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !(lines[i].trim().startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))) {
      paragraph.push(lines[i].replace(/<br\s*\/?\s*>/gi, '\n'));
      i += 1;
    }
    const text = paragraph.join('\n').trim();
    if (text) {
      blocks.push(<div key={`text-${i}`} className="whitespace-pre-wrap break-words text-slate-200">{text.replace(/\*\*/g, '')}</div>);
    }
  }

  return blocks;
}

export default function Home() {
  const [entered, setEntered] = useState(false);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [drafts, setDrafts] = useState<ContentDraft[]>([]);
  const [draftPanelOpen, setDraftPanelOpen] = useState(false);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [reviewBusyId, setReviewBusyId] = useState<number | null>(null);
  const [draftsError, setDraftsError] = useState('');
  const [reviewNotice, setReviewNotice] = useState('');
  const [videoProgress, setVideoProgress] = useState<{ contentId: number; percentage: number; stage: string; status: string } | null>(null);
  const [analysis, setAnalysis] = useState<DraftAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [analysisRunLoading, setAnalysisRunLoading] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(true);
  const { speak, voiceError } = useSpeaker();

  async function loadAnalysis() {
    setAnalysisLoading(true);
    setAnalysisError('');
    try {
      const res = await fetch('/api/content/analysis', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Analiz raporu alınamadı (HTTP ${res.status}).`);
      setAnalysis(data && typeof data === 'object' ? data as DraftAnalysis : null);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : 'Analiz raporu alınamadı.');
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function runDraftAnalysis() {
    if (analysisRunLoading) return;
    setAnalysisRunLoading(true);
    setAnalysisError('');
    try {
      const res = await fetch('/api/automation/analyze-drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'review-panel' }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Analiz başlatılamadı (HTTP ${res.status}).`);
      if (data?.analyzed !== true || typeof data?.report !== 'string') {
        throw new Error(typeof data?.message === 'string' ? data.message : 'Analiz edilecek yeni taslak bulunamadı.');
      }
      await loadAnalysis();
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : 'Taslak analizi tamamlanamadı.');
    } finally {
      setAnalysisRunLoading(false);
    }
  }

  async function loadDrafts() {
    setDraftsLoading(true);
    setDraftsError('');
    try {
      const res = await fetch('/api/content/review', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Taslaklar alınamadı (HTTP ${res.status}).`);
      setDrafts(Array.isArray(data) ? data : []);
    } catch (error) {
      setDraftsError(error instanceof Error ? error.message : 'Taslaklar alınamadı.');
    } finally {
      setDraftsLoading(false);
    }
  }

  async function reviewDraft(id: number, action: 'approve_video' | 'approve_text' | 'reject') {
    if (reviewBusyId !== null) return;
    const prompt = action === 'approve_video'
      ? 'Bu içeriği onaylayıp videoyu oluşturmayı ve YouTube kanalına gizli (private) olarak yüklemeyi başlatmak istiyor musun? İşlem birkaç dakika sürebilir.'
      : action === 'approve_text'
        ? 'Bu içeriği onaylayıp video üretmeden saklamak istiyor musun?'
        : 'Bu taslağı reddetmek istiyor musun?';
    if (!window.confirm(prompt)) return;
    setReviewBusyId(id);
    setDraftsError('');
    setReviewNotice('');
    if (action === 'approve_video') setVideoProgress({ contentId: id, percentage: 2, stage: 'Video üretimi başlatılıyor', status: 'running' });
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const res = await fetch('/api/content/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `İşlem başarısız (HTTP ${res.status}).`);
      setDrafts((current) => current.filter((draft) => draft.id !== id));

      if (action !== 'approve_video') {
        setReviewNotice(action === 'approve_text' ? 'Taslak onaylandı; video üretilmedi.' : 'Taslak reddedildi.');
        return;
      }

      setReviewNotice('Onay kaydedildi. Video üretimi başladı.');
      const refreshProgress = async () => {
        try {
          const progressRes = await fetch(`/api/automation/produce-status?contentId=${id}`, { cache: 'no-store' });
          const progress = await progressRes.json().catch(() => null);
          if (progressRes.ok && progress && typeof progress.percentage === 'number') {
            setVideoProgress({ contentId: id, percentage: progress.percentage, stage: String(progress.stage || 'Video hazırlanıyor'), status: String(progress.status || 'running') });
          }
        } catch {
          // Progress polling errors must not interrupt video production.
        }
      };
      void refreshProgress();
      progressTimer = setInterval(() => { void refreshProgress(); }, 1200);
      try {
        const produceRes = await fetch('/api/automation/produce', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentId: id }),
        });
        const produced = await produceRes.json().catch(() => null);
        if (!produceRes.ok || produced?.ok !== true || produced?.produced !== true) {
          throw new Error(produced?.error || produced?.message || `Video üretimi başarısız (HTTP ${produceRes.status}).`);
        }

        if (progressTimer) { clearInterval(progressTimer); progressTimer = undefined; }
        setVideoProgress({ contentId: id, percentage: 100, stage: 'Video hazır; YouTube’a gizli yükleme yapılıyor', status: 'success' });
        setReviewNotice('Video hazır. YouTube kanalına gizli yükleme yapılıyor…');
        const uploadRes = await fetch('/api/youtube/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentId: id, privacy: 'private' }),
        });
        const uploaded = await uploadRes.json().catch(() => null);
        if (!uploadRes.ok || uploaded?.ok !== true || uploaded?.published !== true) {
          throw new Error(uploaded?.error || `YouTube yüklemesi başarısız (HTTP ${uploadRes.status}).`);
        }
        setVideoProgress({ contentId: id, percentage: 100, stage: 'Video YouTube’a gizli olarak yüklendi', status: 'success' });
        setReviewNotice(`Tamamlandı: video oluşturuldu ve YouTube'a gizli yüklendi. ${uploaded.url || ''}`.trim());
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Video üretim/yükleme işlemi tamamlanamadı.';
        setVideoProgress((current) => current?.contentId === id ? { ...current, status: 'failed', stage: `İşlem durdu: ${message}` } : current);
        setReviewNotice(`Onay kaydedildi, ancak video hattı tamamlanmadı: ${message}`);
      } finally {
        if (progressTimer) { clearInterval(progressTimer); progressTimer = undefined; }
      }
    } catch (error) {
      if (action === 'approve_video') {
        const message = error instanceof Error ? error.message : 'İşlem tamamlanamadı.';
        setVideoProgress((current) => current?.contentId === id ? { ...current, status: 'failed', stage: `İşlem durdu: ${message}` } : current);
      }
      setDraftsError(error instanceof Error ? error.message : 'İşlem tamamlanamadı.');
    } finally {
      setReviewBusyId(null);
    }
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  useEffect(() => {
    fetch('/api/auth/login', { method: 'GET' })
      .then((res) => {
        if (res.ok) setEntered(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (entered) {
      void loadDrafts();
      void loadAnalysis();
    }
  }, [entered]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || authLoading) return;
    setAuthLoading(true);
    setAuthError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAuthError(typeof data.error === 'string' ? data.error : 'Şifre yanlış.');
        setPassword('');
        return;
      }
      setPassword('');
      setEntered(true);
    } catch {
      setAuthError('Giriş doğrulaması yapılamadı. Tekrar dene.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInput(value);
    if (value.startsWith('/')) {
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
    }
  };

  const selectCommand = (cmd: string) => {
    setInput(cmd);
    setShowSuggestions(false);
    if (inputRef.current) {
      inputRef.current.focus();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput('');
    setShowSuggestions(false);
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setLoading(true);

    try {
      const wantsSelfie = /(?:selfie|selfini|selfie çek|fotoğrafını çek|kendi fotoğrafını|resmini çek)/i.test(userMessage);
      const res = await fetch(wantsSelfie ? '/api/image/selfie' : '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wantsSelfie ? {} : { message: userMessage }),
      });

      // Do not blindly call res.json(): deployment/proxy errors can return
      // plain text or HTML and cause "Unexpected token ... is not valid JSON".
      const raw = await res.text();
      let data: unknown = null;

      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        const preview = raw.replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 500);
        throw new Error(
          preview
            ? `Sunucu JSON yerine metin döndürdü (HTTP ${res.status}): ${preview}`
            : `Sunucu geçerli JSON döndürmedi (HTTP ${res.status}).`,
        );
      }

      if (!res.ok) {
        const error =
          data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : `HTTP ${res.status}`;
        throw new Error(error);
      }

      const reply =
        data && typeof data === 'object' && 'reply' in data && typeof data.reply === 'string'
          ? data.reply
          : data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : 'Yanıt alınamadı.';

      const imageUrl = data && typeof data === 'object' && 'imageUrl' in data && typeof data.imageUrl === 'string'
        ? data.imageUrl
        : undefined;
      setMessages((prev) => [...prev, { role: 'assistant', content: reply, ...(imageUrl ? { imageUrl } : {}) }]);
      speak(reply);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Hata oluştu: ${err.message || 'Bağlantı hatası'}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string, index: number) => {
    const cleanText = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    navigator.clipboard.writeText(cleanText);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const renderMessageContent = (msg: Message, index: number) => {
    const isCodeBlock = msg.content.startsWith('```');

    if (isCodeBlock) {
      const cleanCode = msg.content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');

      return (
        <div className="relative my-2 rounded-lg bg-slate-950 border border-slate-700 overflow-hidden text-left font-mono text-sm">
          <div className="flex justify-between items-center px-4 py-1.5 bg-slate-800 text-slate-400 text-xs border-b border-slate-700">
            <span>Kod Çıktısı</span>
            <button
              onClick={() => copyToClipboard(msg.content, index)}
              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-xs font-sans transition-colors"
            >
              {copiedIndex === index ? '✓ Kopyalandı' : '📋 Kopyala'}
            </button>
          </div>
          <pre className="p-4 overflow-x-auto text-slate-100 font-mono text-xs leading-relaxed">
            <code>{cleanCode}</code>
          </pre>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        <div className="whitespace-pre-wrap text-slate-100">{msg.content}</div>
        {msg.imageUrl && (
          <img
            src={msg.imageUrl}
            alt="Mira'nın oluşturduğu selfie"
            className="mt-3 w-full max-w-md rounded-xl border border-slate-700"
          />
        )}
        {msg.role === 'assistant' && (
          <div className="flex justify-end pt-1">
            <button
              onClick={() => copyToClipboard(msg.content, index)}
              className="px-2 py-1 bg-slate-700/50 hover:bg-slate-700 text-slate-300 rounded text-xs transition-colors flex items-center gap-1"
            >
              {copiedIndex === index ? '✓ Kopyalandı' : '📋 Metni Kopyala'}
            </button>
          </div>
        )}
      </div>
    );
  };

  if (!entered) {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center overflow-hidden">
        <section className="relative w-full min-h-screen flex flex-col items-center justify-center px-6">
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500/10 blur-3xl animate-pulse" />
            <div className="absolute left-1/2 top-1/2 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full border border-blue-400/20 animate-ping" />
          </div>
          <div className="relative z-10 flex flex-col items-center text-center">
            <div className="mb-7 flex h-28 w-28 items-center justify-center rounded-full border border-blue-400/30 bg-slate-900/80 shadow-2xl shadow-blue-950/40">
              <div className="h-16 w-16 rounded-full bg-blue-500/20 border border-blue-300/30 animate-pulse" />
            </div>
            <p className="mb-2 text-xs uppercase tracking-[0.45em] text-blue-300/70">MIRA</p>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Hazırım.</h1>
            <p className="mt-4 max-w-md text-sm leading-6 text-slate-400">
              Görevlerine ve otomasyonlarına odaklanan tek çalışma alanı.
            </p>
            <form onSubmit={handleLogin} className="mt-9 w-full max-w-sm">
              <label htmlFor="mira-entry-password" className="sr-only">Mira giriş şifresi</label>
              <input
                id="mira-entry-password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setAuthError('');
                }}
                placeholder="Giriş şifresi"
                autoComplete="current-password"
                className="w-full rounded-full border border-slate-700 bg-slate-900/90 px-5 py-3 text-center text-white placeholder:text-slate-500 outline-none focus:border-blue-500"
              />
              {authError && <p className="mt-2 text-sm text-red-400" role="alert">{authError}</p>}
              <button
                type="submit"
                disabled={authLoading || !password}
                className="mt-3 w-full rounded-full border border-blue-400/30 bg-blue-500/10 px-8 py-3 text-sm font-medium text-blue-100 transition-all duration-300 hover:scale-105 hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {authLoading ? 'Kontrol ediliyor...' : "Mira'ya gir"}
              </button>
            </form>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="flex flex-col h-[100dvh] max-w-4xl mx-auto p-3 sm:p-4 bg-slate-900 text-white relative overflow-hidden">
      <header className="shrink-0 py-3 sm:py-4 border-b border-slate-700 flex justify-between items-center">
        <h1 className="text-xl font-bold">Asistan Mira</h1>
        <div className="flex items-center gap-2">
          {voiceError && (
            <span className="text-[11px] text-amber-300/90" role="alert">
              {voiceError}
            </span>
          )}
          <span className="text-xs bg-blue-600/30 text-blue-400 border border-blue-500/30 px-2 py-1 rounded">
            Görev Merkezi
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain my-3 sm:my-4 space-y-4 pr-1 sm:pr-2 pb-2">
        <section className="rounded-xl border border-violet-500/30 bg-slate-800/80 p-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAnalysisOpen((open) => !open)}
              aria-expanded={analysisOpen}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="font-semibold text-white">Mira Taslak Analiz Raporu</span>
              <span className="ml-auto text-slate-400" aria-hidden="true">{analysisOpen ? '▴' : '▾'}</span>
            </button>
            <button
              type="button"
              onClick={() => void runDraftAnalysis()}
              disabled={analysisRunLoading || analysisLoading}
              className="shrink-0 rounded-lg border border-violet-400/50 bg-violet-600/20 px-3 py-2 text-xs hover:bg-violet-600/40 disabled:opacity-50"
            >
              {analysisRunLoading ? 'Analiz ediliyor…' : 'Analiz Testi'}
            </button>
            <button
              type="button"
              onClick={() => void loadAnalysis()}
              disabled={analysisLoading}
              className="shrink-0 rounded-lg border border-slate-600 px-3 py-2 text-xs hover:bg-slate-700 disabled:opacity-50"
            >
              {analysisLoading ? 'Yükleniyor…' : 'Yenile'}
            </button>
          </div>
          {analysisOpen && (
            <div className="mt-3 space-y-2">
              {analysisError && <p className="text-sm text-red-300" role="alert">{analysisError}</p>}
              {analysisLoading && !analysis && <p className="text-sm text-slate-400">Son analiz raporu yükleniyor…</p>}
              {!analysisLoading && !analysisError && !analysis?.report && (
                <p className="text-sm text-slate-400">Henüz kaydedilmiş bir analiz raporu bulunamadı. Otomasyonun bir sonraki başarılı analizinden sonra burada görünecek.</p>
              )}
              {analysis?.report && (
                <>
                  <p className="text-xs text-slate-400">
                    {analysis.createdAt ? `Rapor zamanı: ${new Date(analysis.createdAt).toLocaleString('tr-TR')}` : 'Son kaydedilen rapor'}
                    {analysis.provider ? ` · ${analysis.provider}` : ''}
                    {analysis.model ? ` / ${analysis.model}` : ''}
                  </p>
                  <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm leading-relaxed">{renderAnalysisReport(analysis.report)}</div>
                  <p className="text-xs text-emerald-300">Bu rapor taslakları değiştirmez ve içerik yayınlamaz. Kaynak doğrulaması ayrıca yapılmalıdır.</p>
                </>
              )}
            </div>
          )}
        </section>
        <section className="rounded-xl border border-blue-500/30 bg-slate-800/80 p-3">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setDraftPanelOpen((open) => !open)}
              aria-expanded={draftPanelOpen}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="font-semibold text-white">İçerik Taslakları</span>
              <span className="shrink-0 rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                {drafts.length} bekleyen
              </span>
              <span className="ml-auto text-slate-400" aria-hidden="true">{draftPanelOpen ? '▴' : '▾'}</span>
            </button>
            <button
              type="button"
              onClick={() => void loadDrafts()}
              disabled={draftsLoading}
              className="shrink-0 rounded-lg border border-slate-600 px-3 py-2 text-xs hover:bg-slate-700 disabled:opacity-50"
            >
              {draftsLoading ? 'Yükleniyor…' : 'Yenile'}
            </button>
          </div>
          {draftPanelOpen && (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-slate-400">Onayladığın içerik bile otomatik yayınlanmaz.</p>
              {draftsError && <p className="text-sm text-red-300" role="alert">{draftsError}</p>}
              {!draftsLoading && drafts.length === 0 && !draftsError && (
                <p className="text-sm text-slate-400">Bekleyen taslak yok. Yeni taslaklar burada görünecek.</p>
              )}
              {drafts.map((draft) => (
                <article key={draft.id} className="rounded-lg border border-slate-700 bg-slate-900 p-3 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-medium text-white">{draft.title}</h3>
                      <p className="text-xs text-slate-400">{draft.platform}{draft.topic ? ` · ${draft.topic}` : ''}</p>
                    </div>
                    <span className="rounded-full bg-amber-500/10 px-2 py-1 text-xs text-amber-300">Onay bekliyor</span>
                  </div>
                  {draft.generatedScript ? (
                    <pre className="whitespace-pre-wrap break-words text-sm text-slate-200 font-sans">{draft.generatedScript}</pre>
                  ) : (
                    <p className="text-sm text-slate-400">Bu kayıt için oluşturulmuş senaryo bulunamadı.</p>
                  )}
                  {draft.generation?.provider && (
                    <p className="text-[11px] text-slate-500">Model: {draft.generation.provider}{draft.generation.model ? ` / ${draft.generation.model}` : ''}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void reviewDraft(draft.id, 'approve_video')}
                      disabled={reviewBusyId !== null}
                      className="flex-1 rounded-lg bg-emerald-700 px-3 py-2.5 text-sm font-medium hover:bg-emerald-600 disabled:opacity-50"
                    >
                      {reviewBusyId === draft.id ? 'İşleniyor…' : 'Onayla + video oluştur'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void reviewDraft(draft.id, 'approve_text')}
                      disabled={reviewBusyId !== null}
                      className="flex-1 rounded-lg border border-slate-600 px-3 py-2.5 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
                    >
                      Onayla, videosuz
                    </button>
                    <button
                      type="button"
                      onClick={() => void reviewDraft(draft.id, 'reject')}
                      disabled={reviewBusyId !== null}
                      className="rounded-lg bg-red-900/80 px-3 py-2.5 text-sm font-medium hover:bg-red-800 disabled:opacity-50"
                    >
                      Reddet
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {videoProgress && (
            <div className="mt-3 rounded-xl border border-lime-400/25 bg-slate-950/70 p-3" role="status" aria-live="polite">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-slate-100">Video oluşturma durumu</span>
                <span className={`text-lg font-bold tabular-nums ${videoProgress.status === 'failed' ? 'text-red-300' : 'text-lime-300'}`}>{videoProgress.percentage}%</span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
                <div className={`h-full rounded-full transition-all duration-500 ${videoProgress.status === 'failed' ? 'bg-red-400' : 'bg-lime-400'}`} style={{ width: `${videoProgress.percentage}%` }} />
              </div>
              <p className="mt-2 text-xs text-slate-300">{videoProgress.stage}</p>
              {videoProgress.status === 'failed' && <p className="mt-1 text-xs text-red-300">Üretim bu aşamada başarısız oldu. Hata mesajı aşağıda gösteriliyor.</p>}
            </div>
          )}
          {reviewNotice && <p className="mt-3 text-sm text-emerald-300" role="status">{reviewNotice}</p>}
        </section>
        {messages.length === 0 && (
          <p className="text-slate-400 text-center mt-10">
            Mira hazır. Komut listesini görmek için <code className="bg-slate-800 px-2 py-1 rounded">/</code> tuşuna basabilirsin.
          </p>
        )}
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`p-3 rounded-lg max-w-[90%] ${
              msg.role === 'user'
                ? 'bg-blue-600 ml-auto text-white'
                : 'bg-slate-800 border border-slate-700 text-slate-100'
            }`}
          >
            {renderMessageContent(msg, index)}
          </div>
        ))}
        {loading && (
          <div className="bg-slate-800 p-3 rounded-lg border border-slate-700 text-slate-400 max-w-[80%] animate-pulse">
            Mira yanıt yazıyor...
          </div>
        )}
      </div>

      <div className="relative">
        {showSuggestions && (
          <div className="absolute bottom-full mb-2 left-0 right-0 bg-slate-800 border border-slate-700 rounded-lg shadow-xl overflow-hidden z-10">
            <div className="px-3 py-1.5 text-xs text-slate-400 bg-slate-850 border-b border-slate-700 font-semibold">
              Önerilen Komutlar
            </div>
            {COMMANDS.map((item, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => selectCommand(item.command)}
                className="w-full text-left px-4 py-2.5 hover:bg-slate-700 flex justify-between items-center transition-colors border-b border-slate-700/50 last:border-none"
              >
                <code className="text-blue-400 font-bold">{item.command}</code>
                <span className="text-xs text-slate-400">{item.description}</span>
              </button>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex gap-2 border-t border-slate-700 pt-3 pb-[env(safe-area-inset-bottom)]">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={handleInputChange}
            placeholder="Görev veya komut girin..."
            className="min-w-0 flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={loading}
            className="shrink-0 bg-blue-600 hover:bg-blue-500 text-white font-medium px-4 sm:px-6 py-3 rounded-lg disabled:opacity-50"
          >
            Gönder
          </button>
        </form>
      </div>
    </main>
  );
}
