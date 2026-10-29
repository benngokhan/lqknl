import { NextResponse } from "next/server";
import { AUTH_COOKIE, SESSION_DAYS, signToken, verifyPanelPassword, verifyToken } from "@/lib/panel-auth";
import { createMiraSessionValue, isMiraSessionCookie } from "@/lib/mira-auth";

export const runtime = "nodejs";

// Oturum sorgusu (eski kök sayfanın "entered" kontrolü) — yeni veya eski oturum çerezi geçerliyse ok.
export async function GET(req: Request) {
  const cookieHeader = req.headers.get("cookie");
  const newToken = cookieHeader?.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${AUTH_COOKIE}=`))?.slice(AUTH_COOKIE.length + 1);
  const ok = verifyToken(newToken) || isMiraSessionCookie(cookieHeader);
  return NextResponse.json({ ok }, { status: ok ? 200 : 401 });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const password = typeof (body as Record<string, unknown>).password === "string"
    ? ((body as Record<string, unknown>).password as string)
    : "";
  const ok = await verifyPanelPassword(password);
  if (!ok) {
    return NextResponse.json({ ok: false, error: "Şifre yanlış" }, { status: 401 });
  }
  const { token } = signToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
  // Uyum: eski API'ler (youtube/drive/integrations) hâlâ "mira_entry" oturumunu denetler —
  // aynı anda eski biçimde oturum çerezi de set edilir (MIRA_ENTRY_PASSWORD ile imzalı).
  try {
    res.cookies.set("mira_entry", createMiraSessionValue(), {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 7 * 86_400,
    });
  } catch (e) {
    console.warn("mira_entry uyum çerezi set edilemedi:", e instanceof Error ? e.message : String(e));
  }
  return res;
}
