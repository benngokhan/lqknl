import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";
import { debugYoutubeOAuth, getMyChannel, loadYoutubeTokens, saveYoutubeTokens, youtubeConfig, youtubeStatus } from "@/lib/youtube";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (secret && req.headers.get("x-mira-key") === secret) return true;
  return isMiraSessionCookie(req.headers.get("cookie"));
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const configStatus = youtubeStatus();
  const tokens = await loadYoutubeTokens().catch(() => null);
  const envRefresh = Boolean(process.env.YOUTUBE_REFRESH_TOKEN);

  const result: Record<string, unknown> = {
    ok: configStatus.configured && (Boolean(tokens) || envRefresh),
    oauthConfigured: configStatus.configured,
    missingEnv: configStatus.missing,
    redirectUri: youtubeConfig().redirectUri,
    connected: Boolean(tokens) || envRefresh,
    tagManagementScopeGranted: tokens ? (tokens.scope || "").split(/\s+/).includes("https://www.googleapis.com/auth/youtube.force-ssl") : envRefresh ? null : false,
    commentScopeRequired: "https://www.googleapis.com/auth/youtube.force-ssl",
    oauthScopeCheck: "Use ?check=oauth to inspect live Google token scopes.",
    uploadScopeGranted: tokens?.scope?.split(/\s+/).includes("https://www.googleapis.com/auth/youtube.upload") ?? false,
    channelTitle: tokens?.channelTitle ?? null,
    refreshTokenStored: tokens ? `${tokens.refreshToken.slice(0, 6)}…(gizli)` : envRefresh ? "env üzerinden" : null,
    defaultPrivacy: process.env.YOUTUBE_DEFAULT_PRIVACY || "private",
    steps: {
      connect: "/api/youtube/auth (site şifresiyle giriş sonrası)",
      uploadExample: 'POST /api/youtube/upload {"contentId": 123}',
    },
  };

  const check = new URL(req.url).searchParams.get("check");

  // ?check=oauth inspects the actual live access-token scopes, not only the saved consent metadata.
  if (check === "oauth") {
    try {
      const oauth = await debugYoutubeOAuth();
      result.liveOAuthScopes = oauth.scopes;
      result.liveCommentScopeGranted = oauth.scopes.includes("https://www.googleapis.com/auth/youtube.force-ssl");
      result.liveUploadScopeGranted = oauth.uploadScopeGranted;
      result.reconnectUrl = "/api/youtube/auth";
    } catch (error) {
      result.oauthScopeCheckError = error instanceof Error ? error.message : String(error);
    }
  }

  // ?check=channel → 1 kota birimi harcar, kanalı canlı doğrular
  if (check === "channel") {
    try {
      const channel = await getMyChannel();
      result.channelLive = channel;
      if (tokens) {
        await saveYoutubeTokens({ ...tokens, channelId: channel.channelId, channelTitle: channel.channelTitle }).catch(() => {});
      }
    } catch (error) {
      result.channelLive = null;
      result.channelError = error instanceof Error ? error.message : String(error);
    }
  }

  return NextResponse.json(result);
}
