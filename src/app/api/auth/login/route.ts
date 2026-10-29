import { NextResponse } from "next/server";
import { AUTH_COOKIE, SESSION_DAYS, signToken, verifyPanelPassword } from "@/lib/panel-auth";

export const runtime = "nodejs";

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
  return res;
}
