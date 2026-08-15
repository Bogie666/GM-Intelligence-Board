import { describe, expect, it, vi } from "vitest";
import {
  createDomoClientFromEnvironment,
  DomoClient,
  DomoConfigurationError,
  getDomoConfigurationStatus,
} from "./domo";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Domo connector", () => {
  it("reports missing server-only OAuth configuration without exposing values", () => {
    expect(getDomoConfigurationStatus({})).toEqual({
      configured: false,
      missing: ["DOMO_CLIENT_ID", "DOMO_CLIENT_SECRET", "DOMO_ALLOWED_DATASET_IDS"],
      allowedDatasetCount: 0,
      apiBaseUrl: "https://api.domo.com",
      scope: "data",
    });

    const status = getDomoConfigurationStatus({
      DOMO_CLIENT_ID: "client-id",
      DOMO_CLIENT_SECRET: "secret-value",
      DOMO_ALLOWED_DATASET_IDS: "finance-1, finance-2, finance-1",
    });
    expect(status).toEqual({
      configured: true,
      missing: [],
      allowedDatasetCount: 2,
      apiBaseUrl: "https://api.domo.com",
      scope: "data",
    });
    expect(JSON.stringify(status)).not.toContain("secret-value");
  });

  it("uses client-credentials OAuth, clamps pagination, and caches the access token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/oauth/token")) {
        return jsonResponse({ access_token: "access-token", expires_in: 3600 });
      }
      return jsonResponse([{ id: "dataset-1", name: "Historical Financials" }]);
    });
    const client = new DomoClient(
      { clientId: "client-id", clientSecret: "client-secret", allowedDatasetIds: [] },
      fetchMock,
    );

    await client.listDatasets({ limit: 500, offset: -4, sort: "lastUpdated", nameLike: " finance " });
    await client.listDatasets({ limit: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const tokenUrl = new URL(calls[0].url);
    expect(tokenUrl.pathname).toBe("/oauth/token");
    expect(tokenUrl.searchParams.get("grant_type")).toBe("client_credentials");
    expect(tokenUrl.searchParams.get("scope")).toBe("data");
    const tokenHeaders = new Headers(calls[0].init?.headers);
    expect(calls[0].init?.method).toBe("GET");
    expect(tokenHeaders.get("Authorization")).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );

    const datasetUrl = new URL(calls[1].url);
    expect(datasetUrl.pathname).toBe("/v1/datasets");
    expect(datasetUrl.searchParams.get("limit")).toBe("50");
    expect(datasetUrl.searchParams.get("offset")).toBe("0");
    expect(datasetUrl.searchParams.get("sort")).toBe("lastUpdated");
    expect(datasetUrl.searchParams.get("nameLike")).toBe("finance");
    expect(new Headers(calls[1].init?.headers).get("Authorization")).toBe("Bearer access-token");
  });

  it("refreshes a short-lived token before the issuer-declared expiry", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-15T04:00:00.000Z"));
      let tokenRequests = 0;
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes("/oauth/token")) {
          tokenRequests += 1;
          return jsonResponse({ access_token: `token-${tokenRequests}`, expires_in: 30 });
        }
        return jsonResponse([]);
      });
      const client = new DomoClient(
        { clientId: "client-id", clientSecret: "client-secret", allowedDatasetIds: [] },
        fetchMock,
      );

      await client.listDatasets({ limit: 1 });
      await vi.advanceTimersByTimeAsync(28_000);
      await client.listDatasets({ limit: 1 });

      expect(tokenRequests).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("denies dataset reads unless the dataset is explicitly allowlisted", async () => {
    const fetchMock = vi.fn();
    const client = new DomoClient(
      { clientId: "client-id", clientSecret: "client-secret", allowedDatasetIds: ["approved"] },
      fetchMock,
    );

    await expect(client.getDataset("not-approved")).rejects.toBeInstanceOf(DomoConfigurationError);
    await expect(client.exportDatasetCsv("not-approved")).rejects.toBeInstanceOf(DomoConfigurationError);
    const clientWithoutAllowlist = new DomoClient(
      { clientId: "client-id", clientSecret: "client-secret", allowedDatasetIds: [] },
      fetchMock,
    );
    await expect(clientWithoutAllowlist.testConnection()).rejects.toBeInstanceOf(DomoConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exports only allowlisted datasets as CSV with headers", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/oauth/token")) return jsonResponse({ access_token: "token", expires_in: 3600 });
      return new Response("center,revenue\nDallas,100", { status: 200, headers: { "Content-Type": "text/csv" } });
    });
    const client = createDomoClientFromEnvironment(
      {
        DOMO_CLIENT_ID: "client-id",
        DOMO_CLIENT_SECRET: "client-secret",
        DOMO_ALLOWED_DATASET_IDS: "financial-history",
      },
      fetchMock,
    );

    const csv = await client.exportDatasetCsv("financial-history");
    expect(csv).toBe("center,revenue\nDallas,100");
    const exportUrl = new URL(calls[1].url);
    expect(exportUrl.pathname).toBe("/v1/datasets/financial-history/data");
    expect(exportUrl.searchParams.get("includeHeader")).toBe("true");
    expect(new Headers(calls[1].init?.headers).get("Accept")).toBe("text/csv");
  });
});
