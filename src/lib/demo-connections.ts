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
  availability?: "unavailable";
  unavailableReason?: string;
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

type UnknownRecord = Record<PropertyKey, unknown>;

const STORE_KEYS = new Set(["schemaVersion", "connections"]);
const CONNECTION_KEYS = new Set([
  "id",
  "tenantId",
  "displayName",
  "environment",
  "maskedClientId",
  "maskedAppKey",
  "secretConfigured",
  "locationIds",
  "status",
  "capabilities",
  "lastValidatedAt",
  "updatedAt",
]);
const CREDENTIAL_KEY_PARTS = ["secret", "password", "authorization", "token", "clientid", "appkey", "apikey", "bearer"];
const SAFE_CREDENTIAL_METADATA_KEYS = new Set(["maskedclientid", "maskedappkey", "secretconfigured"]);

function isRecord(value: unknown): value is UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(value: UnknownRecord, allowed: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0 || keys.some((key) => typeof key !== "string" || !allowed.has(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && "value" in descriptor);
  });
}

function hasCredentialLikeKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasCredentialLikeKey(item, seen));

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return true;
    const compactKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (!SAFE_CREDENTIAL_METADATA_KEYS.has(compactKey) && CREDENTIAL_KEY_PARTS.some((part) => compactKey.includes(part))) return true;
    if (hasCredentialLikeKey(descriptor.value, seen)) return true;
  }
  return false;
}

function validConnection(value: unknown): value is DemoServiceTitanConnection {
  if (!isRecord(value) || !hasExactDataKeys(value, CONNECTION_KEYS)) return false;
  return typeof value.id === "string" && Boolean(value.id)
    && typeof value.tenantId === "string" && Boolean(value.tenantId)
    && typeof value.displayName === "string" && Boolean(value.displayName)
    && (value.environment === "production" || value.environment === "integration")
    && typeof value.maskedClientId === "string" && typeof value.maskedAppKey === "string"
    && typeof value.secretConfigured === "boolean" && Array.isArray(value.locationIds)
    && value.locationIds.every((locationId) => typeof locationId === "string")
    && (value.status === "ready" || value.status === "needs-attention" || value.status === "archived")
    && Array.isArray(value.capabilities) && value.capabilities.every((capability) => typeof capability === "string")
    && (value.lastValidatedAt === undefined || (typeof value.lastValidatedAt === "string" && !Number.isNaN(Date.parse(value.lastValidatedAt))))
    && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt));
}

function cloneConnection(item: DemoServiceTitanConnection): DemoServiceTitanConnection {
  const clone: DemoServiceTitanConnection = {
    id: item.id,
    tenantId: item.tenantId,
    displayName: item.displayName,
    environment: item.environment,
    maskedClientId: item.maskedClientId,
    maskedAppKey: item.maskedAppKey,
    secretConfigured: item.secretConfigured,
    locationIds: item.locationIds.map((locationId) => locationId),
    status: item.status,
    capabilities: item.capabilities.map((capability) => capability),
    updatedAt: item.updatedAt,
  };
  if (item.lastValidatedAt !== undefined) clone.lastValidatedAt = item.lastValidatedAt;
  return clone;
}

function unavailableConnectionStore(reason: string): DemoConnectionStore {
  return {
    schemaVersion: DEMO_CONNECTION_SCHEMA_VERSION,
    availability: "unavailable",
    unavailableReason: reason,
    connections: [],
  };
}

export function normalizeConnectionStore(value: unknown): DemoConnectionStore | null {
  try {
    if (hasCredentialLikeKey(value) || !isRecord(value) || !hasExactDataKeys(value, STORE_KEYS)) return null;
    if (value.schemaVersion !== DEMO_CONNECTION_SCHEMA_VERSION || !Array.isArray(value.connections)) return null;
    if (!value.connections.every(validConnection)) return null;
    const connections = value.connections.map((item) => cloneConnection(item));
    if (new Set(connections.map((item) => item.id)).size !== connections.length) return null;
    const active = connections.filter((item) => item.status !== "archived");
    if (new Set(active.map((item) => item.tenantId)).size !== active.length) return null;
    const activeLocationIds = active.flatMap((item) => item.locationIds);
    if (new Set(activeLocationIds).size !== activeLocationIds.length) return null;
    return {
      schemaVersion: DEMO_CONNECTION_SCHEMA_VERSION,
      connections,
    };
  } catch {
    return null;
  }
}

export function readConnectionStore(storage: ReadStorage | undefined = browserStorage()): DemoConnectionStore {
  if (!storage) return unavailableConnectionStore("Browser connection storage is unavailable.");

  let raw: string | null;
  try {
    raw = storage.getItem(DEMO_CONNECTION_STORAGE_KEY);
  } catch {
    return unavailableConnectionStore("Browser connection storage could not be read.");
  }

  if (raw === null) {
    const seeded = createSeedConnectionStore();
    if (storage.setItem) {
      try {
        storage.setItem(DEMO_CONNECTION_STORAGE_KEY, JSON.stringify(seeded));
      } catch {
        return unavailableConnectionStore("Browser connection storage could not be initialized.");
      }
    }
    return seeded;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unavailableConnectionStore("Stored ServiceTitan connections contain malformed JSON.");
  }
  return normalizeConnectionStore(parsed)
    ?? unavailableConnectionStore("Stored ServiceTitan connections are unsafe or invalid.");
}

export function writeConnectionStore(store: DemoConnectionStore, storage: WriteStorage | undefined = browserStorage()): boolean {
  if (!storage) return false;
  const normalized = normalizeConnectionStore(store);
  if (!normalized) return false;
  try {
    storage.setItem(DEMO_CONNECTION_STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function resetConnectionStore(storage: WriteStorage | undefined = browserStorage()): DemoConnectionStore {
  const seeded = createSeedConnectionStore();
  if (!storage) return unavailableConnectionStore("Browser connection storage is unavailable.");
  try {
    storage.setItem(DEMO_CONNECTION_STORAGE_KEY, JSON.stringify(seeded));
    return seeded;
  } catch {
    return unavailableConnectionStore("Browser connection storage could not be reset.");
  }
}
