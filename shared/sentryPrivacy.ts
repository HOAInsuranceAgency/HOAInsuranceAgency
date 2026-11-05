/**
 * Sentry receives diagnostic metadata, never customer records or token URLs.
 * Keep this dependency-free so browser bundles and Lambda entrypoints agree.
 */
type Fields = Record<string, unknown>;
const object = (value: unknown): Fields =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const safeName = (value: unknown, fallback = "Error"): string =>
  typeof value === "string" && /^[\w.$<> /:-]{1,160}$/.test(value) ? value : fallback;

/** Only origins are useful for requests; paths can contain customer IDs/tokens. */
function origin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : undefined;
  } catch { return undefined; }
}

/** Stack locations retain source-map identity, without queries or credentials. */
function sourceLocation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.split(/[?#]/, 1)[0];
  // Node's --enable-source-maps resolves esbuild's original TS filenames. Keep
  // repository-relative locations, without exposing a builder's home path.
  const source = path.match(/(?:^|\/)(amplify|shared|src)\/([\w@./()[\]-]+\.(?:[cm]?js|tsx?|jsx))$/);
  if (source) return `app:///${source[1]}/${source[2]}`;
  if (/^node:[\w/._-]+$/.test(path)) return path;
  if (/^app:\/\/\/[\w@./()[\]-]+\.(?:[cm]?js|tsx?|jsx)$/.test(path)) return path;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return undefined;
    // Browser scripts are built assets. A page URL can carry a private token.
    return /\.(?:[cm]?js|tsx?|jsx)$/.test(url.pathname)
      ? `${url.origin}${url.pathname}` : url.origin;
  } catch {
    // Lambda and bundled module locations, excluding arbitrary local home paths.
    return /^(?:app:\/\/\/|\/var\/task\/|\/var\/runtime\/|node:|\.\.?\/|[\w@-]+\/)/.test(path)
      && !/\s|@.*@/.test(path) ? path.slice(0, 500) : undefined;
  }
}

function stacktrace(value: unknown): Fields | undefined {
  const frames = object(value).frames;
  if (!Array.isArray(frames)) return undefined;
  return { frames: frames.map((value) => {
    const frame = object(value);
    return {
      filename: sourceLocation(frame.filename),
      abs_path: sourceLocation(frame.abs_path),
      function: safeName(frame.function, "<anonymous>"),
      module: safeName(frame.module, ""),
      lineno: typeof frame.lineno === "number" ? frame.lineno : undefined,
      colno: typeof frame.colno === "number" ? frame.colno : undefined,
      in_app: typeof frame.in_app === "boolean" ? frame.in_app : undefined,
    };
  }) };
}

/** Discard console, DOM and arbitrary breadcrumb text/data. */
export function sanitizeSentryBreadcrumb<T>(value: T): T | null {
  const breadcrumb = object(value);
  if (!["fetch", "xhr", "http"].includes(String(breadcrumb.category))) return null;
  const data = object(breadcrumb.data);
  return {
    category: breadcrumb.category,
    type: "http",
    timestamp: breadcrumb.timestamp,
    data: {
      url: origin(data.url),
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(String(data.method)) ? data.method : undefined,
      status_code: typeof data.status_code === "number" ? data.status_code : undefined,
    },
  } as T;
}

/**
 * Allowlist instead of recursively redacting an unbounded SDK event. Free-form
 * error messages can embed GraphQL variables, emails and payment data, so omit
 * them. Error type and symbolicated stack still identify the failing code.
 */
export function sanitizeSentryEvent<T>(value: T): T {
  const event = object(value);
  const exceptions = object(event.exception).values;
  const tags = object(event.tags);
  const request = object(event.request);
  const debugImages = object(event.debug_meta).images;
  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    message: typeof event.message === "string" ? "Application error details withheld" : undefined,
    release: event.release,
    environment: event.environment,
    type: event.type,
    // Preserve the SDK's static package/version metadata.
    sdk: event.sdk,
    fingerprint: Array.isArray(event.fingerprint)
      && event.fingerprint.length === 3 && event.fingerprint[0] === "hoa-lambda-result"
      && event.fingerprint.every((part) => typeof part === "string" && /^[\w.:-]{1,120}$/.test(part))
      ? event.fingerprint : undefined,
    tags: Object.fromEntries(["app", "function", "service", "failure_kind"].flatMap((key) =>
      typeof tags[key] === "string" && /^[\w.:-]{1,120}$/.test(tags[key] as string) ? [[key, tags[key]]] : [])),
    request: request.url ? { url: origin(request.url) } : undefined,
    exception: Array.isArray(exceptions) ? { values: exceptions.map((value) => {
      const exception = object(value);
      const mechanism = object(exception.mechanism);
      return {
        type: safeName(exception.type),
        value: "Error details withheld; see application logs",
        stacktrace: stacktrace(exception.stacktrace),
        mechanism: {
          type: safeName(mechanism.type, "generic"),
          handled: typeof mechanism.handled === "boolean" ? mechanism.handled : undefined,
          // Drop mechanism data, which can contain the original event.
        },
      };
    }) } : undefined,
    stacktrace: stacktrace(event.stacktrace),
    breadcrumbs: Array.isArray(event.breadcrumbs)
      ? event.breadcrumbs.map(sanitizeSentryBreadcrumb).filter((item) => item !== null) : undefined,
    debug_meta: Array.isArray(debugImages) ? { images: debugImages.map((value) => {
      const image = object(value);
      return { type: image.type, debug_id: image.debug_id, code_file: sourceLocation(image.code_file) };
    }) } : undefined,
  } as T;
}
