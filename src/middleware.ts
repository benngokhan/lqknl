// Panel kilidi — tüm sayfa ve API'ler şifreli oturum gerektirir.
// Dış sağlayıcılardan (Google OAuth) gelen callback'ler ve auth route'lar serbest.
import { NextResponse, type NextRequest } from "next/server";

const AUTH_COOKIE = "kpn_auth";
const AUTH_SECRET = process.env.PANEL_AUTH_SECRET?.trim() || "kpn-static-fallback-7f3a9c21b8e4";

const PUBLIC_PATHS = new Set([
  "/login",
  "/health",
  "/privacy",
  "/terms",
  "/analytics/oauth/callback",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/drive/auth/callback",
  "/api/youtube/auth/callback",
]);

async function tokenOk(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (!token) return false;
  const i = token.indexOf(".");
  if (i < 1) return false;
  const exp = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return false;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(AUTH_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(exp));
    const hex = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hex === sig;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith("/api/auth/")) return NextResponse.next();
  if (await tokenOk(req)) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "giriş gerekli" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // _next varlıkları, statik dosyalar ve ikonlar hariç her şey
  matcher: ["/((?!_next/|favicon.ico|icon.svg|icon.png|icon.jpg|apple-icon.jpg|apple-icon.png|manifest.webmanifest|robots.txt|.*\\.(?:svg|png|jpe?g|webp|gif|ico|txt|map|webmanifest)$).*)"],
};
