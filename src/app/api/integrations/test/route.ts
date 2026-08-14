import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const provider = String(body.provider || "");
  const tenantId = String(body.tenantId || "").trim();
  const clientId = String(body.clientId || "").trim();
  const appKey = String(body.appKey || "").trim();

  if (provider !== "servicetitan") {
    return NextResponse.json({ ok: false, message: "Unsupported integration provider." }, { status: 400 });
  }
  if (!tenantId || !clientId || !appKey) {
    return NextResponse.json(
      { ok: false, message: "Tenant ID, Client ID, and App Key are required." },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    mode: "validation-only",
    message: "Configuration shape validated. Demo mode did not contact ServiceTitan.",
    capabilities: ["jobs", "appointments", "estimates", "memberships", "call-center"],
  });
}
