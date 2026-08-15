export const DEMO_CONNECTION_STORAGE_KEY = "gmib.servicetitan-connections.v1";
export const DEMO_CONNECTION_SCHEMA_VERSION = 1 as const;

export type ServiceTitanEnvironment = "production" | "integration";
export type ServiceTitanConnectionStatus = "ready" | "needs-attention" | "archived";

export interface DemoServiceTitanConnection {
  id: string;
  tenantId: string;
  displayName: string;
  environment: ServiceTitanEnvironment;
  maskedClientId: string;
  maskedAppKey: string;
  secretConfigured: boolean;
  locationIds: string[];
  status: ServiceTitanConnectionStatus;
  capabilities: string[];
  lastValidatedAt?: string;
  updatedAt: string;
}

export interface DemoServiceTitanConnectionInput {
  id?: string;
  tenantId: string;
  displayName: string;
  environment: ServiceTitanEnvironment;
  clientId?: string;
  appKey?: string;
  clientSecret?: string;
  locationIds: string[];
}

export interface DemoConnectionStore {
  schemaVersion: typeof DEMO_CONNECTION_SCHEMA_VERSION;
  connections: DemoServiceTitanConnection[];
}

export interface ConnectionValidationIssue {
  code: string;
  field: keyof DemoServiceTitanConnectionInput | "store";
  message: string;
}

type ReadStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>;
type WriteStorage = Pick<Storage, "setItem">;

const CAPABILITIES = ["jobs", "appointments", "estimates", "memberships", "call-center"];
const seedUpdatedAt = "2026-08-01T00:00:00.000Z";

const seedProfiles: Array<Pick<DemoServiceTitanConnection, "id" | "tenantId" | "displayName" | "locationIds">> = [
  { id: "st-sierra", tenantId: "sierra", displayName: "Sierra Home Services", locationIds: ["sierra-abq"] },
  { id: "st-asi", tenantId: "asi", displayName: "ASI Hastings", locationIds: ["asi-san-diego"] },
  { id: "st-swan", tenantId: "swan", displayName: "Swan Plumbing, Heating & Air", locationIds: ["swan-denver"] },
];

export function createSeedConnectionStore(): DemoConnectionStore {
  return {
    schemaVersion: DEMO_CONNECTION_SCHEMA_VERSION,
    connections: seedProfiles.map((profile) => ({
      ...profile,
      environment: "production",
      maskedClientId: "demo••••client",
      maskedAppKey: "demo••••key",
      secretConfigured: true,
      status: "ready",
      capabilities: [...CAPABILITIES],
      lastValidatedAt: seedUpdatedAt,
      updatedAt: seedUpdatedAt,
    })),
  };
}

function browserStorage(): Storage | undefined {
  try { return typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage; } catch { return undefined; }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function maskCredential(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 6) return "••••••";
  return `${trimmed.slice(0, 3)}••••${trimmed.slice(-3)}`;
}

export function createDemoConnectionId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  return typeof randomUuid === "function"
    ? `st-${randomUuid.call(globalThis.crypto)}`
    : `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function validateConnectionInput(
  input: DemoServiceTitanConnectionInput,
  existingConnections: DemoServiceTitanConnection[],
  current?: DemoServiceTitanConnection,
): ConnectionValidationIssue[] {
  const issues: ConnectionValidationIssue[] = [];
  const add = (code: string, field: ConnectionValidationIssue["field"], message: string) => issues.push({ code, field, message });
  if (input.displayName.trim().length < 3) add("display-name", "displayName", "Enter a connection name.");
  if (!input.tenantId.trim()) add("tenant-id", "tenantId", "Enter the ServiceTitan tenant ID.");
  if (!input.locationIds.length) add("locations", "locationIds", "Assign at least one operating location.");
  if (!current && !input.clientId?.trim()) add("client-id", "clientId", "Enter a Client ID for a new profile.");
  if (!current && !input.appKey?.trim()) add("app-key", "appKey", "Enter an App Key for a new profile.");
  if (!current && !input.clientSecret?.trim()) add("client-secret", "clientSecret", "Enter a Client Secret for a new profile.");
  if (existingConnections.some((connection) => connection.id !== current?.id && connection.status !== "archived" && connection.tenantId === input.tenantId.trim())) {
    add("duplicate-tenant", "tenantId", "An active connection already owns this ServiceTitan tenant ID.");
  }
  const assignedElsewhere = new Set(existingConnections.filter((connection) => connection.id !== current?.id && connection.status !== "archived").flatMap((connection) => connection.locationIds));
  if (input.locationIds.some((locationId) => assignedElsewhere.has(locationId))) {
    add("duplicate-location", "locationIds", "An operating location can belong to only one active ServiceTitan connection.");
  }
  return issues;
}

export function buildDemoConnection(
  input: DemoServiceTitanConnectionInput,
  existingConnections: DemoServiceTitanConnection[],
  current?: DemoServiceTitanConnection,
  now = new Date().toISOString(),
): { connection?: DemoServiceTitanConnection; issues: ConnectionValidationIssue[] } {
  const normalized = { ...input, tenantId: input.tenantId.trim(), displayName: input.displayName.trim(), locationIds: unique(input.locationIds) };
  const issues = validateConnectionInput(normalized, existingConnections, current);
  if (issues.length) return { issues };
  const maskedClientId = input.clientId?.trim() ? maskCredential(input.clientId) : current?.maskedClientId ?? "";
  const maskedAppKey = input.appKey?.trim() ? maskCredential(input.appKey) : current?.maskedAppKey ?? "";
  const secretConfigured = Boolean(input.clientSecret?.trim() || current?.secretConfigured);
  return {
    issues,
    connection: {
      id: current?.id ?? input.id ?? createDemoConnectionId(),
      tenantId: normalized.tenantId,
      displayName: normalized.displayName,
      environment: input.environment,
      maskedClientId,
      maskedAppKey,
      secretConfigured,
      locationIds: normalized.locationIds,
      status: maskedClientId && maskedAppKey && secretConfigured ? "ready" : "needs-attention",
      capabilities: [...CAPABILITIES],
      lastValidatedAt: now,
      updatedAt: now,
    },
  };
}

export function upsertDemoConnection(store: DemoConnectionStore, connection: DemoServiceTitanConnection): DemoConnectionStore {
  const exists = store.connections.some((item) => item.id === connection.id);
  return { ...store, connections: exists ? store.connections.map((item) => item.id === connection.id ? connection : item) : [...store.connections, connection] };
}

export function setDemoConnectionStatus(store: DemoConnectionStore, id: string, status: ServiceTitanConnectionStatus, now = new Date().toISOString()): DemoConnectionStore {
  return { ...store, connections: store.connections.map((connection) => connection.id === id ? { ...connection, status, updatedAt: now } : connection) };
}

function validConnection(value: unknown): value is DemoServiceTitanConnection {
  if (!value || typeof value !== "object") return false;
  const item = value as DemoServiceTitanConnection;
  return typeof item.id === "string" && Boolean(item.id)
    && typeof item.tenantId === "string" && Boolean(item.tenantId)
    && typeof item.displayName === "string" && Boolean(item.displayName)
    && (item.environment === "production" || item.environment === "integration")
    && typeof item.maskedClientId === "string" && typeof item.maskedAppKey === "string"
    && typeof item.secretConfigured === "boolean" && Array.isArray(item.locationIds)
    && item.locationIds.every((locationId) => typeof locationId === "string")
    && ["ready", "needs-attention", "archived"].includes(item.status)
    && Array.isArray(item.capabilities) && item.capabilities.every((capability) => typeof capability === "string")
    && typeof item.updatedAt === "string" && !Number.isNaN(Date.parse(item.updatedAt))
    && !("clientSecret" in item) && !("clientId" in item) && !("appKey" in item);
}

export function normalizeConnectionStore(value: unknown): DemoConnectionStore | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as DemoConnectionStore;
  if (candidate.schemaVersion !== DEMO_CONNECTION_SCHEMA_VERSION || !Array.isArray(candidate.connections) || !candidate.connections.every(validConnection)) return null;
  if (new Set(candidate.connections.map((item) => item.id)).size !== candidate.connections.length) return null;
  const active = candidate.connections.filter((item) => item.status !== "archived");
  if (new Set(active.map((item) => item.tenantId)).size !== active.length) return null;
  if (new Set(active.flatMap((item) => item.locationIds)).size !== active.flatMap((item) => item.locationIds).length) return null;
  return { schemaVersion: DEMO_CONNECTION_SCHEMA_VERSION, connections: candidate.connections.map((item) => ({ ...item, locationIds: [...item.locationIds], capabilities: [...item.capabilities] })) };
}

export function readConnectionStore(storage: ReadStorage | undefined = browserStorage()): DemoConnectionStore {
  const fallback = createSeedConnectionStore();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(DEMO_CONNECTION_STORAGE_KEY);
    if (!raw) { storage.setItem?.(DEMO_CONNECTION_STORAGE_KEY, JSON.stringify(fallback)); return fallback; }
    return normalizeConnectionStore(JSON.parse(raw)) ?? fallback;
  } catch { return fallback; }
}

export function writeConnectionStore(store: DemoConnectionStore, storage: WriteStorage | undefined = browserStorage()): boolean {
  if (!storage || !normalizeConnectionStore(store)) return false;
  try { storage.setItem(DEMO_CONNECTION_STORAGE_KEY, JSON.stringify(store)); return true; } catch { return false; }
}

export function resetConnectionStore(storage: WriteStorage | undefined = browserStorage()): DemoConnectionStore {
  const seeded = createSeedConnectionStore();
  if (storage) { try { storage.setItem(DEMO_CONNECTION_STORAGE_KEY, JSON.stringify(seeded)); } catch { /* return in-memory seeds */ } }
  return seeded;
}
