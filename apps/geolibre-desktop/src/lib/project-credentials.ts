/**
 * Desktop store for the credentials a project refers to by name (issue #1667):
 * geocoding API keys, secret environment variables, and layer request headers.
 * The values live in the OS credential store under the device-wide accounts
 * from `@geolibre/core`'s `project-credential-refs`; this module holds them in
 * memory so the core overlay can read them synchronously.
 *
 * The credential store cannot be enumerated, so the accounts that have an
 * entry are indexed in localStorage (non-secret). As with the PostGIS list,
 * the index is written before the credentials so a crash cannot leave an
 * unindexed credential behind, and a malformed index fails hydration rather
 * than being partially read.
 */
import { setProjectCredentialLookup } from "@geolibre/core";
import { create } from "zustand";
import {
  credentialStorageLocation,
  hasPendingCredential,
  queueCredentialChanges,
  reportCredentialStorageError,
} from "./credential-store";

/** Desktop: non-secret JSON array of accounts that have a stored value. */
export const PROJECT_CREDENTIAL_ACCOUNTS_STORAGE_KEY = "geolibre.projectCredentials.accounts";

const MAX_ACCOUNT_BYTES = 512;

/** Account → stored value, for this session. */
export const useProjectCredentialStore = create<{ values: Readonly<Record<string, string>> }>(
  () => ({ values: {} }),
);

/** False until hydration succeeds: edits then stay in memory. */
let writable = false;

export function setProjectCredentialsWritable(value: boolean): void {
  writable = value;
}

/** Whether project credentials are kept out of the project file right now. */
export function projectCredentialsInKeychain(): boolean {
  return credentialStorageLocation() === "keychain" && writable;
}

/**
 * Reads the desktop account index. Throws on unreadable storage or a malformed
 * index rather than returning a partial list, which would orphan entries.
 */
export function readProjectCredentialIndex(): string[] {
  const value = window.localStorage.getItem(PROJECT_CREDENTIAL_ACCOUNTS_STORAGE_KEY);
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  const encoder = new TextEncoder();
  if (
    !Array.isArray(parsed) ||
    new Set(parsed).size !== parsed.length ||
    !parsed.every(
      (account) =>
        typeof account === "string" &&
        account.startsWith("project.") &&
        encoder.encode(account).length <= MAX_ACCOUNT_BYTES,
    )
  ) {
    throw new Error("The saved project credential index is malformed.");
  }
  return parsed as string[];
}

/**
 * Loads the indexed project credentials from the startup keychain read and
 * installs the core lookup. `index` or `stored` is `null` when reading it
 * failed (the caller reported it): the session then keeps working on whatever
 * the project files carry and edits stay in memory.
 */
export function hydrateProjectCredentials(
  index: readonly string[] | null,
  stored: Readonly<Record<string, string>> | null,
): void {
  if (credentialStorageLocation() !== "keychain") return;
  setProjectCredentialLookup((account) => useProjectCredentialStore.getState().values[account]);
  if (index === null || stored === null) {
    setProjectCredentialsWritable(false);
    return;
  }
  const present = index.filter((account) => stored[account] !== undefined);
  useProjectCredentialStore.setState({
    values: Object.fromEntries(present.map((account) => [account, stored[account]])),
  });
  if (present.length !== index.length) {
    // An indexed write that never landed (crash, failed write). Its value was
    // session-only at the time, so drop it from the index without a warning.
    console.warn(
      "[GeoLibre] Dropping project credentials missing from the credential store",
      index.filter((account) => stored[account] === undefined),
    );
    try {
      window.localStorage.setItem(PROJECT_CREDENTIAL_ACCOUNTS_STORAGE_KEY, JSON.stringify(present));
    } catch (error) {
      reportCredentialStorageError(error);
      setProjectCredentialsWritable(false);
      return;
    }
  }
  setProjectCredentialsWritable(true);
}

/**
 * Applies credential changes (`""` deletes) to the session cache and, when
 * writable, to the credential store. Resolves `true` only when every change
 * is durably stored; the cache is updated either way so the session keeps
 * working.
 */
export async function rememberProjectCredentials(
  changes: Readonly<Record<string, string>>,
): Promise<boolean> {
  const accounts = Object.keys(changes);
  if (accounts.length === 0) return true;

  const current = useProjectCredentialStore.getState().values;
  const previous: Record<string, string> = {};
  const values = { ...current };
  for (const account of accounts) {
    if (current[account]) previous[account] = current[account];
    if (changes[account]) values[account] = changes[account];
    else delete values[account];
  }
  useProjectCredentialStore.setState({ values });

  if (!projectCredentialsInKeychain()) return false;

  try {
    const index = new Set(readProjectCredentialIndex());
    for (const account of accounts) {
      if (changes[account]) index.add(account);
      else index.delete(account);
    }
    window.localStorage.setItem(
      PROJECT_CREDENTIAL_ACCOUNTS_STORAGE_KEY,
      JSON.stringify([...index]),
    );
  } catch (error) {
    reportCredentialStorageError(error);
    return false;
  }
  await queueCredentialChanges(previous, changes);
  return accounts.every((account) => !hasPendingCredential(account));
}
