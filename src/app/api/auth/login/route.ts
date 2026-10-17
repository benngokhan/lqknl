import { NextResponse } from 'next/server';
import { createMiraSessionValue, isMiraSessionCookie } from '@/lib/mira-auth';

const ENTRY_COOKIE = 'mira_entry';

// Check the existing session cookie so the app can restore login after refresh.
export async function GET(req: Request) {
  const hasSession = isMiraSessionCookie(req.headers.get("cookie"));

  if (!hasSession) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  const expected = process.env.MIRA_ENTRY_PASSWORD?.trim();

  if (!expected) {
    return NextResponse.json(
      { error: 'MIRA_ENTRY_PASSWORD Railway ortam değişkeninde tanımlanmamış.' },
      { status: 503 },
    );
  }

  try {
    const { password } = await req.json();

    if (typeof password !== 'string' || password !== expected) {
      return NextResponse.json({ error: 'Şifre yanlış.' }, { status: 401 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(ENTRY_COOKIE, createMiraSessionValue(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });

    return response;
  } catch {
    return NextResponse.json({ error: 'Geçersiz giriş isteği.' }, { status: 400 });
  }
}
