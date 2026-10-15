import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const clientId = process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "";
  if (!clientId) {
    return NextResponse.json(
      { error: "YOUTUBE_CLIENT_ID tanımlı değil. Railway → Mira → Variables'a ekle." },
      { status: 500 }
    );
  }
  const origin = new URL(req.url).origin;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI || `${origin}/api/youtube/callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "https://www.googleapis.com/auth/youtube.upload");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return NextResponse.redirect(url.toString());
}