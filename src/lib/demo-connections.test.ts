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

function expectUnavailable(store: ReturnType<typeof readConnectionStore>) {
  expect(store.availability).toBe("unavailable");
  expect(store.connections).toEqual([]);
  expect(store.unavailableReason).toEqual(expect.any(String));
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
    expect(store.availability).toBeUndefined();
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

  it("seeds and persists defaults only when the storage key is absent", () => {
    const storage = memoryStorage();
    const store = readConnectionStore(storage);
    expect(store).toEqual(createSeedConnectionStore());
    expect(JSON.parse(storage.value(DEMO_CONNECTION_STORAGE_KEY)!)).toEqual(store);
  });

  it("fails closed for malformed or unsafe existing storage", () => {
    const malformed = memoryStorage({ [DEMO_CONNECTION_STORAGE_KEY]: "{bad json" });
    expectUnavailable(readConnectionStore(malformed));

    const store = createSeedConnectionStore();
    const unsafe = { ...store, connections: [{ ...store.connections[0], accessToken: "leak" }] };
    const unsafeStorage = memoryStorage({ [DEMO_CONNECTION_STORAGE_KEY]: JSON.stringify(unsafe) });
    expectUnavailable(readConnectionStore(unsafeStorage));
    expect(normalizeConnectionStore(unsafe)).toBeNull();

    const unknown = { ...store, connections: [{ ...store.connections[0], harmlessExtra: true }] };
    expect(normalizeConnectionStore(unknown)).toBeNull();
    const recursivelyUnsafe = { ...store, metadata: { nested: { bearer_token: "leak" } } };
    expect(normalizeConnectionStore(recursivelyUnsafe)).toBeNull();

    for (const credentialKey of ["secret", "pass_word", "authorization", "accessToken", "client-id", "app_key", "apiKey", "bearerToken"]) {
      const credentialBearing = {
        ...store,
        connections: [{ ...store.connections[0], [credentialKey]: "leak" }],
      };
      expect(normalizeConnectionStore(credentialBearing), credentialKey).toBeNull();
    }
  });

  it("handles storage read and write failures without exposing seeded connections", () => {
    const badRead = { getItem: () => { throw new Error("blocked"); } };
    expectUnavailable(readConnectionStore(badRead));

    const badInitialWrite = {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
    };
    expectUnavailable(readConnectionStore(badInitialWrite));
    expect(writeConnectionStore(createSeedConnectionStore(), badInitialWrite)).toBe(false);
  });

  it("rejects unsafe writes and roundtrips valid stores as detached safe clones", () => {
    const store = createSeedConnectionStore();
    const storage = memoryStorage();
    expect(writeConnectionStore(store, storage)).toBe(true);
    const roundtrip = readConnectionStore(storage);
    expect(roundtrip).toEqual(store);
    expect(roundtrip).not.toBe(store);
    expect(roundtrip.connections).not.toBe(store.connections);
    expect(roundtrip.connections[0]).not.toBe(store.connections[0]);
    expect(roundtrip.connections[0].locationIds).not.toBe(store.connections[0].locationIds);
    roundtrip.connections[0].locationIds.push("detached-location");
    expect(readConnectionStore(storage)).toEqual(store);

    const unsafe = { ...store, connections: [{ ...store.connections[0], accessToken: "leak" }] };
    expect(writeConnectionStore(unsafe, storage)).toBe(false);
    expect(readConnectionStore(storage)).toEqual(store);
  });

  it("resets a writable store to the unchanged demo seed data", () => {
    const storage = memoryStorage({ [DEMO_CONNECTION_STORAGE_KEY]: "{bad json" });
    const reset = resetConnectionStore(storage);
    expect(reset).toEqual(createSeedConnectionStore());
    expect(readConnectionStore(storage)).toEqual(reset);
  });
});
