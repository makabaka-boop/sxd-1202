const db = require('./db');

const ACTIVE_STATUSES = ['待预洗', '浸染中', '晾置中', '待复验', '需补染', '停留观察'];
const RECHECK_WAITING_STATUSES = ['待复验', '停留观察'];

function nullish(value, fallback = null) {
  return value === undefined || value === null || value === '' ? fallback : value;
}

const batchRepo = {
  create(data) {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO batches 
      (cloth_no, vat_no, material, shade_target, responsible_team, recheck_cycle, status, dip_count, created_at, updated_at, remark)
      VALUES (?, ?, ?, ?, ?, ?, '待预洗', 0, ?, ?, ?)
    `);
    const result = stmt.run(
      data.cloth_no, data.vat_no, data.material, data.shade_target,
      data.responsible_team, nullish(data.recheck_cycle, 24), now, now, nullish(data.remark)
    );
    return this.getById(result.lastInsertRowid);
  },

  update(id, data) {
    const now = new Date().toISOString();
    const fields = [];
    const values = [];
    const allowed = ['cloth_no', 'vat_no', 'material', 'shade_target', 'responsible_team', 'recheck_cycle', 'status', 'dip_count', 'last_recheck_at', 'next_recheck_at', 'remark'];
    for (const key of allowed) {
      if (data[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(data[key]);
      }
    }
    fields.push('updated_at = ?');
    values.push(now, id);
    const stmt = db.prepare(`UPDATE batches SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM batches WHERE id = ?').run(id);
  },

  getById(id) {
    return db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
  },

  getByClothNo(cloth_no) {
    return db.prepare('SELECT * FROM batches WHERE cloth_no = ?').get(cloth_no);
  },

  list(filters = {}) {
    const where = [];
    const params = [];

    if (filters.vat_no) { where.push('b.vat_no = ?'); params.push(filters.vat_no); }
    if (filters.material) { where.push('b.material = ?'); params.push(filters.material); }
    if (filters.shade_target) { where.push('b.shade_target = ?'); params.push(filters.shade_target); }
    if (filters.status) { where.push('b.status = ?'); params.push(filters.status); }
    if (filters.responsible_team) { where.push('b.responsible_team = ?'); params.push(filters.responsible_team); }
    if (filters.start_date) { where.push('b.created_at >= ?'); params.push(filters.start_date); }
    if (filters.end_date) { where.push('b.created_at <= ?'); params.push(filters.end_date); }

    if (filters.edge_halo_level !== undefined) {
      const haloWhere = `o.edge_halo_level = ? AND o.id = (SELECT MAX(id) FROM operations WHERE batch_id = b.id AND edge_halo_level IS NOT NULL)`;
      where.push(haloWhere);
      params.push(filters.edge_halo_level);

      let sql = `SELECT DISTINCT b.*, o.edge_halo_level FROM batches b INNER JOIN operations o ON o.batch_id = b.id`;
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY b.updated_at DESC';
      return db.prepare(sql).all(...params);
    }

    let sql = 'SELECT b.* FROM batches b';
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY b.created_at DESC';

    return db.prepare(sql).all(...params);
  },

  getActiveByVat(vat_no, excludeId = null) {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
    let sql = `SELECT * FROM batches WHERE vat_no = ? AND status IN (${placeholders})`;
    const params = [vat_no, ...ACTIVE_STATUSES];
    if (excludeId) {
      sql += ' AND id != ?';
      params.push(excludeId);
    }
    return db.prepare(sql).get(...params);
  },

  getAllActive() {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM batches WHERE status IN (${placeholders}) ORDER BY updated_at DESC`).get(...ACTIVE_STATUSES);
  },

  listByHaloLevel(level) {
    return db.prepare(`
      SELECT b.*, o.edge_halo_level
      FROM batches b
      JOIN operations o ON o.batch_id = b.id
      WHERE o.edge_halo_level = ?
      AND o.id = (SELECT MAX(id) FROM operations WHERE batch_id = b.id AND edge_halo_level IS NOT NULL)
      ORDER BY b.updated_at DESC
    `).all(level);
  }
};

const vatOccupancyRepo = {
  startOccupancy(vat_no, batch_id, startTime = null, remark = null) {
    const t = startTime || new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO vat_occupancy (vat_no, batch_id, start_time, end_time, remark)
      VALUES (?, ?, ?, NULL, ?)
    `);
    return stmt.run(vat_no, batch_id, t, remark);
  },

  endOccupancy(vat_no, batch_id, endTime = null) {
    const t = endTime || new Date().toISOString();
    return db.prepare(`
      UPDATE vat_occupancy SET end_time = ?
      WHERE vat_no = ? AND batch_id = ? AND end_time IS NULL
    `).run(t, vat_no, batch_id);
  },

  endAllForBatch(batch_id, endTime = null) {
    const t = endTime || new Date().toISOString();
    return db.prepare(`
      UPDATE vat_occupancy SET end_time = ?
      WHERE batch_id = ? AND end_time IS NULL
    `).run(t, batch_id);
  },

  checkConflict(vat_no, startTime, endTime = null, excludeBatchId = null) {
    const end = endTime || '9999-12-31T23:59:59.999Z';
    let sql = `
      SELECT vo.*, b.cloth_no, b.status
      FROM vat_occupancy vo
      JOIN batches b ON b.id = vo.batch_id
      WHERE vo.vat_no = ?
      AND vo.start_time < ?
      AND COALESCE(vo.end_time, '9999-12-31T23:59:59.999Z') > ?
    `;
    const params = [vat_no, end, startTime];
    if (excludeBatchId) {
      sql += ' AND vo.batch_id != ?';
      params.push(excludeBatchId);
    }
    return db.prepare(sql).all(...params);
  },

  getActiveOccupancy(vat_no) {
    return db.prepare(`
      SELECT vo.*, b.cloth_no, b.status
      FROM vat_occupancy vo
      JOIN batches b ON b.id = vo.batch_id
      WHERE vo.vat_no = ? AND vo.end_time IS NULL
      ORDER BY vo.start_time DESC LIMIT 1
    `).get(vat_no);
  },

  listByVat(vat_no) {
    return db.prepare(`
      SELECT vo.*, b.cloth_no, b.status
      FROM vat_occupancy vo
      JOIN batches b ON b.id = vo.batch_id
      WHERE vo.vat_no = ?
      ORDER BY vo.start_time DESC
    `).all(vat_no);
  }
};

const operationRepo = {
  create(data) {
    const now = nullish(data.op_time, new Date().toISOString());
    const stmt = db.prepare(`
      INSERT INTO operations
      (batch_id, op_type, op_time, operator, color_diff_desc, edge_halo_level, redye_suggestion, temperature, duration_minutes, remark, rework_order_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.batch_id,
      data.op_type,
      now,
      nullish(data.operator),
      nullish(data.color_diff_desc),
      data.edge_halo_level ?? null,
      nullish(data.redye_suggestion),
      data.temperature ?? null,
      data.duration_minutes ?? null,
      nullish(data.remark),
      data.rework_order_id ?? null
    );
    return this.getById(result.lastInsertRowid);
  },

  getById(id) {
    return db.prepare('SELECT * FROM operations WHERE id = ?').get(id);
  },

  listByBatch(batch_id) {
    return db.prepare(`
      SELECT o.*, ro.status AS rework_status, ro.rework_reason
      FROM operations o
      LEFT JOIN rework_orders ro ON ro.id = o.rework_order_id
      WHERE o.batch_id = ?
      ORDER BY o.op_time ASC, o.id ASC
    `).all(batch_id);
  },

  listByReworkOrder(rework_order_id) {
    return db.prepare(`
      SELECT * FROM operations
      WHERE rework_order_id = ?
      ORDER BY op_time ASC, id ASC
    `).all(rework_order_id);
  },

  getLastColorRecord(batch_id) {
    return db.prepare(`
      SELECT * FROM operations
      WHERE batch_id = ? AND color_diff_desc IS NOT NULL
      ORDER BY op_time DESC, id DESC LIMIT 1
    `).get(batch_id);
  },

  getRecentColorRecords(batch_id, limit = 5) {
    return db.prepare(`
      SELECT * FROM operations
      WHERE batch_id = ? AND color_diff_desc IS NOT NULL
      ORDER BY op_time DESC, id DESC LIMIT ?
    `).all(batch_id, limit);
  },

  getLastRedyeSuggestion(batch_id) {
    return db.prepare(`
      SELECT * FROM operations
      WHERE batch_id = ? AND redye_suggestion IS NOT NULL AND redye_suggestion != ''
      ORDER BY op_time DESC, id DESC LIMIT 1
    `).get(batch_id);
  }
};

const vatRepo = {
  create(data) {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO vats (vat_no, vat_name, capacity, status, created_at, updated_at)
      VALUES (?, ?, ?, '空闲', ?, ?)
    `);
    const result = stmt.run(data.vat_no, nullish(data.vat_name), data.capacity ?? null, now, now);
    return this.getById(result.lastInsertRowid);
  },

  update(id, data) {
    const now = new Date().toISOString();
    const fields = [];
    const values = [];
    const allowed = ['vat_no', 'vat_name', 'capacity', 'status', 'current_batch_id'];
    for (const key of allowed) {
      if (data[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(data[key]);
      }
    }
    fields.push('updated_at = ?');
    values.push(now, id);
    const stmt = db.prepare(`UPDATE vats SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM vats WHERE id = ?').run(id);
  },

  getById(id) {
    return db.prepare('SELECT * FROM vats WHERE id = ?').get(id);
  },

  getByNo(vat_no) {
    return db.prepare('SELECT * FROM vats WHERE vat_no = ?').get(vat_no);
  },

  list() {
    return db.prepare('SELECT * FROM vats ORDER BY vat_no').all();
  },

  setOccupied(vat_no, batch_id) {
    const now = new Date().toISOString();
    vatOccupancyRepo.endOccupancy(vat_no, batch_id, now);
    vatOccupancyRepo.startOccupancy(vat_no, batch_id, now);
    return db.prepare('UPDATE vats SET status = ?, current_batch_id = ?, updated_at = ? WHERE vat_no = ?')
      .run('使用中', batch_id, now, vat_no);
  },

  setFree(vat_no) {
    const now = new Date().toISOString();
    const vat = this.getByNo(vat_no);
    if (vat && vat.current_batch_id) {
      vatOccupancyRepo.endOccupancy(vat_no, vat.current_batch_id, now);
    }
    return db.prepare('UPDATE vats SET status = ?, current_batch_id = NULL, updated_at = ? WHERE vat_no = ?')
      .run('空闲', now, vat_no);
  }
};

const materialRepo = {
  create(data) {
    const now = new Date().toISOString();
    const stmt = db.prepare('INSERT INTO materials (material_name, material_desc, created_at) VALUES (?, ?, ?)');
    const result = stmt.run(data.material_name, nullish(data.material_desc), now);
    return this.getById(result.lastInsertRowid);
  },

  update(id, data) {
    const fields = [];
    const values = [];
    if (data.material_name !== undefined) { fields.push('material_name = ?'); values.push(data.material_name); }
    if (data.material_desc !== undefined) { fields.push('material_desc = ?'); values.push(data.material_desc); }
    values.push(id);
    const stmt = db.prepare(`UPDATE materials SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM materials WHERE id = ?').run(id);
  },

  getById(id) {
    return db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
  },

  getByName(name) {
    return db.prepare('SELECT * FROM materials WHERE material_name = ?').get(name);
  },

  list() {
    return db.prepare('SELECT * FROM materials ORDER BY material_name').all();
  },

  getPassRate(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return db.prepare(`
      SELECT
        m.material_name,
        COUNT(b.id) AS total,
        SUM(CASE WHEN b.status = '通过' THEN 1 ELSE 0 END) AS passed,
        ROUND(CAST(SUM(CASE WHEN b.status = '通过' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(b.id), 0) * 100, 2) AS pass_rate
      FROM materials m
      LEFT JOIN batches b ON b.material = m.material_name AND b.created_at >= ?
      GROUP BY m.material_name
      ORDER BY m.material_name
    `).all(since);
  },

  getMaterialFailures(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return db.prepare(`
      SELECT
        material,
        COUNT(*) AS total,
        SUM(CASE WHEN status = '通过' THEN 1 ELSE 0 END) AS passed,
        ROUND(CAST(SUM(CASE WHEN status = '通过' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) * 100, 2) AS pass_rate,
        ROUND(CAST(COUNT(*) - SUM(CASE WHEN status = '通过' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) * 100, 2) AS fail_rate
      FROM batches
      WHERE created_at >= ?
      GROUP BY material
      HAVING COUNT(*) >= 3 AND fail_rate > 30
      ORDER BY fail_rate DESC
    `).all(since);
  }
};

const EXCEPTION_TYPES = ['recheck_overdue', 'color_deviation', 'redye_missing_color'];
const EXCEPTION_STATUSES = ['pending', 'processing', 'closed'];

const REWORK_SOURCE_TYPES = ['recheck', 'color_diff', 'exception', 'manual'];
const REWORK_STATUSES = ['pending', 'processing', 'completed', 'closed'];
const REWORK_OPEN_STATUSES = ['pending', 'processing'];

const exceptionRepo = {
  create(data) {
    const now = new Date().toISOString();
    const status = nullish(data.status, 'pending');
    const closedAt = status === 'closed' ? now : null;
    const stmt = db.prepare(`
      INSERT INTO exception_orders
      (batch_id, exception_type, exception_desc, handler, status, process_remark, created_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.batch_id,
      data.exception_type,
      data.exception_desc,
      nullish(data.handler),
      status,
      nullish(data.process_remark),
      now,
      closedAt
    );
    return this.getById(result.lastInsertRowid);
  },

  update(id, data) {
    const existing = this.getById(id);
    if (!existing) return null;

    const fields = [];
    const values = [];
    const allowed = ['exception_type', 'exception_desc', 'handler', 'status', 'process_remark'];
    for (const key of allowed) {
      if (data[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(data[key]);
      }
    }

    if (data.status !== undefined && data.status !== existing.status) {
      if (data.status === 'closed') {
        fields.push('closed_at = ?');
        values.push(new Date().toISOString());
      } else if (existing.status === 'closed' && data.status !== 'closed') {
        fields.push('closed_at = ?');
        values.push(null);
      }
    }

    if (values.length === 0) return existing;
    values.push(id);
    const stmt = db.prepare(`UPDATE exception_orders SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getById(id);
  },

  close(id, process_remark = null) {
    const now = new Date().toISOString();
    const fields = ['status = ?', 'closed_at = ?'];
    const values = ['closed', now];
    if (process_remark !== null && process_remark !== undefined) {
      fields.push('process_remark = ?');
      values.push(process_remark);
    }
    values.push(id);
    const stmt = db.prepare(`UPDATE exception_orders SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getById(id);
  },

  appendRemark(id, remark) {
    const existing = this.getById(id);
    if (!existing) return null;
    const combined = existing.process_remark
      ? `${existing.process_remark}\n${remark}`
      : remark;
    return this.update(id, { process_remark: combined });
  },

  getById(id) {
    return db.prepare(`
      SELECT eo.*, b.cloth_no, b.vat_no, b.material, b.shade_target, b.status AS batch_status
      FROM exception_orders eo
      LEFT JOIN batches b ON b.id = eo.batch_id
      WHERE eo.id = ?
    `).get(id);
  },

  getByBatch(batchId, includeClosed = false) {
    let sql = `
      SELECT eo.*, b.cloth_no, b.vat_no, b.material, b.shade_target, b.status AS batch_status
      FROM exception_orders eo
      LEFT JOIN batches b ON b.id = eo.batch_id
      WHERE eo.batch_id = ?
    `;
    const params = [batchId];
    if (!includeClosed) {
      sql += ' AND eo.status IN (?, ?)';
      params.push('pending', 'processing');
    }
    sql += ' ORDER BY eo.created_at DESC';
    return db.prepare(sql).all(...params);
  },

  getOpenByBatchAndType(batchId, exceptionType) {
    return db.prepare(`
      SELECT * FROM exception_orders
      WHERE batch_id = ? AND exception_type = ? AND status IN ('pending', 'processing')
      ORDER BY created_at DESC LIMIT 1
    `).get(batchId, exceptionType);
  },

  list(filters = {}) {
    const where = [];
    const params = [];

    if (filters.batch_id) { where.push('eo.batch_id = ?'); params.push(filters.batch_id); }
    if (filters.exception_type) { where.push('eo.exception_type = ?'); params.push(filters.exception_type); }
    if (filters.status) { where.push('eo.status = ?'); params.push(filters.status); }
    if (filters.handler) { where.push('eo.handler = ?'); params.push(filters.handler); }
    if (filters.start_date) { where.push('eo.created_at >= ?'); params.push(filters.start_date); }
    if (filters.end_date) { where.push('eo.created_at <= ?'); params.push(filters.end_date); }

    let sql = `
      SELECT eo.*, b.cloth_no, b.vat_no, b.material, b.shade_target, b.status AS batch_status
      FROM exception_orders eo
      LEFT JOIN batches b ON b.id = eo.batch_id
    `;
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY eo.created_at DESC';

    return db.prepare(sql).all(...params);
  },

  getOverview() {
    const statusCounts = db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM exception_orders
      GROUP BY status
    `).all();

    const typeCounts = db.prepare(`
      SELECT exception_type, COUNT(*) AS count
      FROM exception_orders
      GROUP BY exception_type
    `).all();

    const openOrdersWithBatches = db.prepare(`
      SELECT eo.*, b.cloth_no, b.vat_no, b.material, b.shade_target, b.status AS batch_status
      FROM exception_orders eo
      LEFT JOIN batches b ON b.id = eo.batch_id
      WHERE eo.status IN ('pending', 'processing')
      ORDER BY eo.created_at DESC
    `).all();

    const result = {
      pending_count: 0,
      processing_count: 0,
      closed_count: 0,
      total_count: 0,
      by_type: {},
      open_orders: openOrdersWithBatches
    };

    for (const row of statusCounts) {
      result.total_count += row.count;
      if (row.status === 'pending') result.pending_count = row.count;
      else if (row.status === 'processing') result.processing_count = row.count;
      else if (row.status === 'closed') result.closed_count = row.count;
    }

    for (const row of typeCounts) {
      result.by_type[row.exception_type] = row.count;
    }

    for (const type of EXCEPTION_TYPES) {
      if (result.by_type[type] === undefined) {
        result.by_type[type] = 0;
      }
    }

    return result;
  }
};

const reworkRepo = {
  create(data) {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO rework_orders
      (batch_id, source_type, source_id, rework_reason, disposal_plan, responsible_team,
       planned_completion_at, actual_completion_at, status, process_remark, handler,
       created_at, updated_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.batch_id,
      data.source_type,
      data.source_id ?? null,
      data.rework_reason,
      data.disposal_plan,
      data.responsible_team,
      data.planned_completion_at,
      data.actual_completion_at ?? null,
      nullish(data.status, 'pending'),
      nullish(data.process_remark),
      nullish(data.handler),
      now,
      now,
      null
    );
    return this.getById(result.lastInsertRowid);
  },

  update(id, data) {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const fields = [];
    const values = [];
    const allowed = [
      'rework_reason', 'disposal_plan', 'responsible_team',
      'planned_completion_at', 'actual_completion_at', 'status',
      'process_remark', 'handler', 'source_type', 'source_id'
    ];
    for (const key of allowed) {
      if (data[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(data[key]);
      }
    }

    if (data.status !== undefined && data.status !== existing.status) {
      if (data.status === 'closed') {
        fields.push('closed_at = ?');
        values.push(now);
      } else if (existing.status === 'closed' && data.status !== 'closed') {
        fields.push('closed_at = ?');
        values.push(null);
      }
      if (data.status === 'completed' && !existing.actual_completion_at) {
        fields.push('actual_completion_at = ?');
        values.push(now);
      }
    }

    if (values.length === 0) return existing;
    fields.push('updated_at = ?');
    values.push(now, id);
    const stmt = db.prepare(`UPDATE rework_orders SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getById(id);
  },

  close(id, process_remark = null) {
    const now = new Date().toISOString();
    const fields = ['status = ?', 'closed_at = ?', 'updated_at = ?'];
    const values = ['closed', now, now];
    if (process_remark !== null && process_remark !== undefined) {
      fields.push('process_remark = ?');
      const existing = this.getById(id);
      const combined = existing && existing.process_remark
        ? `${existing.process_remark}\n${process_remark}`
        : process_remark;
      values.push(combined);
    }
    values.push(id);
    const stmt = db.prepare(`UPDATE rework_orders SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getById(id);
  },

  advanceStatus(id, operationType) {
    const existing = this.getById(id);
    if (!existing) return null;
    if (existing.status === 'closed') return existing;

    const now = new Date().toISOString();
    let newStatus = existing.status;

    if (existing.status === 'pending') {
      newStatus = 'processing';
    }

    if (['复验', '固色'].includes(operationType) && existing.status === 'processing') {
      newStatus = 'completed';
    }

    if (newStatus !== existing.status) {
      return this.update(id, { status: newStatus });
    }
    return existing;
  },

  appendRemark(id, remark) {
    const existing = this.getById(id);
    if (!existing) return null;
    const combined = existing.process_remark
      ? `${existing.process_remark}\n${remark}`
      : remark;
    return this.update(id, { process_remark: combined });
  },

  getById(id) {
    return db.prepare(`
      SELECT ro.*, b.cloth_no, b.vat_no, b.material, b.shade_target, b.status AS batch_status,
             b.responsible_team AS batch_responsible_team
      FROM rework_orders ro
      LEFT JOIN batches b ON b.id = ro.batch_id
      WHERE ro.id = ?
    `).get(id);
  },

  getByBatch(batchId, includeClosed = false) {
    const placeholders = REWORK_OPEN_STATUSES.map(() => '?').join(',');
    let sql = `
      SELECT ro.*, b.cloth_no, b.vat_no, b.material, b.shade_target, b.status AS batch_status
      FROM rework_orders ro
      LEFT JOIN batches b ON b.id = ro.batch_id
      WHERE ro.batch_id = ?
    `;
    const params = [batchId];
    if (!includeClosed) {
      sql += ` AND ro.status IN (${placeholders})`;
      params.push(...REWORK_OPEN_STATUSES);
    }
    sql += ' ORDER BY ro.created_at DESC';
    return db.prepare(sql).all(...params);
  },

  getByException(exceptionId) {
    return db.prepare(`
      SELECT ro.*, b.cloth_no, b.vat_no, b.material, b.shade_target, b.status AS batch_status
      FROM rework_orders ro
      LEFT JOIN batches b ON b.id = ro.batch_id
      WHERE ro.source_type = 'exception' AND ro.source_id = ?
      ORDER BY ro.created_at DESC
    `).all(exceptionId);
  },

  getOpenByBatch(batchId) {
    const placeholders = REWORK_OPEN_STATUSES.map(() => '?').join(',');
    return db.prepare(`
      SELECT * FROM rework_orders
      WHERE batch_id = ? AND status IN (${placeholders})
      ORDER BY created_at DESC LIMIT 1
    `).get(batchId, ...REWORK_OPEN_STATUSES);
  },

  list(filters = {}) {
    const where = [];
    const params = [];

    if (filters.batch_id) { where.push('ro.batch_id = ?'); params.push(filters.batch_id); }
    if (filters.status) { where.push('ro.status = ?'); params.push(filters.status); }
    if (filters.responsible_team) { where.push('ro.responsible_team = ?'); params.push(filters.responsible_team); }
    if (filters.source_type) { where.push('ro.source_type = ?'); params.push(filters.source_type); }
    if (filters.source_id) { where.push('ro.source_id = ?'); params.push(filters.source_id); }
    if (filters.handler) { where.push('ro.handler = ?'); params.push(filters.handler); }
    if (filters.start_date) { where.push('ro.created_at >= ?'); params.push(filters.start_date); }
    if (filters.end_date) { where.push('ro.created_at <= ?'); params.push(filters.end_date); }
    if (filters.material) { where.push('b.material = ?'); params.push(filters.material); }

    let sql = `
      SELECT ro.*, b.cloth_no, b.vat_no, b.material, b.shade_target, b.status AS batch_status
      FROM rework_orders ro
      LEFT JOIN batches b ON b.id = ro.batch_id
    `;
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY ro.created_at DESC';

    return db.prepare(sql).all(...params);
  },

  getOverview() {
    const now = new Date().toISOString();
    const statusCounts = db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM rework_orders
      GROUP BY status
    `).all();

    const openPlaceholders = REWORK_OPEN_STATUSES.map(() => '?').join(',');
    const overdue = db.prepare(`
      SELECT COUNT(*) AS count
      FROM rework_orders
      WHERE status IN (${openPlaceholders})
      AND planned_completion_at IS NOT NULL
      AND planned_completion_at < ?
    `).get(...REWORK_OPEN_STATUSES, now).count;

    const byMaterial = db.prepare(`
      SELECT b.material,
             COUNT(ro.id) AS total,
             SUM(CASE WHEN ro.status IN (${openPlaceholders}) THEN 1 ELSE 0 END) AS open_count,
             SUM(CASE WHEN ro.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
             SUM(CASE WHEN ro.status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
             SUM(CASE WHEN ro.status IN (${openPlaceholders}) AND ro.planned_completion_at < ? THEN 1 ELSE 0 END) AS overdue_count
      FROM rework_orders ro
      LEFT JOIN batches b ON b.id = ro.batch_id
      GROUP BY b.material
      ORDER BY total DESC
    `).all(...REWORK_OPEN_STATUSES, ...REWORK_OPEN_STATUSES, now);

    const byTeam = db.prepare(`
      SELECT responsible_team,
             COUNT(*) AS total,
             SUM(CASE WHEN status IN (${openPlaceholders}) THEN 1 ELSE 0 END) AS open_count,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
             SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
             SUM(CASE WHEN status IN (${openPlaceholders}) AND planned_completion_at < ? THEN 1 ELSE 0 END) AS overdue_count
      FROM rework_orders
      GROUP BY responsible_team
      ORDER BY total DESC
    `).all(...REWORK_OPEN_STATUSES, ...REWORK_OPEN_STATUSES, now);

    const openOrdersWithBatches = db.prepare(`
      SELECT ro.*, b.cloth_no, b.vat_no, b.material, b.shade_target, b.status AS batch_status,
             CASE WHEN ro.planned_completion_at < ? THEN 1 ELSE 0 END AS is_overdue
      FROM rework_orders ro
      LEFT JOIN batches b ON b.id = ro.batch_id
      WHERE ro.status IN (${openPlaceholders})
      ORDER BY ro.created_at DESC
    `).all(now, ...REWORK_OPEN_STATUSES);

    const result = {
      pending_count: 0,
      processing_count: 0,
      completed_count: 0,
      closed_count: 0,
      total_count: 0,
      open_count: 0,
      overdue_count: overdue,
      by_material: byMaterial,
      by_team: byTeam,
      open_orders: openOrdersWithBatches
    };

    for (const row of statusCounts) {
      result.total_count += row.count;
      if (row.status === 'pending') { result.pending_count = row.count; result.open_count += row.count; }
      else if (row.status === 'processing') { result.processing_count = row.count; result.open_count += row.count; }
      else if (row.status === 'completed') result.completed_count = row.count;
      else if (row.status === 'closed') result.closed_count = row.count;
    }

    return result;
  },

  getOverdueReworks() {
    const now = new Date().toISOString();
    const placeholders = REWORK_OPEN_STATUSES.map(() => '?').join(',');
    return db.prepare(`
      SELECT ro.*, b.cloth_no, b.vat_no, b.material, b.shade_target, b.status AS batch_status
      FROM rework_orders ro
      LEFT JOIN batches b ON b.id = ro.batch_id
      WHERE ro.status IN (${placeholders})
      AND ro.planned_completion_at IS NOT NULL
      AND ro.planned_completion_at < ?
      ORDER BY ro.planned_completion_at ASC
    `).all(...REWORK_OPEN_STATUSES, now);
  }
};

const statsRepo = {
  getOverdueRechecks() {
    const now = new Date().toISOString();
    const placeholders = RECHECK_WAITING_STATUSES.map(() => '?').join(',');
    return db.prepare(`
      SELECT * FROM batches
      WHERE status IN (${placeholders})
      AND next_recheck_at IS NOT NULL
      AND next_recheck_at < ?
      ORDER BY next_recheck_at ASC
    `).all(...RECHECK_WAITING_STATUSES, now);
  },

  getPendingRechecks() {
    const placeholders = RECHECK_WAITING_STATUSES.map(() => '?').join(',');
    return db.prepare(`
      SELECT * FROM batches
      WHERE status IN (${placeholders})
      ORDER BY COALESCE(next_recheck_at, updated_at) ASC
    `).all(...RECHECK_WAITING_STATUSES);
  },

  getColorDeviationBatches() {
    const deviationKeywords = ['偏深', '偏浅', '偏红', '偏蓝', '偏黄', '色差大', '严重', '不合格', '不符'];
    const allBatches = db.prepare(`
      SELECT b.* FROM batches b
      WHERE b.status NOT IN ('通过')
      ORDER BY b.updated_at DESC
    `).all();

    const result = [];
    for (const batch of allBatches) {
      const records = db.prepare(`
        SELECT color_diff_desc FROM operations
        WHERE batch_id = ? AND color_diff_desc IS NOT NULL AND color_diff_desc != ''
        ORDER BY op_time DESC, id DESC LIMIT 3
      `).all(batch.id);

      if (records.length >= 2) {
        const hasContinuousDeviation = records.every(r =>
          deviationKeywords.some(kw => (r.color_diff_desc || '').includes(kw))
        );
        if (hasContinuousDeviation) {
          result.push({
            ...batch,
            recent_color_records: records.map(r => r.color_diff_desc)
          });
        }
      }
    }
    return result;
  },

  getRedyeWithoutNewColor() {
    return db.prepare(`
      SELECT b.*
      FROM batches b
      JOIN operations o_redye ON o_redye.batch_id = b.id AND o_redye.op_type = '补染'
      LEFT JOIN operations o_color ON o_color.batch_id = b.id
        AND o_color.color_diff_desc IS NOT NULL
        AND o_color.op_time > o_redye.op_time
      WHERE o_color.id IS NULL
      AND b.status != '通过'
      GROUP BY b.id
      ORDER BY o_redye.op_time DESC
    `).all();
  }
};

module.exports = {
  batchRepo,
  operationRepo,
  vatRepo,
  materialRepo,
  statsRepo,
  vatOccupancyRepo,
  exceptionRepo,
  reworkRepo,
  ACTIVE_STATUSES,
  RECHECK_WAITING_STATUSES,
  EXCEPTION_TYPES,
  EXCEPTION_STATUSES,
  REWORK_SOURCE_TYPES,
  REWORK_STATUSES,
  REWORK_OPEN_STATUSES,
  nullish
};
