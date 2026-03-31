function resolveNow(): Date {
  const fixedNow = process.env.HIVE_FIXED_NOW;

  if (!fixedNow) {
    return new Date();
  }

  const date = new Date(fixedNow);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid HIVE_FIXED_NOW value: ${fixedNow}`);
  }

  return date;
}

export function now(): Date {
  return resolveNow();
}

export function toIsoTimestamp(date: Date = now()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function toCompactTimestamp(date: Date = now()): string {
  return toIsoTimestamp(date).replace(/[-:]/g, "").replace("T", "-");
}

export function toDateParts(date: Date = now()): {
  year: string;
  month: string;
  day: string;
} {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return { year, month, day };
}

export function toDateLabel(date: Date = now()): string {
  const { year, month, day } = toDateParts(date);

  return `${year}-${month}-${day}`;
}

export function toLogHeading(actor = "human", date: Date = now()): string {
  return `## ${toIsoTimestamp(date)} — ${actor}`;
}

export function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((now().getTime() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
