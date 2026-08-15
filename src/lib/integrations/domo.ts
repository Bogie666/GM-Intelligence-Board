const DOMO_API_BASE_URL = "https://api.domo.com";
const DOMO_OAUTH_SCOPE = "data";
const DEFAULT_TIMEOUT_MS = 15_000;

export const DOMO_REQUIRED_ENVIRONMENT = ["DOMO_CLIENT_ID", "DOMO_CLIENT_SECRET", "DOMO_ALLOWED_DATASET_IDS"] as const;

export interface DomoConfigurationStatus {
  configured: boolean;
  missing: string[];
  allowedDatasetCount: number;
  apiBaseUrl: string;
  scope: string;
}

export interface DomoClientConfig {
  clientId: string;
  clientSecret: string;
  allowedDatasetIds: string[];
  timeoutMs?: number;
}

export interface DomoDataset {
  id: string;
  name: string;
  description?: string;
  rows?: number;
  columns?: number;
  createdAt?: string;
  updatedAt?: string;
  dataCurrentAt?: string;
  owner?: { id?: string; name?: string };
  schema?: {
    columns?: Array<{ name: string; type: string }>;
  };
  pdpEnabled?: boolean;
}

export interface DomoDatasetListOptions {
  limit?: number;
  offset?: number;
  sort?:
    | "name"
    | "nameDescending"
    | "lastTouched"
    | "lastTouchedAscending"
    | "lastUpdated"
    | "lastUpdatedAscending"
    | "createdAt"
    | "createdAtAscending"
    | "cardCount"
    | "cardCountAscending"
    | "cardViewCount"
    | "cardViewCountAscending"
    | "errorState"
    | "errorStateDescending"
    | "dataSourceId";
  nameLike?: string;
}

export class DomoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomoConfigurationError";
  }
}

export class DomoApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DomoApiError";
    this.status = status;
  }
}

type DomoFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function parseAllowedDatasetIds(value: string | undefined): string[] {
  return Array.from(new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean)));
}

export function getDomoConfigurationStatus(
  environment: Record<string, string | undefined> = process.env,
): DomoConfigurationStatus {
  const missing = DOMO_REQUIRED_ENVIRONMENT.filter((key) => key === "DOMO_ALLOWED_DATASET_IDS"
    ? parseAllowedDatasetIds(environment[key]).length === 0
    : !environment[key]?.trim());
  return {
    configured: missing.length === 0,
    missing,
    allowedDatasetCount: parseAllowedDatasetIds(environment.DOMO_ALLOWED_DATASET_IDS).length,
    apiBaseUrl: DOMO_API_BASE_URL,
    scope: DOMO_OAUTH_SCOPE,
  };
}

export function createDomoClientFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
  fetchImplementation: DomoFetch = fetch,
): DomoClient {
  const status = getDomoConfigurationStatus(environment);
  if (!status.configured) {
    throw new DomoConfigurationError(`Missing required Domo configuration: ${status.missing.join(", ")}`);
  }
  return new DomoClient(
    {
      clientId: environment.DOMO_CLIENT_ID!.trim(),
      clientSecret: environment.DOMO_CLIENT_SECRET!.trim(),
      allowedDatasetIds: parseAllowedDatasetIds(environment.DOMO_ALLOWED_DATASET_IDS),
    },
    fetchImplementation,
  );
}

export class DomoClient {
  private readonly allowedDatasetIds: Set<string>;
  private readonly timeoutMs: number;
  private token?: { value: string; refreshAt: number };

  constructor(
    private readonly config: DomoClientConfig,
    private readonly fetchImplementation: DomoFetch = fetch,
  ) {
    if (!config.clientId.trim() || !config.clientSecret.trim()) {
      throw new DomoConfigurationError("Domo client ID and client secret are required.");
    }
    this.allowedDatasetIds = new Set(config.allowedDatasetIds.map((item) => item.trim()).filter(Boolean));
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.refreshAt > Date.now()) return this.token.value;

    const url = new URL("/oauth/token", DOMO_API_BASE_URL);
    url.searchParams.set("grant_type", "client_credentials");
    url.searchParams.set("scope", DOMO_OAUTH_SCOPE);
    const basicCredentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const response = await this.fetchImplementation(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${basicCredentials}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new DomoApiError("Domo OAuth token request failed.", response.status);
    }
    const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new DomoApiError("Domo OAuth response did not include an access token.", 502);
    }
    const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in > 0
      ? payload.expires_in
      : 3_600;
    const lifetimeMs = expiresIn * 1_000;
    const safetyMarginMs = Math.min(60_000, Math.max(1_000, lifetimeMs * 0.1));
    this.token = {
      value: payload.access_token,
      refreshAt: Date.now() + Math.max(0, lifetimeMs - safetyMarginMs),
    };
    return payload.access_token;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();
    const response = await this.fetchImplementation(new URL(path, DOMO_API_BASE_URL), {
      ...init,
      headers: {
        Accept: "application/json",
        ...init.headers,
        Authorization: `Bearer ${token}`,
      },
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new DomoApiError(`Domo API request failed for ${path.split("?")[0]}.`, response.status);
    }
    return response;
  }

  private assertDatasetAllowed(datasetId: string): void {
    if (!this.allowedDatasetIds.has(datasetId)) {
      throw new DomoConfigurationError(
        "The requested Domo dataset is not in DOMO_ALLOWED_DATASET_IDS.",
      );
    }
  }

  async listDatasets(options: DomoDatasetListOptions = {}): Promise<DomoDataset[]> {
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const url = new URL("/v1/datasets", DOMO_API_BASE_URL);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    if (options.sort) url.searchParams.set("sort", options.sort);
    if (options.nameLike?.trim()) url.searchParams.set("nameLike", options.nameLike.trim());
    const response = await this.request(`${url.pathname}${url.search}`);
    return (await response.json()) as DomoDataset[];
  }

  async getDataset(datasetId: string): Promise<DomoDataset> {
    this.assertDatasetAllowed(datasetId);
    const response = await this.request(`/v1/datasets/${encodeURIComponent(datasetId)}`);
    return (await response.json()) as DomoDataset;
  }

  async exportDatasetCsv(datasetId: string, includeHeader = true): Promise<string> {
    this.assertDatasetAllowed(datasetId);
    const url = new URL(`/v1/datasets/${encodeURIComponent(datasetId)}/data`, DOMO_API_BASE_URL);
    url.searchParams.set("includeHeader", String(includeHeader));
    const response = await this.request(`${url.pathname}${url.search}`, {
      headers: { Accept: "text/csv" },
    });
    return response.text();
  }

  async testConnection(): Promise<{ datasetAccess: boolean }> {
    const firstAllowedDataset = Array.from(this.allowedDatasetIds)[0];
    if (!firstAllowedDataset) {
      throw new DomoConfigurationError(
        "At least one DOMO_ALLOWED_DATASET_IDS value is required for a dataset-access test.",
      );
    }
    await this.getDataset(firstAllowedDataset);
    return { datasetAccess: true };
  }
}
