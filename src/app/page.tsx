'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Assistant from '@/components/Assistant';
import KartalTaskManager from '@/components/KartalTaskManager';
import { Lock } from 'lucide-react';

export default function Home() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passInput, setPassInput] = useState('');
  const [authError, setAuthError] = useState('');
  // Varsayılan görünüm: doğrudan KartaL AI Görev Yöneticisi Paneli ('classic').
  // Sesli Asistan ('orb') yalnızca kullanıcı "Sesli Asistan" butonuna tıkladığında açılır.
  const [uiMode, setUiMode] = useState<'orb' | 'classic'>(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('voice=1')) {
      return 'orb';
    }
    return 'classic';
  });

  const fetchData = useCallback(async (pass?: string) => {
    const p = pass ?? localStorage.getItem('mira_pass') ?? '';
    try {
      const res = await fetch('/api/data', { headers: { 'x-mira-pass': p } });
      if (res.status === 401) {
        setIsAuthenticated(false);
        return false;
      }
      setIsAuthenticated(true);
      return true;
    } catch (e) {
      console.error('Veri çekme hatası:', e);
      return false;
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem('mira_pass');
    if (saved) {
      setTimeout(() => {
        void fetchData(saved);
      }, 0);
    }
  }, [fetchData]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    localStorage.setItem('mira_pass', passInput);
    const ok = await fetchData(passInput);
    if (!ok) {
      setAuthError('Şifre hatalı. Tekrar dene.');
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 relative overflow-hidden">
        <div
          className="fixed inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(45% 40% at 50% 45%, rgba(99, 102, 241, 0.22), rgba(168, 85, 247, 0.08) 45%, transparent 75%)',
          }}
        />
        <form
          onSubmit={handleLogin}
          className="glass-strong p-8 sm:p-10 rounded-3xl w-full max-w-sm space-y-6 relative z-10 fade-up"
        >
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500/30 to-purple-500/20 border border-indigo-400/30 flex items-center justify-center shadow-lg shadow-indigo-500/10">
              <Lock className="text-indigo-300" size={22} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-wider uppercase text-white">KartaL AI</h1>
              <p className="text-xs text-slate-400 mt-1">
                Görev Yöneticisi ve Sesli Asistan Komuta Merkezi
              </p>
            </div>
          </div>
          <div className="space-y-3">
            <input
              type="password"
              value={passInput}
              onChange={(e) => setPassInput(e.target.value)}
              placeholder="Giriş şifresi…"
              autoFocus
              className="w-full bg-slate-950/70 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-indigo-400/60 transition-colors"
            />
            {authError && <p className="text-xs text-rose-400 text-center">{authError}</p>}
            <button
              type="submit"
              className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 py-3 rounded-xl font-semibold text-sm text-white shadow-lg shadow-indigo-600/25 transition-all"
            >
              KartaL AI&apos;ya gir
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (uiMode === 'classic') {
    return <KartalTaskManager onSwitchToVoice={() => setUiMode('orb')} />;
  }

  return (
    <div className="relative min-h-screen">
      <Assistant
        onRefresh={() => fetchData()}
        onOpenClassic={() => setUiMode('classic')}
      />
      <div className="fixed top-4 right-4 z-50 flex items-center gap-2">
        <button
          onClick={() => setUiMode('classic')}
          className="px-4 py-2 rounded-full text-xs font-semibold tracking-wide bg-white text-slate-900 hover:bg-slate-100 shadow-lg transition-all"
        >
          📋 Görev Yöneticisi Paneline Dön
        </button>
      </div>
    </div>
  );
}
