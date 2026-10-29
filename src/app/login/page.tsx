"use client";
import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(data.error || "Şifre yanlış");
        setBusy(false);
        return;
      }
      window.location.replace("/v2");
    } catch {
      setError("Bağlantı hatası — tekrar dene.");
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#0b0718] px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.04] p-8 shadow-2xl"
      >
        <div className="mb-6 text-center">
          <div className="text-4xl">🦅</div>
          <h1 className="mt-3 text-xl font-bold text-white">KartaL Panel</h1>
          <p className="mt-1 text-sm text-white/50">Girmek için şifreni gir.</p>
        </div>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Şifre"
          className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white placeholder-white/30 outline-none focus:border-amber-400/60"
        />
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="mt-5 w-full rounded-xl bg-amber-400 py-3 font-semibold text-black transition hover:bg-amber-300 disabled:opacity-40"
        >
          {busy ? "Giriliyor…" : "Giriş Yap"}
        </button>
      </form>
    </main>
  );
}
