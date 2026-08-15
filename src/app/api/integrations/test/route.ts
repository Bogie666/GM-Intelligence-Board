import { NextResponse } from "next/server";
import { getDomoConfigurationStatus } from "@/lib/integrations/domo";

const domoCapabilities = [
  "dataset-catalog",
  "dataset-metadata",
  "csv-export",
  "historical-financial-data",
  "allowlisted-dataset-access",
];

function testDomoConfiguration() {
  const status = getDomoConfigurationStatus();
  if (!status.configured) {
    return NextResponse.json({
      ok: false,
      configured: false,
      mode: "server-configuration-required",
      message: `Domo connector framework is ready. Add these server environment variables: ${status.missing.join(", ")}.`,
      capabilities: domoCapabilities,
    });
  }

  return NextResponse.json({
    ok: true,
    configured: true,
    mode: "configuration-only",
    message: "Domo OAuth configuration is present. Live credential use is intentionally disabled in this public prototype until authenticated admin RBAC, throttling, and audit logging are implemented.",
    capabilities: domoCapabilities,
    allowedDatasetCount: status.allowedDatasetCount,
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const provider = String(body.provider || "");

  if (provider === "domo") return testDomoConfiguration();

  if (provider !== "servicetitan") {
    return NextResponse.json({ ok: false, message: "Unsupported integration provider." }, { status: 400 });
  }

  const tenantId = String(body.tenantId || "").trim();
  const clientId = String(body.clientId || "").trim();
  const appKey = String(body.appKey || "").trim();
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
