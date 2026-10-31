import { NextResponse } from 'next/server';
import { isMiraSessionCookie } from '@/lib/mira-auth';
import { handleKartal } from '@/lib/kartal-v2/brain';
import { kartalServices } from '@/lib/kartal-v2/services';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// The browser and Android client must send a same-origin JSON POST. No bearer
// tokens, query-string secrets, wildcard CORS, or unauthenticated fallback.
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && parsed.protocol === 'http:')) && parsed.host === host;
  } catch { return false; }
}

export async function POST(req: Request) {
  if (!isMiraSessionCookie(req.headers.get('cookie'))) {
    return NextResponse.json({ ok: false, reply: 'Oturum bulunamadı. Panelden tekrar giriş yap.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!sameOrigin(req)) return NextResponse.json({ ok: false, reply: 'Güvenli bağlantı doğrulanamadı.' }, { status: 403 });
  if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ ok: false, reply: 'Geçersiz istek.' }, { status: 415 });
  }
  const length = Number(req.headers.get('content-length') || '0');
  if (length > 32_000) return NextResponse.json({ ok: false, reply: 'Mesaj çok uzun.' }, { status: 413 });
  const raw = await req.text();
  if (raw.length > 32_000) return NextResponse.json({ ok: false, reply: 'Mesaj çok uzun.' }, { status: 413 });
  let body: { message?: unknown; history?: unknown };
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ ok: false, reply: 'Geçersiz istek.' }, { status: 400 }); }
  const result = await handleKartal(body?.message, body?.history, kartalServices);
  return NextResponse.json(result, { status: result.kind === 'input' ? 400 : 200, headers: { 'Cache-Control': 'no-store' } });
}
