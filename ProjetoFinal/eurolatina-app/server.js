'use strict';

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(__dirname, 'database.sqlite');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const STATUSES = new Set(['pendente', 'liquidada']);

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new sqlite3.Database(DB_FILE);

app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));
app.use(express.static(PUBLIC_DIR));

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

function todayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateAccount(input, partial = false) {
  const errors = [];
  const result = {};

  if (!partial || Object.hasOwn(input, 'fornecedor')) {
    const supplier = String(input.fornecedor ?? '').trim();
    if (!supplier) errors.push('Informe o nome do fornecedor.');
    else if (supplier.length > 120) errors.push('O nome do fornecedor deve ter até 120 caracteres.');
    else result.fornecedor = supplier;
  }

  if (!partial || Object.hasOwn(input, 'data_vencimento')) {
    if (!isValidDate(input.data_vencimento)) errors.push('Informe uma data de vencimento válida.');
    else result.data_vencimento = input.data_vencimento;
  }

  if (!partial || Object.hasOwn(input, 'valor')) {
    const amount = Number(input.valor);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 999999999) {
      errors.push('O valor deve ser maior que zero e estar dentro do limite permitido.');
    } else {
      const rounded = Math.round(amount * 100) / 100;
      if (rounded <= 0) errors.push('O valor mínimo permitido é R$ 0,01.');
      else result.valor = rounded;
    }
  }

  for (const field of ['descricao', 'categoria', 'numero_documento']) {
    if (Object.hasOwn(input, field)) {
      const value = String(input[field] ?? '').trim();
      const max = field === 'descricao' ? 500 : 80;
      if (value.length > max) errors.push(`${field} deve ter até ${max} caracteres.`);
      else result[field] = value || (field === 'categoria' ? 'Outros' : null);
    }
  }

  if (Object.hasOwn(input, 'status')) {
    if (!STATUSES.has(input.status)) errors.push('Status inválido.');
    else result.status = input.status;
  }

  return { errors, value: result };
}

function accountById(id) {
  return get('SELECT * FROM contas WHERE id = ?', [id]);
}

async function deleteStoredAttachment(filename) {
  if (!filename) return;
  const safeName = path.basename(filename);
  try {
    await fs.promises.unlink(path.join(UPLOAD_DIR, safeName));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function initializeDatabase() {
  await run(`CREATE TABLE IF NOT EXISTS contas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fornecedor TEXT NOT NULL,
    data_criacao TEXT,
    data_vencimento TEXT NOT NULL,
    data_liquidacao TEXT,
    valor REAL NOT NULL CHECK (valor > 0),
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'liquidada')),
    descricao TEXT,
    categoria TEXT DEFAULT 'Outros',
    numero_documento TEXT,
    anexo_nome TEXT,
    anexo_arquivo TEXT,
    anexo_mime TEXT,
    anexo_tamanho INTEGER
  )`);

  // Migração incremental: mantém os registros da versão anterior do projeto.
  const columns = await all('PRAGMA table_info(contas)');
  const existing = new Set(columns.map((column) => column.name));
  const additions = [
    ['data_criacao', 'TEXT'],
    ['data_liquidacao', 'TEXT'],
    ['descricao', 'TEXT'],
    ['categoria', "TEXT DEFAULT 'Outros'"],
    ['numero_documento', 'TEXT'],
    ['anexo_nome', 'TEXT'],
    ['anexo_arquivo', 'TEXT'],
    ['anexo_mime', 'TEXT'],
    ['anexo_tamanho', 'INTEGER']
  ];

  for (const [name, type] of additions) {
    if (!existing.has(name)) await run(`ALTER TABLE contas ADD COLUMN ${name} ${type}`);
  }

  await run("UPDATE contas SET data_criacao = COALESCE(data_criacao, datetime('now', 'localtime'))");
  await run("UPDATE contas SET categoria = COALESCE(NULLIF(categoria, ''), 'Outros')");
  await run('CREATE INDEX IF NOT EXISTS idx_contas_vencimento ON contas(data_vencimento)');
  await run('CREATE INDEX IF NOT EXISTS idx_contas_status ON contas(status)');
}

// Health check para facilitar testes e diagnóstico local.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', aplicacao: 'EUROLATINA - Contas a Pagar' });
});

// Lista as contas e aceita filtros opcionais.
app.get('/api/contas', async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];
    const search = String(req.query.busca || '').trim();
    const status = String(req.query.status || '').trim();
    const categoria = String(req.query.categoria || '').trim();
    const de = String(req.query.de || '').trim();
    const ate = String(req.query.ate || '').trim();

    if (search) {
      conditions.push('(fornecedor LIKE ? OR descricao LIKE ? OR numero_documento LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status && status !== 'todos') {
      if (!STATUSES.has(status)) return res.status(400).json({ error: 'Filtro de status inválido.' });
      conditions.push('status = ?');
      params.push(status);
    }
    if (categoria && categoria !== 'todas') {
      conditions.push('categoria = ?');
      params.push(categoria);
    }
    if (de) {
      if (!isValidDate(de)) return res.status(400).json({ error: 'Data inicial inválida.' });
      conditions.push('data_vencimento >= ?');
      params.push(de);
    }
    if (ate) {
      if (!isValidDate(ate)) return res.status(400).json({ error: 'Data final inválida.' });
      conditions.push('data_vencimento <= ?');
      params.push(ate);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await all(`SELECT * FROM contas ${where} ORDER BY data_vencimento ASC, id DESC`, params);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

// Cadastra uma nova conta a pagar.
app.post('/api/contas', async (req, res, next) => {
  try {
    const { errors, value } = validateAccount(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });

    const createdAt = new Date().toISOString();
    const result = await run(
      `INSERT INTO contas (fornecedor, data_criacao, data_vencimento, valor, status, descricao, categoria, numero_documento)
       VALUES (?, ?, ?, ?, 'pendente', ?, ?, ?)`,
      [value.fornecedor, createdAt, value.data_vencimento, value.valor,
        value.descricao || null, value.categoria || 'Outros', value.numero_documento || null]
    );
    res.status(201).json(await accountById(result.lastID));
  } catch (error) {
    next(error);
  }
});

// Edita os dados da conta e/ou altera seu status.
app.put('/api/contas/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
    const current = await accountById(id);
    if (!current) return res.status(404).json({ error: 'Conta não encontrada.' });

    const { errors, value } = validateAccount(req.body || {}, true);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    if (!Object.keys(value).length) return res.status(400).json({ error: 'Nenhum dado válido foi enviado.' });

    if (value.status === 'liquidada') value.data_liquidacao = todayISO();
    if (value.status === 'pendente') value.data_liquidacao = null;

    const fields = Object.keys(value);
    const assignments = fields.map((field) => `${field} = ?`).join(', ');
    await run(`UPDATE contas SET ${assignments} WHERE id = ?`, [...fields.map((field) => value[field]), id]);
    res.json(await accountById(id));
  } catch (error) {
    next(error);
  }
});

// Remove a conta e o arquivo vinculado, se houver.
app.delete('/api/contas/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
    const current = await accountById(id);
    if (!current) return res.status(404).json({ error: 'Conta não encontrada.' });
    await run('DELETE FROM contas WHERE id = ?', [id]);
    await deleteStoredAttachment(current.anexo_arquivo).catch((cleanupError) => {
      console.warn('Não foi possível remover o arquivo da conta excluída:', cleanupError.message);
    });
    res.json({ deleted: true, id });
  } catch (error) {
    next(error);
  }
});

const allowedMimeTypes = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx']
]);

// Recebe um documento em base64. O nome físico é gerado pelo servidor.
app.post('/api/contas/:id/anexo', async (req, res, next) => {
  let newFilename;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
    const current = await accountById(id);
    if (!current) return res.status(404).json({ error: 'Conta não encontrada.' });

    const { nome, mime, dados } = req.body || {};
    const normalizedMime = String(mime || '').toLowerCase();
    const extension = allowedMimeTypes.get(normalizedMime);
    if (!extension) return res.status(400).json({ error: 'Formato não permitido. Envie PDF, JPG, PNG, WEBP, DOC, DOCX, XLS ou XLSX.' });
    if (typeof dados !== 'string' || !/^data:[^;]+;base64,[A-Za-z0-9+/]+=*$/.test(dados)) {
      return res.status(400).json({ error: 'Arquivo inválido ou vazio.' });
    }
    const dataUrlMime = dados.slice(5, dados.indexOf(';')).toLowerCase();
    if (dataUrlMime !== normalizedMime) return res.status(400).json({ error: 'O tipo do arquivo não corresponde ao conteúdo enviado.' });

    const base64 = dados.slice(dados.indexOf(',') + 1);
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'O arquivo está vazio.' });
    if (buffer.length > MAX_ATTACHMENT_BYTES) return res.status(413).json({ error: 'O arquivo ultrapassa o limite de 8 MB.' });

    newFilename = `${crypto.randomUUID()}.${extension}`;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, newFilename), buffer, { flag: 'wx' });
    const safeOriginalName = String(nome || `documento.${extension}`).replace(/\\/g, '/').split('/').pop().slice(0, 180);

    await run(
      'UPDATE contas SET anexo_nome = ?, anexo_arquivo = ?, anexo_mime = ?, anexo_tamanho = ? WHERE id = ?',
      [safeOriginalName, newFilename, normalizedMime, buffer.length, id]
    );
    await deleteStoredAttachment(current.anexo_arquivo).catch((cleanupError) => {
      console.warn('Não foi possível remover o anexo substituído:', cleanupError.message);
    });
    res.json(await accountById(id));
  } catch (error) {
    if (newFilename) await deleteStoredAttachment(newFilename).catch(() => {});
    next(error);
  }
});

// Faz download/visualização do documento associado à conta.
app.get('/api/contas/:id/anexo', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
    const account = await accountById(id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada.' });
    if (!account.anexo_arquivo) return res.status(404).json({ error: 'Esta conta não possui documento anexado.' });
    const filePath = path.join(UPLOAD_DIR, path.basename(account.anexo_arquivo));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'O arquivo anexado não foi encontrado no servidor.' });
    res.setHeader('Content-Type', account.anexo_mime || 'application/octet-stream');
    res.download(filePath, account.anexo_nome || 'documento', { headers: { 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    next(error);
  }
});

// Desvincula e apaga somente o documento, mantendo a conta.
app.delete('/api/contas/:id/anexo', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
    const account = await accountById(id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada.' });
    if (!account.anexo_arquivo) return res.status(404).json({ error: 'Esta conta não possui documento anexado.' });
    await run('UPDATE contas SET anexo_nome = NULL, anexo_arquivo = NULL, anexo_mime = NULL, anexo_tamanho = NULL WHERE id = ?', [id]);
    await deleteStoredAttachment(account.anexo_arquivo).catch((cleanupError) => {
      console.warn('Não foi possível remover o documento desvinculado:', cleanupError.message);
    });
    res.json(await accountById(id));
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint não encontrado.' }));

app.use((error, req, res, next) => {
  console.error(`[${new Date().toISOString()}]`, error);
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'JSON inválido na requisição.' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'A requisição excede o limite permitido.' });
  }
  res.status(500).json({ error: 'Erro interno do servidor. Consulte o terminal para mais detalhes.' });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log('================================================');
      console.log('  METALÚRGICA USINAGEM EUROLATINA');
      console.log(`  Sistema disponível em http://localhost:${PORT}`);
      console.log(`  Banco de dados: ${DB_FILE}`);
      console.log('================================================');
    });
  })
  .catch((error) => {
    console.error('Não foi possível inicializar o banco de dados:', error);
    process.exit(1);
  });

process.on('SIGINT', () => db.close(() => process.exit(0)));
process.on('SIGTERM', () => db.close(() => process.exit(0)));
