const express = require('express');
const router = express.Router();
const db = require('./db');
const { batchRepo, vatRepo, materialRepo, operationRepo } = require('./repositories');
const {
  schemas,
  validate,
  checkVatConflict,
  checkStatusTransition,
  computeNextRecheck
} = require('./validators');

router.get('/batches', (req, res) => {
  try {
    const batches = batchRepo.list();
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
    res.json({ ...batch, operations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/batches', validate(schemas.createBatch), (req, res) => {
  const tx = db.transaction(() => {
    const data = req.validated;

    const existing = batchRepo.getByClothNo(data.cloth_no);
    if (existing) {
      throw new Error(`布幅编号 ${data.cloth_no} 已存在`);
    }

    const vatConflict = checkVatConflict(data.vat_no);
    if (vatConflict.conflict) {
      throw new Error(vatConflict.message);
    }

    const vat = vatRepo.getByNo(data.vat_no);
    if (!vat) {
      throw new Error(`染缸 ${data.vat_no} 不存在`);
    }

    const material = materialRepo.getByName(data.material);
    if (!material) {
      throw new Error(`材质 ${data.material} 不存在`);
    }

    const batch = batchRepo.create(data);

    if (['浸染中', '待预洗'].includes(batch.status)) {
      vatRepo.setOccupied(batch.vat_no, batch.id);
    }

    return batch;
  });

  try {
    const batch = tx();
    res.status(201).json(batch);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/batches/:id', validate(schemas.updateBatch), (req, res) => {
  const tx = db.transaction(() => {
    const id = parseInt(req.params.id);
    const existing = batchRepo.getById(id);
    if (!existing) {
      throw new Error('批次不存在');
    }

    const data = req.validated;

    if (data.vat_no && data.vat_no !== existing.vat_no) {
      const vatConflict = checkVatConflict(data.vat_no, id);
      if (vatConflict.conflict) {
        throw new Error(vatConflict.message);
      }
      const vat = vatRepo.getByNo(data.vat_no);
      if (!vat) {
        throw new Error(`染缸 ${data.vat_no} 不存在`);
      }
    }

    if (data.material && data.material !== existing.material) {
      const material = materialRepo.getByName(data.material);
      if (!material) {
        throw new Error(`材质 ${data.material} 不存在`);
      }
    }

    if (data.status) {
      const transition = checkStatusTransition(existing.status, data.status);
      if (!transition.valid) {
        throw new Error(transition.message);
      }
    }

    const updated = batchRepo.update(id, data);

    if (data.status === '通过' || data.status === '待复验' || data.status === '停留观察') {
      vatRepo.setFree(existing.vat_no);
    } else if (data.status === '浸染中' || data.status === '需补染' || data.status === '待预洗') {
      const useVat = data.vat_no || existing.vat_no;
      const vatConflict = checkVatConflict(useVat, id);
      if (!vatConflict.conflict) {
        vatRepo.setOccupied(useVat, id);
      }
    }

    return updated;
  });

  try {
    const batch = tx();
    res.json(batch);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/batches/:id', (req, res) => {
  const tx = db.transaction(() => {
    const id = parseInt(req.params.id);
    const existing = batchRepo.getById(id);
    if (!existing) {
      throw new Error('批次不存在');
    }
    vatRepo.setFree(existing.vat_no);
    batchRepo.delete(id);
  });

  try {
    tx();
    res.json({ message: '删除成功' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/vats', (req, res) => {
  try {
    const vats = vatRepo.list();
    res.json(vats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/vats/:id', (req, res) => {
  try {
    const vat = vatRepo.getById(req.params.id);
    if (!vat) {
      return res.status(404).json({ error: '染缸不存在' });
    }
    res.json(vat);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/vats', validate(schemas.vat), (req, res) => {
  try {
    const existing = vatRepo.getByNo(req.validated.vat_no);
    if (existing) {
      return res.status(400).json({ error: `染缸编号 ${req.validated.vat_no} 已存在` });
    }
    const vat = vatRepo.create(req.validated);
    res.status(201).json(vat);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/vats/:id', validate(schemas.vat), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = vatRepo.getById(id);
    if (!existing) {
      return res.status(404).json({ error: '染缸不存在' });
    }
    const vat = vatRepo.update(id, req.validated);
    res.json(vat);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/vats/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = vatRepo.getById(id);
    if (!existing) {
      return res.status(404).json({ error: '染缸不存在' });
    }
    vatRepo.delete(id);
    res.json({ message: '删除成功' });
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

router.get('/materials/:id', (req, res) => {
  try {
    const material = materialRepo.getById(req.params.id);
    if (!material) {
      return res.status(404).json({ error: '材质不存在' });
    }
    res.json(material);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/materials', validate(schemas.material), (req, res) => {
  try {
    const existing = materialRepo.getByName(req.validated.material_name);
    if (existing) {
      return res.status(400).json({ error: `材质 ${req.validated.material_name} 已存在` });
    }
    const material = materialRepo.create(req.validated);
    res.status(201).json(material);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/materials/:id', validate(schemas.material), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = materialRepo.getById(id);
    if (!existing) {
      return res.status(404).json({ error: '材质不存在' });
    }
    const material = materialRepo.update(id, req.validated);
    res.json(material);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/materials/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = materialRepo.getById(id);
    if (!existing) {
      return res.status(404).json({ error: '材质不存在' });
    }
    materialRepo.delete(id);
    res.json({ message: '删除成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
