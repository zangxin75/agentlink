import type { Db } from './sqlite.js'

export function migrate(db: Db): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    capabilities TEXT NOT NULL DEFAULT '[]',
    task_policy TEXT NOT NULL DEFAULT '{"mode":"open","allowlist":[],"scope":"read-only"}',
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    name TEXT NOT NULL DEFAULT 'default',
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    client_msg_id TEXT NOT NULL,
    from_agent TEXT NOT NULL REFERENCES agents(id),
    to_agent TEXT NOT NULL REFERENCES agents(id),
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    thread_id TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    read_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idem ON messages(from_agent, client_msg_id);
  CREATE INDEX IF NOT EXISTS idx_messages_peer ON messages(from_agent, to_agent, id);
  CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(to_agent, id) WHERE delivered_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(to_agent, from_agent) WHERE read_at IS NULL;
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    requester TEXT NOT NULL REFERENCES agents(id),
    executor TEXT NOT NULL REFERENCES agents(id),
    action TEXT NOT NULL,
    context TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    max_duration_s INTEGER NOT NULL,
    status TEXT NOT NULL,
    result TEXT, error TEXT,
    created_at TEXT NOT NULL, accepted_at TEXT, finished_at TEXT,
    deadline TEXT,
    expires_at TEXT NOT NULL,
    last_heartbeat_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_executor ON tasks(executor, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requester, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline) WHERE status = 'RUNNING';
  CREATE INDEX IF NOT EXISTS idx_tasks_expires ON tasks(expires_at) WHERE status = 'REQUESTED';
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `)

  // v1.1 迁移：user_version 门控（SQLite ALTER ADD COLUMN 无 IF NOT EXISTS，靠版本号防重跑）；
  // user_version 写入是事务性的，DDL+版本号同事务原子提交（r1-M2/r2 已核）
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (v < 2) {
    db.transaction(() => {
      db.exec(`
      ALTER TABLE agents ADD COLUMN webhook_url TEXT;
      ALTER TABLE agents ADD COLUMN webhook_secret TEXT;
      ALTER TABLE tasks ADD COLUMN result_schema TEXT;
      ALTER TABLE tasks ADD COLUMN budget_amount INTEGER;
      ALTER TABLE tasks ADD COLUMN budget_currency TEXT NOT NULL DEFAULT 'credit';
      CREATE TABLE IF NOT EXISTS task_reviews (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        rater TEXT NOT NULL, ratee TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        comment TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        type TEXT NOT NULL CHECK(type IN ('agreed','settled','voided')),
        payer TEXT NOT NULL, payee TEXT NOT NULL,
        amount INTEGER NOT NULL, currency TEXT NOT NULL,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id) WHERE thread_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(json_extract(detail,'$.task_id'));
      `)
      db.prepare('PRAGMA user_version = 2').run()
    })()
  }

  // v1.2 迁移：能力档案（spec docs/superpowers/specs/2026-10-01-agent-capability-profile-design.md §3.1）
  if (v < 3) {
    db.transaction(() => {
      db.exec(`
      ALTER TABLE agents ADD COLUMN profile TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE agents ADD COLUMN profile_updated_at TEXT NOT NULL DEFAULT '';
      `)
      db.prepare('PRAGMA user_version = 3').run()
    })()
  }

  // v1.3 迁移：topic 隔离（spec 2026-10-02-topic-isolation-design.md §1/§2）
  if (v < 4) {
    db.transaction(() => {
      db.exec(`
      ALTER TABLE messages ADD COLUMN topic TEXT NOT NULL DEFAULT '_default';
      CREATE TABLE IF NOT EXISTS agent_topics (
        agent_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        refreshed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, topic)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_topics_agent ON agent_topics(agent_id);
      CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(to_agent, topic, id);
      `)
      db.prepare('PRAGMA user_version = 4').run()
    })()
  }

  // v1.4 迁移：credit market 六表（spec 2026-10-03-credit-marketplace-design.md §10）
  if (v < 5) {
    db.transaction(() => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS credit_accounts (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        permanent INTEGER NOT NULL DEFAULT 0,
        expiring INTEGER NOT NULL DEFAULT 0,
        expiring_expires_at TEXT,             -- 单桶 TTL（多桶 v2 再拆表）
        locked INTEGER NOT NULL DEFAULT 0,
        last_faucet_date TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        delta INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ref_type TEXT, ref_id TEXT,
        balance_after INTEGER NOT NULL,
        note TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_agent ON credit_ledger(agent_id, created_at);
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('demand','service')),
        publisher TEXT NOT NULL REFERENCES agents(id),
        title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','dealing','done','canceled','expired')),
        budget INTEGER, price INTEGER, escrowed_points INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, kind, created_at);
      CREATE TABLE IF NOT EXISTS bids (
        id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        points INTEGER NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','countered','accepted','rejected','withdrawn','expired')),
        counter_rounds INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bids_listing ON bids(listing_id, status);
      CREATE TABLE IF NOT EXISTS deals (
        id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id),
        buyer TEXT NOT NULL REFERENCES agents(id),
        seller TEXT NOT NULL REFERENCES agents(id),
        points INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'escrowed' CHECK(status IN ('escrowed','delivered','accepted','canceled')),
        auto_accept_at TEXT, task_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deals_parties ON deals(buyer, seller, status);
      CREATE TABLE IF NOT EXISTS credit_pool (
        id INTEGER PRIMARY KEY CHECK(id=1), balance INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO credit_pool (id, balance, updated_at) VALUES (1, 0, 0);
      `)
      db.prepare('PRAGMA user_version = 5').run()
    })()
  }
  // 系统账户：srv: 派生消息 from_agent='server' 受 messages FK 约束，须落一行 agents 记录；
  // 缺失会让 insertDerived 的 FOREIGNKEY 错被幂等兜底静默吞掉，所有 server 侧 srv 通知静默丢失（T6 发现）
  db.prepare(`INSERT OR IGNORE INTO agents (id, display_name, description, capabilities, task_policy, created_at, last_seen_at) VALUES ('server', 'AgentLink System', '', '[]', '{"mode":"closed","allowlist":[],"scope":"read-only"}', ?, ?)`)
    .run(new Date().toISOString(), new Date().toISOString())
}
