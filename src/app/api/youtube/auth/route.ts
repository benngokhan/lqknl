import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { buildAuthUrl, youtubeConfig, youtubeStatus } from "@/lib/youtube";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  return isMiraSessionCookie(req.headers.get("cookie"));
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Site giriş şifresiyle giriş yapıp bu adrese tekrar gel" }, { status: 401 });
  }
  const status = youtubeStatus();
  if (!status.configured) {
    return NextResponse.json({
      ok: false,
      error: `YouTube OAuth yapılandırılmamış. Railway env'e ekle: ${status.missing.join(", ")}`,
      guide: "docs/YOUTUBE_SETUP.md",
      redirectUri: youtubeConfig().redirectUri,
    }, { status: 502 });
  }
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(buildAuthUrl(state));
  res.cookies.set("mira_yt_state", state, {
    httpOnly: true,
    secure: true,
    // Google OAuth returns from another site; None supports browser/webview redirects.
    sameSite: "none",
    path: "/",
    maxAge: 600,
  });
  return res;
}
