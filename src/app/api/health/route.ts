import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "gm-intelligence-board",
    mode: process.env.NEXT_PUBLIC_DEMO_MODE === "false" ? "configured" : "demo",
    timestamp: new Date().toISOString(),
  });
}
