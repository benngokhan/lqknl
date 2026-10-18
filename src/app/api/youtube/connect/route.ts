import { NextResponse } from "next/server";

/**
 * Backward-compatible entry point. Keep all OAuth state, scopes, redirect URI,
 * and session checks in the canonical auth route so this alias cannot drift.
 */
export async function GET(req: Request) {
  return NextResponse.redirect(new URL("/api/youtube/auth", req.url), 307);
}
