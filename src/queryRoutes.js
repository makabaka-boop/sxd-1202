const express = require('express');
const router = express.Router();
const db = require('./db');
const { batchRepo, operationRepo, materialRepo, statsRepo, exceptionRepo, reworkRepo } = require('./repositories');
const {
  schemas,
  validateQuery,
  checkRecheckOverdue,
  checkContinuousColorDeviation,
  checkRedyeWithoutColor,
  checkMaterialHighFailure,
  autoGenerateExceptionFromWarning,
  checkReworkOverdue
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
    const autoGenResults = [];

    const tx = db.transaction(() => {
      const overdue = checkRecheckOverdue(batch);
      if (overdue.overdue) {
        warnings.push({ type: 'recheck_overdue', ...overdue });
        const gen = autoGenerateExceptionFromWarning(batch.id, 'recheck_overdue', overdue);
        if (gen.created) autoGenResults.push(gen);
      }

      const deviation = checkContinuousColorDeviation(batch.id);
      if (deviation.deviation) {
        warnings.push({ type: 'color_deviation', ...deviation });
        const gen = autoGenerateExceptionFromWarning(batch.id, 'color_deviation', deviation);
        if (gen.created) autoGenResults.push(gen);
      }

      const redyeMissing = checkRedyeWithoutColor(batch.id);
      if (redyeMissing.missing) {
        warnings.push({ type: 'redye_missing_color', ...redyeMissing });
        const gen = autoGenerateExceptionFromWarning(batch.id, 'redye_missing_color', redyeMissing);
        if (gen.created) autoGenResults.push(gen);
      }
    });
    tx();

    const openExceptions = exceptionRepo.getByBatch(batch.id, false);
    const reworks = reworkRepo.getByBatch(batch.id, true);

    const reworkWarnings = [];
    for (const rw of reworks) {
      const rwOverdue = checkReworkOverdue(rw);
      if (rwOverdue.overdue) {
        reworkWarnings.push({
          rework_id: rw.id,
          type: 'rework_overdue',
          ...rwOverdue
        });
      }
    }

    const openReworks = reworks.filter(r => ['pending', 'processing'].includes(r.status));
    const overdueReworks = reworks.filter(r => {
      if (!['pending', 'processing'].includes(r.status)) return false;
      if (!r.planned_completion_at) return false;
      return new Date(r.planned_completion_at) < new Date();
    });

    res.json({
      ...batch,
      operations,
      warnings: [...warnings, ...reworkWarnings],
      open_exceptions: openExceptions,
      reworks,
      rework_summary: {
        total: reworks.length,
        open_count: openReworks.length,
        overdue_count: overdueReworks.length
      }
    });
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
    const exceptionOverview = exceptionRepo.getOverview();
    const reworkOverview = reworkRepo.getOverview();

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
      },
      exception_disposal: exceptionOverview,
      rework_disposal: reworkOverview
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/exception-overview', (req, res) => {
  try {
    const overview = exceptionRepo.getOverview();
    res.json(overview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/rework-overview', (req, res) => {
  try {
    const overview = reworkRepo.getOverview();
    res.json(overview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/rework-overdue', (req, res) => {
  try {
    const overdue = reworkRepo.getOverdueReworks();
    res.json({
      total: overdue.length,
      reworks: overdue
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/reworks', validateQuery(schemas.reworkQuery), (req, res) => {
  try {
    const filters = req.validatedQuery || {};
    const reworks = reworkRepo.list(filters);
    res.json(reworks);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

    const warnings = [];
    const rwOverdue = checkReworkOverdue(rework);
    if (rwOverdue.overdue) {
      warnings.push({ type: 'rework_overdue', ...rwOverdue });
    }

    res.json({ ...rework, operations, warnings });
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
    const reworks = reworkRepo.getByException(id);
    res.json({ ...exception, reworks });
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
