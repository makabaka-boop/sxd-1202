const express = require('express');
const router = express.Router();
const db = require('./db');
const { batchRepo, operationRepo, vatRepo } = require('./repositories');
const {
  schemas,
  validate,
  checkStatusTransition,
  checkRecheckOverdue,
  checkContinuousColorDeviation,
  checkRedyeWithoutColor,
  computeNextRecheck
} = require('./validators');

router.post('/batches/:id/operations', validate(schemas.operation), (req, res) => {
  const tx = db.transaction(() => {
    const batchId = parseInt(req.params.id);
    const batch = batchRepo.getById(batchId);
    if (!batch) {
      throw new Error('批次不存在');
    }

    const data = req.validated;

    const transition = checkStatusTransition(batch.status, null, data.op_type);
    if (!transition.valid) {
      throw new Error(transition.message);
    }

    const operationData = {
      ...data,
      batch_id: batchId
    };
    const operation = operationRepo.create(operationData);

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
      // 色差登记本身不改变状态，但如果有补染建议，标记状态
      if (data.redye_suggestion && data.redye_suggestion.trim() !== '') {
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

    return { operation, batch: updatedBatch };
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
  const handler = router.stack.find(l => l.route && l.route.path === '/batches/:id/operations');
  res.redirect ? null : null;
  req.url = `/api/operator/batches/${req.params.id}/operations`;
  req.method = 'POST';
  router.handle(req, res, () => {});
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

    const { error, value } = schemas.operation.validate(data, { abortEarly: false });
    if (error) {
      throw new Error('参数校验失败: ' + error.details.map(d => d.message).join('; '));
    }

    const transition = checkStatusTransition(batch.status, null, opType);
    if (!transition.valid) {
      throw new Error(transition.message);
    }

    const operationData = {
      ...value,
      batch_id: batchId
    };
    const operation = operationRepo.create(operationData);

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
        if (value.redye_suggestion && value.redye_suggestion.trim() !== '') {
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

    return { operation, batch: updatedBatch };
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

    const overdue = checkRecheckOverdue(batch);
    if (overdue.overdue) {
      warnings.push({
        type: 'recheck_overdue',
        message: overdue.message,
        detail: overdue
      });
    }

    const deviation = checkContinuousColorDeviation(batchId);
    if (deviation.deviation) {
      warnings.push({
        type: 'color_deviation',
        message: deviation.message,
        detail: deviation
      });
    }

    const redyeMissing = checkRedyeWithoutColor(batchId);
    if (redyeMissing.missing) {
      warnings.push({
        type: 'redye_missing_color',
        message: redyeMissing.message,
        detail: redyeMissing
      });
    }

    res.json({ batch_id: batchId, warnings });
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

module.exports = router;
