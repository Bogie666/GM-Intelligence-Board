import { NextResponse, type NextRequest } from "next/server";
import { getTenantAuthContext, isAdminRole } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import { getDomoConfigurationStatus } from "@/lib/integrations/domo";

const MAX_BODY_BYTES = 16_384;
const domoCapabilities = [
  "dataset-catalog",
  "dataset-metadata",
  "csv-export",
  "historical-financial-data",
  "allowlisted-dataset-access",
];

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function hasValidOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === host && (originUrl.protocol === "https:" || originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function testDomoConfiguration() {
  const status = getDomoConfigurationStatus();
  if (!status.configured) {
    return json({
      ok: false,
      configured: false,
      mode: "server-configuration-required",
      message: "The server-side Domo connector is not fully configured.",
      capabilities: domoCapabilities,
    });
  }

  return json({
    ok: true,
    configured: true,
    mode: "configuration-only",
    message: "Domo server configuration is present. This endpoint does not use or return credentials.",
    capabilities: domoCapabilities,
    allowedDatasetCount: status.allowedDatasetCount,
  });
}

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return json({ ok: false, message: "Invalid request origin." }, 403);

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ ok: false, message: "Request body is too large." }, 413);
  }

  const config = getAppConfig();
  if (!config.isDemo) {
    const auth = await getTenantAuthContext();
    if (!auth.ok) {
      return json(
        { ok: false, message: auth.reason === "unauthenticated" ? "Authentication required." : "Tenant membership could not be verified." },
        auth.reason === "unauthenticated" ? 401 : 403,
      );
    }
    if (!isAdminRole(auth.membership.role)) {
      return json({ ok: false, message: "Tenant administrator access is required." }, 403);
    }
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, message: "Request body is too large." }, 413);
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }
  if (!body) return json({ ok: false, message: "A valid JSON object is required." }, 400);
  const provider = typeof body.provider === "string" ? body.provider : "";

  if (provider === "domo") return testDomoConfiguration();
  if (provider !== "servicetitan") {
    return json({ ok: false, message: "Unsupported integration provider." }, 400);
  }

  if (!config.isDemo) {
    return json(
      {
        ok: false,
        mode: "managed-secret-required",
        message: "Raw ServiceTitan credentials are never accepted by this application route. Store them in the approved secret manager, then register only the opaque reference in tenant administration. A trusted worker must validate the connection.",
      },
      409,
    );
  }

  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const appKey = typeof body.appKey === "string" ? body.appKey.trim() : "";
  if (!tenantId || !clientId || !appKey) {
    return json({ ok: false, message: "Tenant ID, Client ID, and App Key are required." }, 400);
  }

  return json({
    ok: true,
    mode: "demo-validation-only",
    message: "Configuration shape validated. Demo mode did not contact ServiceTitan or persist credentials.",
    capabilities: ["jobs", "appointments", "estimates", "memberships", "call-center"],
  });
}
