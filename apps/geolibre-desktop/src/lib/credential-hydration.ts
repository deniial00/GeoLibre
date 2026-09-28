/**
 * Desktop startup: loads credentials from the OS credential store into memory
 * and migrates legacy plaintext localStorage values into it (issue #1667).
 * `main.tsx` awaits this before rendering, so every consumer can keep reading
 * the settings store, the PostGIS list and the share sign-in synchronously.
 *
 * A legacy localStorage value is removed only after its credential-store write
 * succeeded; when both hold a value, the legacy one wins because it is what
 * the user last saw. Any failure keeps the session running on in-memory values
 * and raises the credential-storage warning.
 */
import {
  credentialStorageLocation,
  readSecureCredentials,
  reportCredentialStorageError,
  writeSecureCredential,
} from "./credential-store";
import {
  desktopSettingsSecretAccounts,
  mergeDesktopSettingsSecrets,
  splitDesktopSettingsSecrets,
} from "./desktop-settings-secrets";
import {
  POSTGRES_CONNECTION_IDS_STORAGE_KEY,
  POSTGRES_CONNECTIONS_STORAGE_KEY,
  postgresConnectionAccount,
  readBrowserPostgresConnections,
  readKeychainPostgresIds,
  setKeychainPostgresConnections,
  setPostgresKeychainWritable,
  type KeychainPostgresConnection,
} from "./saved-postgres-connections";
import {
  setPreservedLegacyCredentialSecrets,
  setSettingsKeychainWritable,
  shouldPersistDesktopSettings,
  useDesktopSettingsStore,
} from "../hooks/useDesktopSettings";
import { hydrateDesktopShareSession } from "./share-oauth";

export async function hydrateDesktopCredentials(): Promise<void> {
  if (credentialStorageLocation() !== "keychain") return;
  try {
    await hydratePostgresConnections();
    await hydrateSettingsSecrets();
  } catch (error) {
    // Unforeseen failure: fall back to a session-only state that never writes
    // plaintext and never drops the legacy values.
    reportCredentialStorageError(error);
    setPostgresKeychainWritable(false);
    setSettingsKeychainWritable(false);
    setKeychainPostgresConnections(withNewIds(readBrowserPostgresConnections()));
    const { secrets } = splitDesktopSettingsSecrets(
      useDesktopSettingsStore.getState().desktopSettings,
    );
    if (Object.keys(secrets).length > 0) setPreservedLegacyCredentialSecrets(secrets);
  }
  // Never rejects; a failure starts signed out with the credential warning.
  await hydrateDesktopShareSession();
}

function withNewIds(connections: string[]): KeychainPostgresConnection[] {
  return connections.map((connection) => ({ id: crypto.randomUUID(), connection }));
}

async function hydratePostgresConnections(): Promise<void> {
  const legacy = readBrowserPostgresConnections();
  let ids: string[];
  let stored: Record<string, string>;
  try {
    ids = readKeychainPostgresIds();
    stored = await readSecureCredentials(ids.map(postgresConnectionAccount));
  } catch (error) {
    reportCredentialStorageError(error);
    setPostgresKeychainWritable(false);
    setKeychainPostgresConnections(withNewIds(legacy));
    return;
  }

  if (legacy.length === 0) {
    const entries = ids.flatMap((id) => {
      const connection = stored[postgresConnectionAccount(id)];
      return connection ? [{ id, connection }] : [];
    });
    setKeychainPostgresConnections(entries);
    if (entries.length < ids.length) {
      // An indexed id has no credential: its keychain write failed or was
      // interrupted after the index was written. The read reports an account
      // as missing only when it has no entry (any other error throws above),
      // so dropping the id erases nothing. Rewrite the index and stay
      // writable; otherwise one failed save would lock the list for good.
      reportCredentialStorageError(
        new Error("A saved PostGIS connection could not be restored from your system keychain."),
      );
      try {
        window.localStorage.setItem(
          POSTGRES_CONNECTION_IDS_STORAGE_KEY,
          JSON.stringify(entries.map(({ id }) => id)),
        );
      } catch (error) {
        reportCredentialStorageError(error);
        setPostgresKeychainWritable(false);
        return;
      }
    }
    setPostgresKeychainWritable(true);
    return;
  }

  // Migrate. Reuse ids already holding the same DSN, then ids whose credential
  // is missing (an interrupted earlier migration), so retries leak no entries.
  const unused = new Set(ids);
  const takeId = (predicate: (id: string) => boolean) => {
    const id = [...unused].find(predicate);
    if (id !== undefined) unused.delete(id);
    return id;
  };
  const matched = legacy.map((connection) =>
    takeId((id) => stored[postgresConnectionAccount(id)] === connection),
  );
  const entries: KeychainPostgresConnection[] = legacy.map((connection, index) => ({
    connection,
    id:
      matched[index] ??
      takeId((id) => stored[postgresConnectionAccount(id)] === undefined) ??
      crypto.randomUUID(),
  }));
  setKeychainPostgresConnections(entries);

  try {
    window.localStorage.setItem(
      POSTGRES_CONNECTION_IDS_STORAGE_KEY,
      JSON.stringify(entries.map(({ id }) => id)),
    );
    for (const { id, connection } of entries) {
      if (stored[postgresConnectionAccount(id)] !== connection) {
        await writeSecureCredential(postgresConnectionAccount(id), connection);
      }
    }
    // The legacy list wins: credentials it no longer references are removed.
    for (const id of unused) {
      if (stored[postgresConnectionAccount(id)] !== undefined) {
        await writeSecureCredential(postgresConnectionAccount(id), "");
      }
    }
    window.localStorage.removeItem(POSTGRES_CONNECTIONS_STORAGE_KEY);
  } catch (error) {
    reportCredentialStorageError(error);
    setPostgresKeychainWritable(false);
    return;
  }
  setPostgresKeychainWritable(true);
}

async function hydrateSettingsSecrets(): Promise<void> {
  // A shared-settings URL session never persists, so it never touches credentials.
  if (!shouldPersistDesktopSettings()) return;

  const { publicSettings, secrets: legacy } = splitDesktopSettingsSecrets(
    useDesktopSettingsStore.getState().desktopSettings,
  );
  const hasLegacy = Object.keys(legacy).length > 0;

  let stored: Record<string, string>;
  try {
    stored = await readSecureCredentials(desktopSettingsSecretAccounts(publicSettings));
  } catch (error) {
    // The store still holds the loaded legacy values, so this session works.
    reportCredentialStorageError(error);
    setSettingsKeychainWritable(false);
    if (hasLegacy) setPreservedLegacyCredentialSecrets(legacy);
    return;
  }

  const merged = mergeDesktopSettingsSecrets(publicSettings, { ...stored, ...legacy });
  try {
    for (const [account, value] of Object.entries(legacy)) {
      await writeSecureCredential(account, value);
    }
  } catch (error) {
    reportCredentialStorageError(error);
    setSettingsKeychainWritable(false);
    setPreservedLegacyCredentialSecrets(legacy);
    useDesktopSettingsStore.getState().setDesktopSettings(merged);
    return;
  }

  setSettingsKeychainWritable(true);
  setPreservedLegacyCredentialSecrets(null);
  // The persistence hook's mount-time save writes the stripped blob.
  useDesktopSettingsStore.getState().setDesktopSettings(merged);
}
