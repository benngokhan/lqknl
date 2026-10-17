import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { buildDriveAuthUrl, driveStatus } from "@/lib/google-drive";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  return isMiraSessionCookie(req.headers.get("cookie"));
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Önce Mira sitesine giriş yap, sonra bu bağlantıyı aç." }, { status: 401 });
  }
  const status = driveStatus();
  if (!status.configured) {
    return NextResponse.json({
      ok: false,
      error: `Drive OAuth henüz yapılandırılmadı. Railway değişkenleri: ${status.missing.join(", ")}`,
      redirectUri: status.redirectUri,
      note: "Bu URI'yi Google Cloud'daki Mira Drive Web OAuth istemcisinin Yetkili yönlendirme URI'lerine ekle.",
    }, { status: 503 });
  }
  const state = randomBytes(24).toString("hex");
  const response = NextResponse.redirect(buildDriveAuthUrl(state));
  response.cookies.set("mira_drive_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: 600,
  });
  return response;
}
