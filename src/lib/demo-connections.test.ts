import { describe, expect, it } from "vitest";
import {
  DEMO_CONNECTION_STORAGE_KEY,
  buildDemoConnection,
  createSeedConnectionStore,
  normalizeConnectionStore,
  readConnectionStore,
  resetConnectionStore,
  setDemoConnectionStatus,
  upsertDemoConnection,
  validateConnectionInput,
  writeConnectionStore,
} from "./demo-connections";

function memoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    value: (key: string) => values.get(key),
  };
}

const input = {
  tenantId: "new-tenant-123",
  displayName: "New Home Services",
  environment: "production" as const,
  clientId: "client-sensitive-123456",
  appKey: "app-sensitive-123456",
  clientSecret: "super-secret-value",
  locationIds: ["new-location"],
};

describe("demo ServiceTitan connection domain", () => {
  it("seeds one isolated profile per demo tenant", () => {
    const store = createSeedConnectionStore();
    expect(store.connections).toHaveLength(3);
    expect(new Set(store.connections.map((item) => item.tenantId)).size).toBe(3);
    expect(new Set(store.connections.flatMap((item) => item.locationIds)).size).toBe(3);
  });

  it("masks identifiers and never persists submitted raw credentials", () => {
    const result = buildDemoConnection(input, createSeedConnectionStore().connections, undefined, "2026-08-15T12:00:00.000Z");
    expect(result.issues).toEqual([]);
    expect(result.connection).toMatchObject({ tenantId: input.tenantId, secretConfigured: true, status: "ready" });
    const serialized = JSON.stringify(result.connection);
    expect(serialized).not.toContain(input.clientId);
    expect(serialized).not.toContain(input.appKey);
    expect(serialized).not.toContain(input.clientSecret);
    expect(serialized).not.toContain("clientSecret");
    expect(serialized).not.toContain('"clientId"');
    expect(serialized).not.toContain('"appKey"');
  });

  it("requires credentials for new profiles and prevents active tenant/location duplication", () => {
    const store = createSeedConnectionStore();
    const required = validateConnectionInput({ ...input, clientId: "", appKey: "", clientSecret: "" }, store.connections);
    expect(required.map((issue) => issue.code)).toEqual(expect.arrayContaining(["client-id", "app-key", "client-secret"]));
    const duplicate = validateConnectionInput({ ...input, tenantId: "sierra", locationIds: ["sierra-abq"] }, store.connections);
    expect(duplicate.map((issue) => issue.code)).toEqual(expect.arrayContaining(["duplicate-tenant", "duplicate-location"]));
  });

  it("supports add, edit without resubmitting secrets, and archive", () => {
    let store = createSeedConnectionStore();
    const created = buildDemoConnection(input, store.connections, undefined, "2026-08-15T12:00:00.000Z").connection!;
    store = upsertDemoConnection(store, created);
    expect(store.connections).toHaveLength(4);
    const edited = buildDemoConnection({ ...input, displayName: "Renamed Services", clientId: "", appKey: "", clientSecret: "" }, store.connections, created, "2026-08-15T13:00:00.000Z").connection!;
    expect(edited).toMatchObject({ displayName: "Renamed Services", secretConfigured: true, maskedClientId: created.maskedClientId });
    store = upsertDemoConnection(store, edited);
    store = setDemoConnectionStatus(store, edited.id, "archived");
    expect(store.connections.find((item) => item.id === edited.id)?.status).toBe("archived");
  });

  it("recovers malformed storage, rejects raw-field records, writes, and resets", () => {
    const malformed = memoryStorage({ [DEMO_CONNECTION_STORAGE_KEY]: "{bad json" });
    expect(readConnectionStore(malformed).connections).toHaveLength(3);
    const store = createSeedConnectionStore();
    const storage = memoryStorage();
    expect(writeConnectionStore(store, storage)).toBe(true);
    expect(readConnectionStore(storage)).toEqual(store);
    const unsafe = { ...store, connections: [{ ...store.connections[0], clientSecret: "leak" }] };
    expect(normalizeConnectionStore(unsafe)).toBeNull();
    const reset = resetConnectionStore(storage);
    expect(readConnectionStore(storage)).toEqual(reset);
  });
});
