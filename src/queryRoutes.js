const express = require('express');
const router = express.Router();
const { batchRepo, operationRepo, materialRepo, statsRepo } = require('./repositories');
const {
  schemas,
  validateQuery,
  checkRecheckOverdue,
  checkContinuousColorDeviation,
  checkRedyeWithoutColor,
  checkMaterialHighFailure
} = require('./validators');

router.get('/batches', validateQuery(schemas.query), (req, res) => {
  try {
    const filters = req.validatedQuery || {};
    const batches = batchRepo.list(filters);
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/batches/:id', (req, res) => {
  try {
    const batch = batchRepo.getById(req.params.id);
    if (!batch) {
      return res.status(404).json({ error: '批次不存在' });
    }
    const operations = operationRepo.listByBatch(batch.id);

    const warnings = [];
    const overdue = checkRecheckOverdue(batch);
    if (overdue.overdue) warnings.push({ type: 'recheck_overdue', ...overdue });

    const deviation = checkContinuousColorDeviation(batch.id);
    if (deviation.deviation) warnings.push({ type: 'color_deviation', ...deviation });

    const redyeMissing = checkRedyeWithoutColor(batch.id);
    if (redyeMissing.missing) warnings.push({ type: 'redye_missing_color', ...redyeMissing });

    res.json({ ...batch, operations, warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/color-deviation-batches', (req, res) => {
  try {
    const batches = statsRepo.getColorDeviationBatches();
    res.json({
      total: batches.length,
      batches
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/pending-rechecks', (req, res) => {
  try {
    const pending = statsRepo.getPendingRechecks();
    const overdue = statsRepo.getOverdueRechecks();

    const now = new Date();
    const enriched = pending.map(b => {
      const warnings = [];
      if (b.next_recheck_at && new Date(b.next_recheck_at) < now) {
        const hours = Math.floor((now - new Date(b.next_recheck_at)) / (60 * 60 * 1000));
        warnings.push({ type: 'overdue', overdue_hours: hours });
      }
      return { ...b, warnings };
    });

    res.json({
      total: pending.length,
      overdue_count: overdue.length,
      pending: enriched
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/material-pass-rate', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const rates = materialRepo.getPassRate(days);
    const highFailures = checkMaterialHighFailure();

    const enriched = rates.map(r => ({
      ...r,
      is_high_failure: highFailures.some(h => h.material === r.material_name)
    }));

    res.json({
      days,
      total_materials: enriched.length,
      high_failure_materials: highFailures.length,
      data: enriched
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/overview', (req, res) => {
  try {
    const allBatches = batchRepo.list();
    const days = parseInt(req.query.days) || 30;

    const statusCounts = {};
    for (const b of allBatches) {
      statusCounts[b.status] = (statusCounts[b.status] || 0) + 1;
    }

    const colorDeviation = statsRepo.getColorDeviationBatches();
    const pendingRechecks = statsRepo.getPendingRechecks();
    const overdueRechecks = statsRepo.getOverdueRechecks();
    const redyeWithoutColor = statsRepo.getRedyeWithoutNewColor();
    const materialRates = materialRepo.getPassRate(days);
    const highFailures = checkMaterialHighFailure();

    res.json({
      total_batches: allBatches.length,
      status_distribution: statusCounts,
      color_deviation_batches: {
        count: colorDeviation.length,
        batches: colorDeviation
      },
      pending_rechecks: {
        count: pendingRechecks.length,
        overdue_count: overdueRechecks.length,
        pending: pendingRechecks
      },
      redye_without_color: {
        count: redyeWithoutColor.length,
        batches: redyeWithoutColor
      },
      material_pass_rates: {
        high_failure_count: highFailures.length,
        data: materialRates.map(r => ({
          ...r,
          is_high_failure: highFailures.some(h => h.material === r.material_name)
        }))
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/redye-without-color', (req, res) => {
  try {
    const batches = statsRepo.getRedyeWithoutNewColor();
    res.json({
      total: batches.length,
      batches
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/high-failure-materials', (req, res) => {
  try {
    const materials = checkMaterialHighFailure();
    res.json({
      total: materials.length,
      threshold: '失败率 > 30% 且样本数 >= 3',
      materials
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/vats', (req, res) => {
  try {
    const { vatRepo } = require('./repositories');
    const vats = vatRepo.list();
    res.json(vats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/materials', (req, res) => {
  try {
    const materials = materialRepo.list();
    res.json(materials);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
