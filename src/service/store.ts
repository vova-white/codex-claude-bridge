import { DatabaseSync } from "node:sqlite";

/** Schema changes, applied in order and recorded in PRAGMA user_version. */
const migrations: string[] = [
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    caller TEXT NOT NULL,
    request_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    mode TEXT NOT NULL,
    assignment TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (project, caller, request_key)
  );
  CREATE TABLE executions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks (id),
    ordinal INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    detail TEXT,
    error TEXT,
    session_id TEXT,
    result TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    UNIQUE (task_id, ordinal)
  )`,
  "ALTER TABLE tasks RENAME COLUMN assignment TO request",
  `CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL REFERENCES executions (id),
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX events_by_execution ON events (execution_id, seq);
  ALTER TABLE executions ADD COLUMN events_pruned INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE executions ADD COLUMN kind TEXT NOT NULL DEFAULT 'start';
  ALTER TABLE executions ADD COLUMN input TEXT;
  ALTER TABLE executions ADD COLUMN request_key TEXT;
  ALTER TABLE executions ADD COLUMN request_hash TEXT;
  CREATE UNIQUE INDEX executions_by_request_key ON executions (task_id, request_key)
    WHERE request_key IS NOT NULL`,
  `CREATE TABLE nested_tasks (
    execution_id TEXT NOT NULL REFERENCES executions (id),
    task_id TEXT NOT NULL,
    tool_use_id TEXT,
    parent_tool_use_id TEXT,
    description TEXT NOT NULL,
    agent_type TEXT,
    background INTEGER NOT NULL,
    depth INTEGER,
    status TEXT NOT NULL,
    summary TEXT,
    termination TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    PRIMARY KEY (execution_id, task_id)
  )`,
  `CREATE TABLE workspaces (
    task_id TEXT PRIMARY KEY REFERENCES tasks (id),
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    baseline TEXT NOT NULL,
    parent_dirty INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks (id),
    execution_id TEXT NOT NULL REFERENCES executions (id),
    session_id TEXT,
    tool_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    response_shape TEXT NOT NULL,
    state TEXT NOT NULL,
    response TEXT,
    response_hash TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX requests_by_task ON requests (task_id, created_at);
  CREATE INDEX requests_by_execution ON requests (execution_id, state)`,
  `CREATE TABLE publications (
    task_id TEXT PRIMARY KEY REFERENCES tasks (id),
    remote TEXT NOT NULL,
    repository TEXT,
    revision TEXT,
    uncommitted INTEGER NOT NULL,
    pushed_revision TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    pr_state TEXT,
    pr_head TEXT,
    problems TEXT NOT NULL,
    checked_at TEXT NOT NULL
  )`,
];

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
