import { NextRequest, NextResponse } from "next/server";

type RateLimitOptions = {
  key: string;
  max: number;
  windowMs: number;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const globalForRateLimits = globalThis as typeof globalThis & {
  __solvysMidiRateLimits?: Map<string, RateLimitBucket>;
};

const rateLimitBuckets = globalForRateLimits.__solvysMidiRateLimits ?? new Map<string, RateLimitBucket>();
globalForRateLimits.__solvysMidiRateLimits = rateLimitBuckets;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function cleanText(value: unknown, maxLength = 240) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

export function jsonError(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

export function clientIp(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    forwardedFor ||
    request.headers.get("x-real-ip") ||
    request.headers.get("cf-connecting-ip") ||
    "anonymous"
  );
}

export function requireSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return null;
  }

  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) {
    return jsonError("Cross-origin writes are not allowed.", 403);
  }

  return null;
}

export function rateLimit(request: NextRequest, options: RateLimitOptions) {
  const ip = clientIp(request);
  const key = `${options.key}:${ip}`;
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return null;
  }

  bucket.count += 1;
  if (bucket.count <= options.max) {
    return null;
  }

  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return NextResponse.json(
    { error: "Too many requests. Please wait before trying again." },
    {
      status: 429,
      headers: {
        "Retry-After": retryAfter.toString(),
        "X-RateLimit-Limit": options.max.toString(),
        "X-RateLimit-Reset": Math.ceil(bucket.resetAt / 1000).toString(),
      },
    },
  );
}

export function rejectLargeContentLength(request: NextRequest, maxBytes: number) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return jsonError("Request payload is too large.", 413, { maxBytes });
  }

  return null;
}

export async function readJsonBody<T>(request: NextRequest, maxBytes: number) {
  const contentLengthRejection = rejectLargeContentLength(request, maxBytes);
  if (contentLengthRejection) {
    return { error: contentLengthRejection };
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return { error: jsonError("Request payload is too large.", 413, { maxBytes }) };
  }

  try {
    return { body: JSON.parse(raw) as T };
  } catch {
    return { error: jsonError("Request body must be valid JSON.", 400) };
  }
}

export function decodeBase64Payload(
  value: unknown,
  maxBytes: number,
  label: string,
): { bytes: Buffer } | { error: string; maxBytes?: number } {
  const base64 = cleanText(value, Number.MAX_SAFE_INTEGER);
  if (!base64) {
    return { error: `${label} is required.` };
  }

  if (!BASE64_RE.test(base64) || base64.length % 4 !== 0) {
    return { error: `${label} must be valid base64.` };
  }

  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > maxBytes) {
    return { error: `${label} is too large.`, maxBytes };
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > maxBytes) {
    return { error: `${label} is too large.`, maxBytes };
  }

  return { bytes };
}

export function isMidiBytes(bytes: Buffer) {
  return bytes.byteLength >= 14 && bytes.subarray(0, 4).toString("ascii") === "MThd";
}

export function numericEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
