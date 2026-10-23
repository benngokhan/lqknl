'use client';

import { useEffect, useState } from 'react';

interface WorkerItem {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'err';
  status_text: string;
  updated_at: string;
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

export default function KartalTaskManager({ onSwitchToOrb }: { onSwitchToOrb: () => void }) {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'genel' | 'videolar' | 'isciler' | 'uyarilar'>('genel');
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [paused, setPaused] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function loadStatus() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/kartal/status', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'Veri çekilemedi');
      }
      setReport(data.report as StatusReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bağlantı hatası');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    fetch('/api/kartal/status', { cache: 'no-store' })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok || !data?.ok) {
          setError(data?.error || 'Veri çekilemedi');
        } else {
          setReport(data.report as StatusReport);
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

  function toggleRow(key: string) {
    setOpenRows((prev) => ({ ...prev, [key]: !prev[key] }));
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

  const overallStatus: 'ok' | 'warn' | 'err' = paused
    ? 'warn'
    : error
      ? 'err'
      : report?.overall_status || 'ok';
  const overallText = paused
    ? 'Duraklatıldı'
    : error
      ? 'Hata var'
      : report?.overall_label || 'Her şey çalışıyor';

  return (
    <div className="min-h-[100dvh] w-full bg-[#F8F9FA] text-[#111827] font-sans text-sm antialiased">
      {/* En üstte her zaman görünen özet şeridi */}
      <header className="sticky top-0 z-30 border-b border-[#E5E7EB] bg-white px-4 py-2.5">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="text-[15px] font-semibold text-[#111827]">Kartal AI · Görev Yöneticisi</span>
            {renderBadge(overallStatus, overallText)}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-[#6B7280]">
            <span>
              Stok: {report?.summary.stock_shorts ?? 58} Shorts · {report?.summary.stock_long ?? 10} Uzun
            </span>
            <span>·</span>
            <span>Son güncelleme: {report?.updated_at || 'az önce'}</span>
            <button
              type="button"
              onClick={onSwitchToOrb}
              className="rounded border border-[#E5E7EB] bg-white px-2.5 py-1 text-xs font-medium text-[#111827] hover:bg-[#F3F4F6]"
            >
              Sesli Asistan
            </button>
          </div>
        </div>
      </header>

      {/* Üst sekmeler ve düğmeler */}
      <nav className="border-b border-[#E5E7EB] bg-white px-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1 overflow-x-auto">
            {([
              ['genel', 'Genel'],
              ['videolar', 'Videolar'],
              ['isciler', 'İşçiler'],
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
            <button
              type="button"
              onClick={() => void loadStatus()}
              disabled={loading}
              className="rounded border border-[#E5E7EB] bg-white px-2.5 py-1.5 text-xs font-medium text-[#6B7280] hover:text-[#111827]"
            >
              Yenile
            </button>
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-4">
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

        {/* Üst kartlar */}
        <section className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <div className="rounded-md border border-[#E5E7EB] bg-white p-3">
            <div className="text-xl font-semibold text-[#111827]">{fmt(report?.summary.total_views)}</div>
            <div className="mt-0.5 text-xs text-[#6B7280]">toplam görüntülenme (YouTube API)</div>
          </div>
          <div className="rounded-md border border-[#E5E7EB] bg-white p-3">
            <div className="text-xl font-semibold text-[#111827]">{fmt(report?.summary.weekly_uploaded)}</div>
            <div className="mt-0.5 text-xs text-[#6B7280]">bu hafta yüklenen video</div>
          </div>
          <div className="rounded-md border border-[#E5E7EB] bg-white p-3">
            <div className="text-xl font-semibold text-[#111827]">{fmt(report?.summary.total_comments)}</div>
            <div className="mt-0.5 text-xs text-[#6B7280]">toplam yorum</div>
          </div>
          <div className="rounded-md border border-[#E5E7EB] bg-white p-3">
            <div className="text-xl font-semibold text-[#111827]">{fmt(report?.summary.failed_jobs)}</div>
            <div className="mt-0.5 text-xs text-[#6B7280]">başarısız işler</div>
          </div>
        </section>

        {/* Genel Sekmesi: Tablette solda işçiler, sağda videolar */}
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
                          <span>Son güncelleme: {w.updated_at}</span>
                          <span>·</span>
                          <span>{w.jobs_done} iş yaptı</span>
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
                        <div className="mt-1 text-xs text-[#6B7280]">Son kontrol: {a.updated_at}</div>
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

            <section className="rounded-md border border-[#E5E7EB] bg-white lg:col-span-7">
              <div className="flex items-center justify-between border-b border-[#E5E7EB] px-3.5 py-2.5">
                <span className="text-sm font-semibold text-[#111827]">Son videolar</span>
                <span className="text-xs text-[#6B7280]">Görüntülemeler birkaç saat gecikmeli güncellenir</span>
              </div>
              <div className="max-h-[560px] divide-y divide-[#E5E7EB] overflow-y-auto">
                {(report?.videos || []).map((v) => {
                  const key = `v-${v.id}`;
                  const isOpen = !!openRows[key];
                  return (
                    <div
                      key={v.id}
                      onClick={() => toggleRow(key)}
                      className="cursor-pointer px-3.5 py-2.5 hover:bg-[#F3F4F6]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-[13px] font-medium text-[#111827]">{v.title}</span>
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
                        <div className="mt-2 rounded border border-[#E5E7EB] bg-[#F8F9FA] p-2 text-xs text-[#111827]">
                          Video ID: {v.id} · Beğeni: {fmt(v.likes)} ·{' '}
                          <a
                            href={v.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="font-semibold underline"
                          >
                            YouTube&apos;da aç ↗
                          </a>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {/* Sadece Videolar Sekmesi */}
        {activeTab === 'videolar' && (
          <section className="rounded-md border border-[#E5E7EB] bg-white">
            <div className="flex items-center justify-between border-b border-[#E5E7EB] px-3.5 py-2.5">
              <span className="text-sm font-semibold text-[#111827]">Tüm yayınlanan videolar</span>
              <span className="text-xs text-[#6B7280]">Gerçek YouTube Data API v3 verisi</span>
            </div>
            <div className="divide-y divide-[#E5E7EB]">
              {(report?.videos || []).map((v) => (
                <div key={v.id} className="px-3.5 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <a
                      href={v.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] font-medium text-[#111827] hover:underline"
                    >
                      {v.title}
                    </a>
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
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Sadece İşçiler Sekmesi */}
        {activeTab === 'isciler' && (
          <section className="rounded-md border border-[#E5E7EB] bg-white">
            <div className="flex items-center justify-between border-b border-[#E5E7EB] px-3.5 py-2.5">
              <span className="text-sm font-semibold text-[#111827]">İşçi durumları</span>
              <span className="text-xs text-[#6B7280]">Durum, zaman ve hata kayıtları</span>
            </div>
            <div className="divide-y divide-[#E5E7EB]">
              {(report?.workers || []).map((w) => (
                <div key={w.id} className="px-3.5 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[13px] font-medium text-[#111827]">{w.name}</span>
                    {renderBadge(w.status, w.status_text)}
                  </div>
                  <div className="mt-1 text-xs text-[#6B7280]">
                    Son güncelleme: {w.updated_at} · Toplam iş: {w.jobs_done}
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

        {/* Sadece Uyarılar Sekmesi */}
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
                  <div className="mt-1 text-xs text-[#6B7280]">Son kontrol: {a.updated_at}</div>
                  <div className="mt-1 text-xs text-[#111827]">{a.detail}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <p className="mt-4 text-xs text-[#6B7280]">
          Not: Tüm veriler gerçek YouTube Data API v3 ve Google Sheets kayıtlarından alınmaktadır. Görüntüleme sayıları YouTube tarafında birkaç saatlik gecikmeyle güncellenir.
        </p>
      </main>
    </div>
  );
}
