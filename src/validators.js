const Joi = require('joi');
const { batchRepo, operationRepo, vatRepo, materialRepo } = require('./repositories');

const VALID_STATUSES = ['待预洗', '浸染中', '晾置中', '待复验', '需补染', '通过', '停留观察'];
const VALID_OP_TYPES = ['预洗', '浸染', '晾置', '固色', '复验', '补染', '色差登记', '其他'];

const schemas = {
  createBatch: Joi.object({
    cloth_no: Joi.string().required().trim().min(1),
    vat_no: Joi.string().required().trim().min(1),
    material: Joi.string().required().trim().min(1),
    shade_target: Joi.string().required().trim().min(1),
    responsible_team: Joi.string().required().trim().min(1),
    recheck_cycle: Joi.number().integer().min(1).max(720).default(24),
    remark: Joi.string().allow('', null)
  }),

  updateBatch: Joi.object({
    cloth_no: Joi.string().trim().min(1),
    vat_no: Joi.string().trim().min(1),
    material: Joi.string().trim().min(1),
    shade_target: Joi.string().trim().min(1),
    responsible_team: Joi.string().trim().min(1),
    recheck_cycle: Joi.number().integer().min(1).max(720),
    status: Joi.string().valid(...VALID_STATUSES),
    remark: Joi.string().allow('', null)
  }),

  operation: Joi.object({
    op_type: Joi.string().required().valid(...VALID_OP_TYPES),
    op_time: Joi.string().isoDate(),
    operator: Joi.string().allow('', null),
    color_diff_desc: Joi.string().allow('', null),
    edge_halo_level: Joi.number().integer().min(0).max(5).allow(null),
    redye_suggestion: Joi.string().allow('', null),
    temperature: Joi.number().allow(null),
    duration_minutes: Joi.number().integer().min(0).allow(null),
    remark: Joi.string().allow('', null)
  }),

  vat: Joi.object({
    vat_no: Joi.string().required().trim().min(1),
    vat_name: Joi.string().allow('', null),
    capacity: Joi.number().min(0).allow(null)
  }),

  material: Joi.object({
    material_name: Joi.string().required().trim().min(1),
    material_desc: Joi.string().allow('', null)
  }),

  query: Joi.object({
    vat_no: Joi.string().trim(),
    material: Joi.string().trim(),
    shade_target: Joi.string().trim(),
    status: Joi.string().valid(...VALID_STATUSES),
    responsible_team: Joi.string().trim(),
    start_date: Joi.string().isoDate(),
    end_date: Joi.string().isoDate(),
    edge_halo_level: Joi.number().integer().min(0).max(5)
  })
};

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        error: '参数校验失败',
        details: error.details.map(d => d.message)
      });
    }
    req.validated = value;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        error: '参数校验失败',
        details: error.details.map(d => d.message)
      });
    }
    req.validatedQuery = value;
    next();
  };
}

function checkVatConflict(vat_no, excludeBatchId = null) {
  const conflict = batchRepo.getActiveByVat(vat_no, excludeBatchId);
  if (conflict) {
    return {
      conflict: true,
      message: `染缸 ${vat_no} 当前已被批次 ${conflict.cloth_no} 占用（状态：${conflict.status}）`,
      batch: conflict
    };
  }
  return { conflict: false };
}

function checkStatusTransition(currentStatus, targetStatus, opType) {
  const transitions = {
    '待预洗': ['浸染中', '待预洗'],
    '浸染中': ['晾置中', '待复验', '浸染中'],
    '晾置中': ['待复验', '需补染', '浸染中', '晾置中'],
    '待复验': ['通过', '需补染', '停留观察', '浸染中', '待复验'],
    '需补染': ['浸染中', '待复验', '需补染'],
    '停留观察': ['待复验', '需补染', '通过', '浸染中', '停留观察'],
    '通过': ['通过']
  };

  if (opType) {
    const opStatusMap = {
      '预洗': '待预洗',
      '浸染': '浸染中',
      '晾置': '晾置中',
      '固色': '待复验',
      '复验': '待复验',
      '补染': '浸染中',
      '色差登记': null,
      '其他': null
    };
    const impliedStatus = opStatusMap[opType];
    if (impliedStatus && targetStatus && impliedStatus !== targetStatus) {
      return {
        valid: false,
        message: `操作类型"${opType}"应对应状态"${impliedStatus}"，与目标状态"${targetStatus}"不一致`
      };
    }
    if (impliedStatus && !targetStatus) {
      targetStatus = impliedStatus;
    }
  }

  if (!targetStatus) {
    return { valid: true, targetStatus: currentStatus };
  }

  const allowed = transitions[currentStatus] || [];
  if (!allowed.includes(targetStatus)) {
    return {
      valid: false,
      message: `无法从状态"${currentStatus}"转换到"${targetStatus}"，允许的状态：${allowed.join('、')}`
    };
  }

  return { valid: true, targetStatus };
}

function checkRedyeWithoutColor(batch_id) {
  const lastRedye = operationRepo.create.length > 0 ? null : null;
  const allOps = operationRepo.listByBatch(batch_id);
  const redyeOps = allOps.filter(o => o.op_type === '补染').sort((a, b) => new Date(b.op_time) - new Date(a.op_time));

  if (redyeOps.length === 0) return { missing: false };

  const lastRedyeOp = redyeOps[0];
  const colorAfterRedye = allOps.filter(o =>
    o.color_diff_desc && o.color_diff_desc !== '' &&
    new Date(o.op_time) > new Date(lastRedyeOp.op_time)
  );

  if (colorAfterRedye.length === 0) {
    return {
      missing: true,
      message: `补染操作（${lastRedyeOp.op_time}）后未提交新的色差记录`,
      last_redye: lastRedyeOp
    };
  }
  return { missing: false };
}

function checkRecheckOverdue(batch) {
  if (!['待复验', '停留观察'].includes(batch.status)) return { overdue: false };
  if (!batch.next_recheck_at) return { overdue: false };

  const now = new Date();
  const next = new Date(batch.next_recheck_at);
  if (now > next) {
    const hours = Math.floor((now - next) / (60 * 60 * 1000));
    return {
      overdue: true,
      message: `复验已逾期 ${hours} 小时`,
      overdue_hours: hours
    };
  }
  return { overdue: false };
}

function checkContinuousColorDeviation(batch_id) {
  const deviationKeywords = ['偏深', '偏浅', '偏红', '偏蓝', '偏黄', '色差大', '严重', '不合格', '不符'];
  const recent = operationRepo.getRecentColorRecords(batch_id, 3);

  if (recent.length < 2) return { deviation: false };

  const allDeviated = recent.every(r =>
    r.color_diff_desc && deviationKeywords.some(kw => r.color_diff_desc.includes(kw))
  );

  if (allDeviated) {
    return {
      deviation: true,
      message: `连续 ${recent.length} 次色差记录存在偏离`,
      records: recent.map(r => ({
        time: r.op_time,
        desc: r.color_diff_desc
      }))
    };
  }
  return { deviation: false };
}

function checkMaterialHighFailure() {
  return materialRepo.getMaterialFailures(30);
}

function computeNextRecheck(batch) {
  if (!batch.recheck_cycle) return null;
  const base = batch.last_recheck_at ? new Date(batch.last_recheck_at) : new Date();
  return new Date(base.getTime() + batch.recheck_cycle * 60 * 60 * 1000).toISOString();
}

module.exports = {
  schemas,
  validate,
  validateQuery,
  checkVatConflict,
  checkStatusTransition,
  checkRedyeWithoutColor,
  checkRecheckOverdue,
  checkContinuousColorDeviation,
  checkMaterialHighFailure,
  computeNextRecheck,
  VALID_STATUSES,
  VALID_OP_TYPES
};
