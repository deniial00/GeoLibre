import { isDesktopRuntime } from "./is-mobile";

export const DESKTOP_SHARE_CALLBACK = "org.geolibre.desktop:/oauth/callback";

type Callback =
  | { state: string; issuer: string; code: string; error?: never }
  | { state: string; issuer: string; error: string; code?: never };

type CallbackFailure =
  | "malformed"
  | "state-mismatch"
  | "issuer-mismatch"
  | "access-denied"
  | "timeout"
  | "restart-required";

export class NativeShareCallbackError extends Error {
  constructor(readonly code: CallbackFailure) {
    super(code);
  }
}

/** Reject ambiguous callbacks before any authorization code can reach the token endpoint. */
export function parseNativeShareCallback(raw: string): Callback | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "org.geolibre.desktop:" ||
      url.host ||
      url.username ||
      url.password ||
      url.pathname !== "/oauth/callback" ||
      url.hash
    )
      return null;
    const allowed: Record<string, true> = {
      code: true,
      error: true,
      error_description: true,
      state: true,
      iss: true,
    };
    for (const key of url.searchParams.keys()) {
      if (!Object.hasOwn(allowed, key) || url.searchParams.getAll(key).length !== 1) return null;
    }
    const state = url.searchParams.get("state");
    const issuer = url.searchParams.get("iss");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (!state || !issuer || !!code === !!error || code === "" || error === "") return null;
    if (code && url.searchParams.has("error_description")) return null;
    return code ? { state, issuer, code } : { state, issuer, error: error! };
  } catch {
    return null;
  }
}

type Pending = {
  state: string;
  issuer: string;
  expiresAt: number;
  resolve: (code: string) => void;
  reject: (error: NativeShareCallbackError) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** One live verifier transaction; no callback data survives process restart. */
export class NativeShareAuthReceiver {
  private pending: Pending | null = null;
  private lastState: string | null = null;

  constructor(private readonly coldCallback: () => void) {}

  waitForCode(
    state: string,
    issuer: string,
    timeoutMs: number,
  ): {
    code: Promise<string>;
    cancel: () => void;
  } {
    if (this.pending) throw new NativeShareCallbackError("malformed");
    let cancel = () => undefined;
    const code = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.state === state) {
          this.pending = null;
          reject(new NativeShareCallbackError("timeout"));
        }
      }, timeoutMs);
      this.pending = {
        state,
        issuer,
        expiresAt: Date.now() + timeoutMs,
        resolve,
        reject,
        timer,
      };
      cancel = () => {
        if (this.pending?.state !== state) return;
        clearTimeout(timer);
        this.pending = null;
        reject(new NativeShareCallbackError("malformed"));
      };
    });
    return { code, cancel };
  }

  accept(raw: string): boolean {
    // Other deep links belong to the coordinate/file listeners. Never pass an
    // OAuth URL through those queues and never log its raw value.
    if (!raw.toLowerCase().startsWith("org.geolibre.desktop:")) return false;
    const callback = parseNativeShareCallback(raw);
    const pending = this.pending;
    if (!pending) {
      if (callback?.state !== this.lastState) this.coldCallback();
      return true;
    }
    // Once this state is consumed, even a synchronous duplicate event has no
    // verifier to exchange again. The last state is only retained in memory.
    this.pending = null;
    this.lastState = pending.state;
    clearTimeout(pending.timer);
    if (!callback) pending.reject(new NativeShareCallbackError("malformed"));
    else if (Date.now() >= pending.expiresAt)
      pending.reject(new NativeShareCallbackError("timeout"));
    else if (callback.state !== pending.state)
      pending.reject(new NativeShareCallbackError("state-mismatch"));
    else if (callback.issuer !== pending.issuer)
      pending.reject(new NativeShareCallbackError("issuer-mismatch"));
    else if (callback.code) pending.resolve(callback.code);
    else pending.reject(new NativeShareCallbackError("access-denied"));
    return true;
  }
}

let receiver: NativeShareAuthReceiver | null = null;

/** Register before getCurrent so warm and cold OS deliveries cannot be lost. */
export async function initializeNativeShareAuth(onColdCallback: () => void): Promise<void> {
  if (!isDesktopRuntime()) return;
  const current = new NativeShareAuthReceiver(onColdCallback);
  // Platform-specific bindings stay out of web/embed execution.
  const { onOpenUrl, getCurrent } = await import("@tauri-apps/plugin-deep-link");
  await onOpenUrl((urls) => {
    for (const url of urls) current.accept(url);
  });
  receiver = current;
  const urls = await getCurrent();
  if (urls) for (const url of urls) current.accept(url);
}

/** Set the callback waiter before opening the system browser. */
export function waitForNativeShareCode(state: string, issuer: string, timeoutMs: number) {
  if (!receiver) throw new NativeShareCallbackError("restart-required");
  return receiver.waitForCode(state, issuer, timeoutMs);
}
