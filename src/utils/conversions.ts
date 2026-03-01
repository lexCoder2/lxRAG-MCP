export function toEpochMillis(asOf?: string): number | null {
  if (!asOf || typeof asOf !== "string") {
    return null;
  }

  if (/^\d+$/.test(asOf)) {
    const numeric = Number(asOf);
    return Number.isFinite(numeric) ? numeric : null;
  }

  const parsed = Date.parse(asOf);
  return Number.isNaN(parsed) ? null : parsed;
}

export function toSafeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (value && typeof value === "object" && "low" in (value as Record<string, unknown>)) {
    const low = Number((value as Record<string, unknown>).low);
    const highRaw = (value as Record<string, unknown>).high;
    const high = typeof highRaw === "number" ? highRaw : Number(highRaw || 0);

    if (Number.isFinite(low) && Number.isFinite(high)) {
      return high * 4294967296 + low;
    }
  }

  return null;
}
