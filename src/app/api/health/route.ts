import { NextResponse } from "next/server";

import { getAppConfig } from "@/lib/env";
import { checkDatabaseHealth } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = getAppConfig();
  const database = await checkDatabaseHealth();
  const ok = config.isDemo
    ? true
    : database.configured && database.reachable && database.schemaReady;

  const commitSha = process.env.GM_BUILD_SHA?.trim() || process.env.VERCEL_GIT_COMMIT_SHA?.trim() || null;
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim() || process.env.VERCEL_URL?.trim() || null;

  return NextResponse.json(
    {
      ok,
      service: "gm-intelligence-board",
      mode: config.mode,
      build: { commitSha, deploymentId },
      database,
      timestamp: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
