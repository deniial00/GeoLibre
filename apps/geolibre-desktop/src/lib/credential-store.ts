/**
 * Where saved credentials live (issue #1667). The desktop (Tauri) build keeps
 * them in the OS credential store through the `secure_store_*` commands in
 * `src-tauri/src/secure_store.rs`, one entry per credential. The web build, the
 * Jupyter embed and the mobile apps keep them in localStorage.
 *
 * Failures never fall back to plaintext: they are reported through
 * {@link useCredentialStorageStatus}, which drives the shell banner and the
 * Settings notice, and the affected values live only in memory this session.
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { isDesktopRuntime } from "./is-mobile";

export type CredentialStorageLocation = "keychain" | "browser";

export function credentialStorageLocation(): CredentialStorageLocation {
  return isDesktopRuntime() ? "keychain" : "browser";
}

/** Reads the given accounts; accounts with no entry are omitted from the result. */
export function readSecureCredentials(
  accounts: readonly string[],
): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("secure_store_get_many", { accounts: [...accounts] });
}

/** Stores `value` under `account`; an empty value deletes the entry. */
export async function writeSecureCredential(account: string, value: string): Promise<void> {
  if (value === "") {
    await invoke("secure_store_delete", { account });
  } else {
    await invoke("secure_store_set", { account, secret: value });
  }
}

interface CredentialStorageStatus {
  /** The latest secure-storage failure this session, or null. Never cleared. */
  error: string | null;
  /** Incremented on every failure so a dismissed warning re-appears. */
  revision: number;
  /**
   * Accounts whose latest queued write failed and is still waiting for a
   * retry. Unlike {@link error}, an entry is removed once a retry succeeds,
   * so it tells whether one credential is persisted right now.
   */
  failedAccounts: Readonly<Record<string, true>>;
}

export const useCredentialStorageStatus = create<CredentialStorageStatus>(() => ({
  error: null,
  revision: 0,
  failedAccounts: {},
}));

export function reportCredentialStorageError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  useCredentialStorageStatus.setState((state) => ({
    error: message,
    revision: state.revision + 1,
  }));
  console.error("[GeoLibre] Secure credential storage failed", error);
}

/** Account → latest value not yet written; "" means delete. */
const pending = new Map<string, string>();
let drain: Promise<void> = Promise.resolve();

async function drainPending(): Promise<void> {
  for (const [account, value] of [...pending]) {
    try {
      await writeSecureCredential(account, value);
    } catch (error) {
      useCredentialStorageStatus.setState((state) => ({
        failedAccounts: { ...state.failedAccounts, [account]: true },
      }));
      reportCredentialStorageError(error);
      return;
    }
    // A newer value queued while this write was in flight stays pending, and so
    // does the account's failure mark: the stored value is not the latest yet.
    if (pending.get(account) !== value) continue;
    pending.delete(account);
    if (useCredentialStorageStatus.getState().failedAccounts[account]) {
      useCredentialStorageStatus.setState((state) => {
        const failedAccounts = { ...state.failedAccounts };
        delete failedAccounts[account];
        return { failedAccounts };
      });
    }
  }
}

/** Whether a queued write for `account` has not completed yet (in flight or failed). */
export function hasPendingCredential(account: string): boolean {
  return pending.has(account);
}

/**
 * Queues a write for every account whose value differs between `previous` and
 * `next` (missing or empty means delete), then writes all pending accounts in
 * order. Accounts that failed earlier are retried on every call, even one that
 * contributes no change. The returned promise never rejects.
 */
export function queueCredentialChanges(
  previous: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
): Promise<void> {
  for (const account of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const value = next[account] ?? "";
    if ((previous[account] ?? "") !== value) pending.set(account, value);
  }
  drain = drain.then(drainPending);
  return drain;
}
