export const HIDDEN_METRICS_STORAGE_KEY = "gmib.hidden.v1";
export const METRIC_ORDERS_STORAGE_KEY = "gmib.orders.v1";

interface ReadableStorage {
  getItem(key: string): string | null;
}

interface WritableStorage extends ReadableStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isStringIdList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 500
    && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 200);
}

export function parseHiddenMetricIds(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return isStringIdList(parsed) ? Array.from(new Set(parsed)) : [];
  } catch {
    return [];
  }
}

export function parseMetricOrders(value: string | null): Record<string, string[]> {
  if (value === null) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed);
    if (entries.length > 100 || entries.some(([key, ids]) => !key || key.length > 200 || !isStringIdList(ids))) return {};
    return Object.fromEntries(entries.map(([key, ids]) => [key, Array.from(new Set(ids as string[]))]));
  } catch {
    return {};
  }
}

export function readHiddenMetricIds(storage: ReadableStorage): string[] {
  try {
    return parseHiddenMetricIds(storage.getItem(HIDDEN_METRICS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function readMetricOrders(storage: ReadableStorage): Record<string, string[]> {
  try {
    return parseMetricOrders(storage.getItem(METRIC_ORDERS_STORAGE_KEY));
  } catch {
    return {};
  }
}

function restoreStorageValue(storage: WritableStorage, key: string, value: string | null): void {
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
}

export function writeDashboardLayoutState(
  storage: WritableStorage,
  hidden: string[],
  orders: Record<string, string[]>,
): boolean {
  if (!isStringIdList(hidden) || Object.values(orders).some((ids) => !isStringIdList(ids))) return false;

  let previousHidden: string | null = null;
  let previousOrders: string | null = null;
  let hasSnapshot = false;
  try {
    previousHidden = storage.getItem(HIDDEN_METRICS_STORAGE_KEY);
    previousOrders = storage.getItem(METRIC_ORDERS_STORAGE_KEY);
    hasSnapshot = true;
    storage.setItem(HIDDEN_METRICS_STORAGE_KEY, JSON.stringify(hidden));
    storage.setItem(METRIC_ORDERS_STORAGE_KEY, JSON.stringify(orders));
    return true;
  } catch {
    if (hasSnapshot) {
      try {
        restoreStorageValue(storage, HIDDEN_METRICS_STORAGE_KEY, previousHidden);
        restoreStorageValue(storage, METRIC_ORDERS_STORAGE_KEY, previousOrders);
      } catch {
        // The caller keeps the prior UI state and reports that browser persistence failed.
      }
    }
    return false;
  }
}

function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === "string" && /^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function createCsv(headers: string[], rows: Array<Array<string | number>>): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
