const express = require('express');
const router = express.Router();
const db = require('./db');
const { batchRepo, operationRepo, vatRepo, vatOccupancyRepo, exceptionRepo, reworkRepo } = require('./repositories');
const {
  schemas,
  validate,
  checkStatusTransition,
  checkRecheckOverdue,
  checkContinuousColorDeviation,
  checkRedyeWithoutColor,
  checkVatConflict,
  computeNextRecheck,
  checkExceptionExists,
  autoGenerateExceptionFromWarning,
  checkReworkExists,
  checkReworkClosed,
  checkBatchExistsForRework
} = require('./validators');

router.post('/batches/:id/operations', validate(schemas.operation), (req, res) => {
  const tx = db.transaction(() => {
    const batchId = parseInt(req.params.id);
    const batch = batchRepo.getById(batchId);
    if (!batch) {
      throw new Error('批次不存在');
    }

    const data = req.validated;

    if (data.rework_order_id) {
      const reworkCheck = checkReworkClosed(data.rework_order_id);
      if (!reworkCheck.exists) {
        throw new Error(reworkCheck.message);
      }
      if (reworkCheck.closed) {
        throw new Error(reworkCheck.message);
      }
      if (reworkCheck.rework.batch_id !== batchId) {
        throw new Error(`返工处置单(ID:${data.rework_order_id})属于批次(ID:${reworkCheck.rework.batch_id})，与当前批次不匹配`);
      }
    }

    const transition = checkStatusTransition(batch.status, null, data.op_type);
    if (!transition.valid) {
      throw new Error(transition.message);
    }

    if (['浸染', '补染', '预洗'].includes(data.op_type)) {
      const opTime = data.op_time || new Date().toISOString();
      const conflict = checkVatConflict(batch.vat_no, batchId, opTime, data.duration_minutes);
      if (conflict.conflict) {
        throw new Error(conflict.message);
      }
    }

    const operationData = {
      ...data,
      batch_id: batchId
    };
    const operation = operationRepo.create(operationData);

    if (data.rework_order_id) {
      reworkRepo.advanceStatus(data.rework_order_id, data.op_type);
    }

    const updates = {};
    let newDipCount = batch.dip_count;

    switch (data.op_type) {
      case '预洗':
        updates.status = '待预洗';
        break;
      case '浸染':
      case '补染':
        updates.status = '浸染中';
        newDipCount += 1;
        updates.dip_count = newDipCount;
        break;
      case '晾置':
        updates.status = '晾置中';
        break;
      case '固色':
        updates.status = '待复验';
        updates.last_recheck_at = operation.op_time;
        updates.next_recheck_at = computeNextRecheck({
          ...batch,
          last_recheck_at: operation.op_time
        });
        break;
      case '复验':
        updates.status = '待复验';
        updates.last_recheck_at = operation.op_time;
        updates.next_recheck_at = computeNextRecheck({
          ...batch,
          last_recheck_at: operation.op_time
        });
        break;
    }

    if (data.color_diff_desc || data.edge_halo_level !== undefined || data.redye_suggestion) {
      if (data.redye_suggestion && String(data.redye_suggestion).trim() !== '') {
        updates.status = '需补染';
      }
    }

    if (Object.keys(updates).length > 0) {
      batchRepo.update(batchId, updates);
    }

    const updatedBatch = batchRepo.getById(batchId);

    if (['浸染中', '需补染', '待预洗'].includes(updatedBatch.status)) {
      vatRepo.setOccupied(updatedBatch.vat_no, updatedBatch.id);
    } else if (['晾置中', '待复验', '通过', '停留观察'].includes(updatedBatch.status)) {
      vatRepo.setFree(updatedBatch.vat_no);
    }

    const rework = data.rework_order_id ? reworkRepo.getById(data.rework_order_id) : null;
    return { operation, batch: updatedBatch, rework };
  });

  try {
    const result = tx();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/batches/:id/prewash', (req, res) => {
  req.body = { ...req.body, op_type: '预洗' };
  handleOperation(req, res);
});

router.post('/batches/:id/dip', (req, res) => {
  req.body = { ...req.body, op_type: '浸染' };
  handleOperation(req, res);
});

router.post('/batches/:id/dry', (req, res) => {
  req.body = { ...req.body, op_type: '晾置' };
  handleOperation(req, res);
});

router.post('/batches/:id/fix', (req, res) => {
  req.body = { ...req.body, op_type: '固色' };
  handleOperation(req, res);
});

router.post('/batches/:id/recheck', (req, res) => {
  req.body = { ...req.body, op_type: '复验' };
  handleOperation(req, res);
});

router.post('/batches/:id/redye', (req, res) => {
  req.body = { ...req.body, op_type: '补染' };
  handleOperation(req, res);
});

router.post('/batches/:id/color', (req, res) => {
  req.body = { ...req.body, op_type: '色差登记' };
  handleOperation(req, res);
});

function handleOperation(req, res) {
  const tx = db.transaction(() => {
    const batchId = parseInt(req.params.id);
    const batch = batchRepo.getById(batchId);
    if (!batch) {
      throw new Error('批次不存在');
    }

    const data = req.body;
    const opType = data.op_type;

    const { error, value } = schemas.operation.validate(data, { abortEarly: false, convert: true });
    if (error) {
      throw new Error('参数校验失败: ' + error.details.map(d => d.message).join('; '));
    }

    if (value.rework_order_id) {
      const reworkCheck = checkReworkClosed(value.rework_order_id);
      if (reworkCheck.closed) {
        throw new Error(reworkCheck.message);
      }
      if (reworkCheck.rework && reworkCheck.rework.batch_id !== batchId) {
        throw new Error('返工处置单与批次不匹配');
      }
    }

    const transition = checkStatusTransition(batch.status, null, opType);
    if (!transition.valid) {
      throw new Error(transition.message);
    }

    if (['浸染', '补染', '预洗'].includes(opType)) {
      const opTime = value.op_time || new Date().toISOString();
      const conflict = checkVatConflict(batch.vat_no, batchId, opTime, value.duration_minutes);
      if (conflict.conflict) {
        throw new Error(conflict.message);
      }
    }

    const operationData = {
      ...value,
      batch_id: batchId
    };
    const operation = operationRepo.create(operationData);

    if (value.rework_order_id) {
      reworkRepo.advanceStatus(value.rework_order_id, opType);
    }

    const updates = {};
    let newDipCount = batch.dip_count;

    switch (opType) {
      case '预洗':
        updates.status = '待预洗';
        break;
      case '浸染':
      case '补染':
        updates.status = '浸染中';
        newDipCount += 1;
        updates.dip_count = newDipCount;
        break;
      case '晾置':
        updates.status = '晾置中';
        break;
      case '固色':
        updates.status = '待复验';
        updates.last_recheck_at = operation.op_time;
        updates.next_recheck_at = computeNextRecheck({
          ...batch,
          last_recheck_at: operation.op_time
        });
        break;
      case '复验':
        updates.status = '待复验';
        updates.last_recheck_at = operation.op_time;
        updates.next_recheck_at = computeNextRecheck({
          ...batch,
          last_recheck_at: operation.op_time
        });
        break;
      case '色差登记':
        if (value.redye_suggestion && String(value.redye_suggestion).trim() !== '') {
          updates.status = '需补染';
        }
        break;
    }

    if (Object.keys(updates).length > 0) {
      batchRepo.update(batchId, updates);
    }

    const updatedBatch = batchRepo.getById(batchId);

    if (['浸染中', '需补染', '待预洗'].includes(updatedBatch.status)) {
      vatRepo.setOccupied(updatedBatch.vat_no, updatedBatch.id);
    } else if (['晾置中', '待复验', '通过', '停留观察'].includes(updatedBatch.status)) {
      vatRepo.setFree(updatedBatch.vat_no);
    }

    const rework = value.rework_order_id ? reworkRepo.getById(value.rework_order_id) : null;
    return { operation, batch: updatedBatch, rework };
  });

  try {
    const result = tx();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

router.get('/batches/:id/warnings', (req, res) => {
  try {
    const batchId = parseInt(req.params.id);
    const batch = batchRepo.getById(batchId);
    if (!batch) {
      return res.status(404).json({ error: '批次不存在' });
    }

    const warnings = [];

    const tx = db.transaction(() => {
      const overdue = checkRecheckOverdue(batch);
      if (overdue.overdue) {
        warnings.push({
          type: 'recheck_overdue',
          message: overdue.message,
          detail: overdue
        });
        autoGenerateExceptionFromWarning(batchId, 'recheck_overdue', overdue);
      }

      const deviation = checkContinuousColorDeviation(batchId);
      if (deviation.deviation) {
        warnings.push({
          type: 'color_deviation',
          message: deviation.message,
          detail: deviation
        });
        autoGenerateExceptionFromWarning(batchId, 'color_deviation', deviation);
      }

      const redyeMissing = checkRedyeWithoutColor(batchId);
      if (redyeMissing.missing) {
        warnings.push({
          type: 'redye_missing_color',
          message: redyeMissing.message,
          detail: redyeMissing
        });
        autoGenerateExceptionFromWarning(batchId, 'redye_missing_color', redyeMissing);
      }
    });
    tx();

    const openExceptions = exceptionRepo.getByBatch(batchId, false);

    res.json({
      batch_id: batchId,
      warnings,
      open_exceptions: openExceptions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/batches/:id/operations', (req, res) => {
  try {
    const batchId = parseInt(req.params.id);
    const batch = batchRepo.getById(batchId);
    if (!batch) {
      return res.status(404).json({ error: '批次不存在' });
    }
    const operations = operationRepo.listByBatch(batchId);
    res.json(operations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/vats/:vat_no/occupancy', (req, res) => {
  try {
    const vat_no = req.params.vat_no;
    const list = vatOccupancyRepo.listByVat(vat_no);
    const active = vatOccupancyRepo.getActiveOccupancy(vat_no);
    res.json({ vat_no, active, history: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/exceptions/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const exception = exceptionRepo.getById(id);
    if (!exception) {
      return res.status(404).json({ error: '异常处置单不存在' });
    }
    res.json(exception);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/exceptions/:id/remark', validate(schemas.appendExceptionRemark), (req, res) => {
  const tx = db.transaction(() => {
    const id = parseInt(req.params.id);
    const data = req.validated;

    const existCheck = checkExceptionExists(id);
    if (!existCheck.exists) {
      throw new Error(existCheck.message);
    }

    const existing = existCheck.exception;
    if (existing.status === 'closed') {
      throw new Error('已关闭的异常处置单不可追加备注');
    }

    return exceptionRepo.appendRemark(id, data.process_remark);
  });

  try {
    const exception = tx();
    res.json(exception);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/reworks/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rework = reworkRepo.getById(id);
    if (!rework) {
      return res.status(404).json({ error: '返工处置单不存在' });
    }
    const operations = operationRepo.listByReworkOrder(id);
    res.json({ ...rework, operations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/batches/:id/reworks', (req, res) => {
  try {
    const batchId = parseInt(req.params.id);
    const batch = batchRepo.getById(batchId);
    if (!batch) {
      return res.status(404).json({ error: '批次不存在' });
    }
    const includeClosed = req.query.include_closed === 'true';
    const reworks = reworkRepo.getByBatch(batchId, includeClosed);
    res.json(reworks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/batches/:id/reworks', validate(schemas.createRework), (req, res) => {
  const tx = db.transaction(() => {
    const batchId = parseInt(req.params.id);
    const data = req.validated;

    const batchCheck = checkBatchExistsForRework(batchId);
    if (!batchCheck.exists) {
      throw new Error(batchCheck.message);
    }

    if (data.batch_id !== batchId) {
      throw new Error('请求路径中的批次ID与请求体不一致');
    }

    if (data.source_type === 'exception' && data.source_id) {
      const exCheck = checkExceptionExists(data.source_id);
      if (!exCheck.exists) {
        throw new Error('关联的异常处置单不存在');
      }
      if (exCheck.exception.batch_id !== batchId) {
        throw new Error('关联的异常处置单与批次不匹配');
      }
    }

    if (data.source_operation_id) {
      const srcOp = operationRepo.getById(data.source_operation_id);
      if (!srcOp) {
        throw new Error(`来源操作记录(ID:${data.source_operation_id})不存在`);
      }
      if (srcOp.batch_id !== batchId) {
        throw new Error(`来源操作记录(ID:${data.source_operation_id})与批次不匹配`);
      }
    }

    return reworkRepo.create(data);
  });

  try {
    const rework = tx();
    res.status(201).json(rework);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/exceptions/:id/reworks', (req, res) => {
  const tx = db.transaction(() => {
    const exceptionId = parseInt(req.params.id);

    const exCheck = checkExceptionExists(exceptionId);
    if (!exCheck.exists) {
      throw new Error(exCheck.message);
    }

    const batchId = exCheck.exception.batch_id;

    req.body.source_type = 'exception';
    req.body.source_id = exceptionId;
    req.body.batch_id = batchId;

    const { error, value } = schemas.createRework.validate(req.body, { abortEarly: false, convert: true });
    if (error) {
      throw new Error('参数校验失败: ' + error.details.map(d => d.message).join('; '));
    }

    return reworkRepo.create(value);
  });

  try {
    const rework = tx();
    res.status(201).json(rework);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/reworks/:id/remark', validate(schemas.appendReworkRemark), (req, res) => {
  const tx = db.transaction(() => {
    const id = parseInt(req.params.id);
    const data = req.validated;

    const closedCheck = checkReworkClosed(id);
    if (closedCheck.closed) {
      throw new Error(closedCheck.message);
    }

    return reworkRepo.appendRemark(id, data.process_remark);
  });

  try {
    const rework = tx();
    res.json(rework);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
