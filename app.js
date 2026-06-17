const express = require('express');
const morgan = require('morgan');
const cors = require('cors');

const adminRoutes = require('./src/adminRoutes');
const operatorRoutes = require('./src/operatorRoutes');
const queryRoutes = require('./src/queryRoutes');

const PORT = process.env.PORT || 8113;

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/', (req, res) => {
  res.json({
    name: '蓝染布幅批次管理系统',
    version: '1.0.0',
    port: PORT,
    endpoints: {
      admin: '/api/admin',
      operator: '/api/operator',
      query: '/api/query'
    }
  });
});

app.use('/api/admin', adminRoutes);
app.use('/api/operator', operatorRoutes);
app.use('/api/query', queryRoutes);

app.use((req, res) => {
  res.status(404).json({ error: '接口不存在', path: req.path });
});

app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({
    error: '服务器内部错误',
    message: err.message
  });
});

app.listen(PORT, () => {
  console.log(`============================================`);
  console.log(`  蓝染布幅批次管理系统 服务已启动`);
  console.log(`  端口: ${PORT}`);
  console.log(`  时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`============================================`);
  console.log('');
  console.log('API 路由:');
  console.log('  管理员接口:  http://localhost:' + PORT + '/api/admin');
  console.log('  操作员接口:  http://localhost:' + PORT + '/api/operator');
  console.log('  查询统计:    http://localhost:' + PORT + '/api/query');
  console.log('');
});

module.exports = app;
