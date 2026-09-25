import { DatabaseSync } from "node:sqlite";

/** Schema changes, applied in order and recorded in PRAGMA user_version. */
const migrations: string[] = [];

export class StoreLockedError extends Error {}

/**
 * Opens the state database and holds an exclusive lock on it for the lifetime of
 * the process. The operating system releases the lock if the service dies, so a
 * second service for the same state directory fails fast instead of sharing it.
 */
export function openStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
  } catch (error) {
    db.close();
    if (/locked|busy/i.test((error as Error).message)) {
      throw new StoreLockedError(`Another bridge service owns ${path}.`);
    }
    throw error;
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  for (const [index, migration] of migrations.entries()) {
    if (index < version) continue;
    db.exec(`BEGIN; ${migration}; PRAGMA user_version = ${index + 1}; COMMIT;`);
  }
  return db;
}
