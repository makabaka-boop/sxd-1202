const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cloth_no TEXT NOT NULL UNIQUE,
      vat_no TEXT NOT NULL,
      material TEXT NOT NULL,
      shade_target TEXT NOT NULL,
      responsible_team TEXT NOT NULL,
      recheck_cycle INTEGER NOT NULL DEFAULT 24,
      status TEXT NOT NULL DEFAULT '待预洗',
      dip_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_recheck_at TEXT,
      next_recheck_at TEXT,
      remark TEXT
    );

    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      op_type TEXT NOT NULL,
      op_time TEXT NOT NULL,
      operator TEXT,
      color_diff_desc TEXT,
      edge_halo_level INTEGER,
      redye_suggestion TEXT,
      temperature REAL,
      duration_minutes INTEGER,
      remark TEXT,
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vat_no TEXT NOT NULL UNIQUE,
      vat_name TEXT,
      capacity REAL,
      status TEXT NOT NULL DEFAULT '空闲',
      current_batch_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (current_batch_id) REFERENCES batches(id)
    );

    CREATE TABLE IF NOT EXISTS vat_occupancy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vat_no TEXT NOT NULL,
      batch_id INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      remark TEXT,
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_name TEXT NOT NULL UNIQUE,
      material_desc TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exception_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      exception_type TEXT NOT NULL,
      exception_desc TEXT NOT NULL,
      handler TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      process_remark TEXT,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rework_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_id INTEGER,
      source_operation_id INTEGER,
      rework_reason TEXT NOT NULL,
      disposal_plan TEXT NOT NULL,
      responsible_team TEXT NOT NULL,
      planned_completion_at TEXT NOT NULL,
      actual_completion_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      process_remark TEXT,
      handler TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES exception_orders(id) ON DELETE SET NULL,
      FOREIGN KEY (source_operation_id) REFERENCES operations(id) ON DELETE SET NULL
    );
  `);
}

function migrateSchema() {
  const opsPragma = db.prepare("PRAGMA table_info(operations)").all();
  const hasReworkId = opsPragma.some(c => c.name === 'rework_order_id');
  if (!hasReworkId) {
    db.exec(`ALTER TABLE operations ADD COLUMN rework_order_id INTEGER REFERENCES rework_orders(id) ON DELETE SET NULL`);
  }

  const rwPragma = db.prepare("PRAGMA table_info(rework_orders)").all();
  const hasSourceOpId = rwPragma.some(c => c.name === 'source_operation_id');
  if (!hasSourceOpId) {
    db.exec(`ALTER TABLE rework_orders ADD COLUMN source_operation_id INTEGER REFERENCES operations(id) ON DELETE SET NULL`);
  }
}

function createIndexes() {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_batches_vat ON batches(vat_no);
    CREATE INDEX IF NOT EXISTS idx_batches_material ON batches(material);
    CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);
    CREATE INDEX IF NOT EXISTS idx_batches_team ON batches(responsible_team);
    CREATE INDEX IF NOT EXISTS idx_batches_shade ON batches(shade_target);
    CREATE INDEX IF NOT EXISTS idx_batches_created ON batches(created_at);
    CREATE INDEX IF NOT EXISTS idx_operations_batch ON operations(batch_id);
    CREATE INDEX IF NOT EXISTS idx_operations_type ON operations(op_type);
    CREATE INDEX IF NOT EXISTS idx_operations_time ON operations(op_time);
    CREATE INDEX IF NOT EXISTS idx_operations_rework ON operations(rework_order_id);
    CREATE INDEX IF NOT EXISTS idx_vat_occ_vat ON vat_occupancy(vat_no);
    CREATE INDEX IF NOT EXISTS idx_vat_occ_time ON vat_occupancy(start_time, end_time);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_exception_unique_open
      ON exception_orders(batch_id, exception_type)
      WHERE status IN ('pending', 'processing');
    CREATE INDEX IF NOT EXISTS idx_exception_batch ON exception_orders(batch_id);
    CREATE INDEX IF NOT EXISTS idx_exception_type ON exception_orders(exception_type);
    CREATE INDEX IF NOT EXISTS idx_exception_status ON exception_orders(status);
    CREATE INDEX IF NOT EXISTS idx_exception_created ON exception_orders(created_at);

    CREATE INDEX IF NOT EXISTS idx_rework_batch ON rework_orders(batch_id);
    CREATE INDEX IF NOT EXISTS idx_rework_status ON rework_orders(status);
    CREATE INDEX IF NOT EXISTS idx_rework_team ON rework_orders(responsible_team);
    CREATE INDEX IF NOT EXISTS idx_rework_source ON rework_orders(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_rework_planned ON rework_orders(planned_completion_at);
    CREATE INDEX IF NOT EXISTS idx_rework_created ON rework_orders(created_at);
  `);
}

function seedData() {
  const now = new Date().toISOString();
  const defaultMaterials = ['纯棉', '亚麻', '丝绸', '羊毛', '混纺'];
  const insertMaterial = db.prepare('INSERT OR IGNORE INTO materials (material_name, created_at) VALUES (?, ?)');
  for (const m of defaultMaterials) {
    insertMaterial.run(m, now);
  }

  const defaultVats = ['V-001', 'V-002', 'V-003', 'V-004', 'V-005'];
  const insertVat = db.prepare('INSERT OR IGNORE INTO vats (vat_no, status, created_at, updated_at) VALUES (?, ?, ?, ?)');
  for (const v of defaultVats) {
    insertVat.run(v, '空闲', now, now);
  }
}

function initDatabase() {
  createTables();
  migrateSchema();
  createIndexes();
  seedData();
}

initDatabase();

module.exports = db;
