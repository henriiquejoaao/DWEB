'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const express = require('express');
const crypto = require('crypto');
const { promisify } = require('node:util');
const { gzipSync, gunzipSync } = require('node:zlib');
const { createClient } = require('@libsql/client');
const helmet = require('helmet');
const normalizeTursoRow = require('./lib/normalize-turso-row');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// O navegador envia o arquivo em base64; 3 MB mantém a requisição abaixo do limite
// de payload atualmente aplicado às Vercel Functions.
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const STATUSES = new Set(['pendente', 'liquidada']);
const ACCOUNT_TYPES = new Set(['pagar', 'receber']);
const ROLES = new Set(['admin', 'financeiro', 'consulta']);
const ROLE_LABELS = { admin: 'Administrador', financeiro: 'Financeiro', consulta: 'Consulta' };
const SESSION_COOKIE = 'eurolatina_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SCRYPT_N = 1 << 17;
const scryptAsync = promisify(crypto.scrypt);

const missingDatabaseVariables = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']
  .filter((name) => !String(process.env[name] || '').trim());

let turso = null;
let databaseInitError = null;

if (missingDatabaseVariables.length === 0) {
  try {
    turso = createClient({
      url: process.env.TURSO_DATABASE_URL.trim(),
      authToken: process.env.TURSO_AUTH_TOKEN.trim()
    });
  } catch (error) {
    databaseInitError = new Error(`Não foi possível inicializar o cliente Turso: ${error.message}`);
  }
} else {
  databaseInitError = new Error(
    `Banco de dados em nuvem não configurado. Faltam: ${missingDatabaseVariables.join(' e ')}. ` +
    'Conecte um banco Turso ao projeto Vercel (Storage/Marketplace), confira as variáveis no ambiente Production e faça um novo deploy. ' +
    'Esta versão não usa SQLite local nem armazenamento temporário.'
  );
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://cdnjs.cloudflare.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      formAction: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '16mb' }));
app.use(express.static(PUBLIC_DIR));

function run(sql, params = []) {
  if (!turso) return Promise.reject(databaseInitError || new Error('Cliente Turso indisponível.'));
  return turso.execute({ sql, args: params }).then((result) => ({
    lastID: Number(result.lastInsertRowid || 0),
    changes: Number(result.rowsAffected || 0)
  }));
}

function get(sql, params = []) {
  if (!turso) return Promise.reject(databaseInitError || new Error('Cliente Turso indisponível.'));
  return turso.execute({ sql, args: params }).then((result) =>
    result.rows.length ? normalizeTursoRow(result.rows[0], result.columns) : undefined
  );
}

function all(sql, params = []) {
  if (!turso) return Promise.reject(databaseInitError || new Error('Cliente Turso indisponível.'));
  return turso.execute({ sql, args: params }).then((result) =>
    result.rows.map((row) => normalizeTursoRow(row, result.columns))
  );
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

  if (!partial || Object.hasOwn(input, 'tipo')) {
    const type = String(input.tipo || (partial ? '' : 'pagar')).trim().toLowerCase();
    if (!ACCOUNT_TYPES.has(type)) errors.push('Tipo de conta inválido. Escolha a pagar ou a receber.');
    else result.tipo = type;
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

const ACCOUNT_COLUMNS = 'id, tipo, fornecedor, data_criacao, data_vencimento, data_liquidacao, valor, status, descricao, categoria, numero_documento, anexo_nome, anexo_arquivo, anexo_mime, anexo_tamanho';

function accountById(id) {
  return get(`SELECT ${ACCOUNT_COLUMNS} FROM contas WHERE id = ?`, [id]);
}

async function initializeDatabase() {
  await run(`CREATE TABLE IF NOT EXISTS contas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL DEFAULT 'pagar' CHECK (tipo IN ('pagar', 'receber')),
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
    anexo_tamanho INTEGER,
    anexo_conteudo BLOB
  )`);

  // Migração incremental para manter a estrutura de versões anteriores no banco remoto.
  const columns = await all('PRAGMA table_info(contas)');
  const existing = new Set(columns.map((column) => column.name));
  const additions = [
    ['tipo', "TEXT NOT NULL DEFAULT 'pagar'"],
    ['data_criacao', 'TEXT'],
    ['data_liquidacao', 'TEXT'],
    ['descricao', 'TEXT'],
    ['categoria', "TEXT DEFAULT 'Outros'"],
    ['numero_documento', 'TEXT'],
    ['anexo_nome', 'TEXT'],
    ['anexo_arquivo', 'TEXT'],
    ['anexo_mime', 'TEXT'],
    ['anexo_tamanho', 'INTEGER'],
    ['anexo_conteudo', 'BLOB']
  ];

  for (const [name, type] of additions) {
    if (!existing.has(name)) await run(`ALTER TABLE contas ADD COLUMN ${name} ${type}`);
  }

  await run("UPDATE contas SET data_criacao = COALESCE(data_criacao, datetime('now', 'localtime'))");
  await run("UPDATE contas SET categoria = COALESCE(NULLIF(categoria, ''), 'Outros')");
  await run("UPDATE contas SET tipo = 'pagar' WHERE tipo IS NULL OR tipo NOT IN ('pagar', 'receber')");
  await run('CREATE INDEX IF NOT EXISTS idx_contas_tipo ON contas(tipo)');
  await run('CREATE INDEX IF NOT EXISTS idx_contas_vencimento ON contas(data_vencimento)');
  await run('CREATE INDEX IF NOT EXISTS idx_contas_status ON contas(status)');

  await run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    nome TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'financeiro', 'consulta')),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS sessoes (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES usuarios(id)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER,
    actor_email TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    metadata TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS auth_rate_limits (
    rate_key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    window_started_at TEXT NOT NULL,
    blocked_until TEXT
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_sessoes_user_id ON sessoes(user_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_sessoes_expires_at ON sessoes(expires_at)');
  await run('CREATE INDEX IF NOT EXISTS idx_auditoria_created_at ON auditoria(created_at)');
  await run('CREATE INDEX IF NOT EXISTS idx_auditoria_actor ON auditoria(actor_user_id)');
  // Limpa sessões expiradas no início de cada instância serverless.
  await run('DELETE FROM sessoes WHERE expires_at <= ?', [new Date().toISOString()]);
}

let databaseReadyPromise = null;

function databaseErrorCode(error) {
  return error?.code || error?.cause?.code || error?.cause?.cause?.code || null;
}

function isRetryableDatabaseError(error) {
  const code = String(databaseErrorCode(error) || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return [
    'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH',
    'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'
  ].includes(code) || message.includes('fetch failed') || message.includes('network error');
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function initializeDatabaseWithRetry() {
  const delays = [300, 900, 1800];
  let lastError;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      // O SELECT valida rede/autenticação antes de executar as migrações idempotentes.
      await turso.execute('SELECT 1 AS conectado');
      await initializeDatabase();
      await turso.execute('SELECT 1 AS conectado');
      databaseInitError = null;
      return;
    } catch (error) {
      lastError = error;
      const retry = attempt < delays.length && isRetryableDatabaseError(error);
      console.error(
        `Falha na conexão/inicialização do Turso (tentativa ${attempt + 1}/${delays.length + 1}):`,
        databaseErrorCode(error) || error.message
      );
      if (!retry) break;
      await wait(delays[attempt]);
    }
  }

  throw lastError;
}

// Inicialização preguiçosa com retentativas. Se uma tentativa esgotar, a promessa
// é descartada para que a próxima requisição possa tentar novamente (evita erro preso
// na instância serverless após um timeout transitório).
async function ensureDatabaseReady() {
  if (!turso) {
    throw databaseInitError || new Error('Cliente Turso indisponível.');
  }

  if (!databaseReadyPromise) {
    databaseReadyPromise = initializeDatabaseWithRetry().catch((error) => {
      databaseInitError = error;
      databaseReadyPromise = null;
      throw error;
    });
  }

  await databaseReadyPromise;
}

// O status diferencia credenciais presentes de conexão realmente estabelecida.
// Nenhum token, URL completa ou informação secreta é devolvido ao navegador.
app.get('/api/health', async (req, res) => {
  const configured = missingDatabaseVariables.length === 0;
  try {
    await ensureDatabaseReady();
    return res.json({
      status: 'ok',
      aplicacao: 'EUROLATINA - Gestão Financeira',
      banco: 'Turso Cloud',
      configurado: true,
      conectado: true,
      persistencia: 'remota'
    });
  } catch (error) {
    return res.status(503).json({
      status: 'error',
      banco: 'Turso Cloud',
      configurado: configured,
      conectado: false,
      etapa: configured ? 'conexao_ou_inicializacao' : 'configuracao',
      codigo: databaseErrorCode(error),
      erro: error.message || 'Falha desconhecida ao conectar ao banco remoto.'
    });
  }
});

// Todas as rotas da API dependem do banco remoto e respeitam origem same-site.
app.use('/api', async (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    await ensureDatabaseReady();
    return next();
  } catch (error) {
    return res.status(503).json({
      error: 'Não foi possível conectar ao banco de dados remoto.',
      banco: 'Turso Cloud',
      configurado: missingDatabaseVariables.length === 0,
      codigo: databaseErrorCode(error)
    });
  }
});

function safeUser(user) {
  if (!user) return null;
  return { id: Number(user.id), email: user.email, nome: user.nome, role: user.role, role_label: ROLE_LABELS[user.role] || user.role };
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return decodeURIComponent(item.slice(separator + 1).trim());
  }
  return null;
}

function cookieOptions() {
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : ''}`;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions()}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : ''}`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, 64, { N: SCRYPT_N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$8$1$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

async function verifyPassword(password, encoded) {
  try {
    const [algorithm, nText, rText, pText, saltText, hashText] = String(encoded || '').split('$');
    if (algorithm !== 'scrypt') return false;
    const N = Number(nText), r = Number(rText), p = Number(pText);
    if (![N, r, p].every(Number.isInteger) || N < 16384 || N > (1 << 18) || r < 1 || p < 1) return false;
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    if (salt.length < 16 || expected.length !== 64) return false;
    const actual = Buffer.from(await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 }));
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function passwordsAreValid(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128;
}

async function writeAudit(req, action, targetType = null, targetId = null, metadata = {}) {
  await run(
    `INSERT INTO auditoria (actor_user_id, actor_email, action, target_type, target_id, metadata, ip_address, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user?.id ?? null, req.user?.email ?? null, action, targetType, targetId == null ? null : String(targetId),
      JSON.stringify(metadata || {}), String(req.ip || '').slice(0, 64), String(req.get('user-agent') || '').slice(0, 255), new Date().toISOString()]
  );
}

function serializeAccountForUser(account, user) {
  if (!account) return account;
  const result = { ...account };
  if (!['admin', 'financeiro'].includes(user?.role)) {
    delete result.anexo_nome;
    delete result.anexo_arquivo;
    delete result.anexo_mime;
    delete result.anexo_tamanho;
  }
  return result;
}

function requireRole(...roles) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Faça login para continuar.' });
    if (!roles.includes(req.user.role)) {
      // Tentativas de acesso negado a recursos restritos também ficam auditadas.
      try {
        const isDocument = req.path.endsWith('/anexo');
        await writeAudit(req, 'authorization.denied', isDocument ? 'document' : 'api', req.params?.id || null, {
          method: req.method,
          path: req.path,
          role: req.user.role
        });
      } catch (auditError) {
        console.error('Não foi possível registrar tentativa de acesso negado:', auditError);
      }
      return res.status(403).json({ error: 'Seu perfil não tem permissão para esta operação.' });
    }
    return next();
  };
}

// SameSite=Strict é a primeira barreira contra CSRF; a validação de Origin complementa a proteção.
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const expectedHost = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim().toLowerCase();
    if (originHost !== expectedHost) return res.status(403).json({ error: 'Origem da requisição não autorizada.' });
    return next();
  } catch {
    return res.status(403).json({ error: 'Origem da requisição inválida.' });
  }
});

app.use('/api', async (req, res, next) => {
  try {
    const token = getCookie(req, SESSION_COOKIE);
    if (!token || token.length < 40 || token.length > 200) return next();
    const tokenHash = sha256(token);
    const session = await get(
      `SELECT u.id, u.email, u.nome, u.role, u.active, s.expires_at
       FROM sessoes s JOIN usuarios u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`, [tokenHash, new Date().toISOString()]
    );
    if (session && Number(session.active) === 1) {
      req.user = safeUser(session);
      req.sessionTokenHash = tokenHash;
    } else {
      await run('DELETE FROM sessoes WHERE token_hash = ?', [tokenHash]);
    }
    return next();
  } catch (error) {
    return next(error);
  }
});

app.get('/api/auth/status', async (req, res, next) => {
  try {
    const count = await get('SELECT COUNT(*) AS total FROM usuarios');
    const totalUsuarios = Number(count?.total ?? 0);
    if (!Number.isSafeInteger(totalUsuarios) || totalUsuarios < 0) {
      throw new Error('Resultado inválido ao consultar a quantidade de usuários no Turso.');
    }
    const setupRequired = totalUsuarios === 0;
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({
      setupRequired,
      setupEnabled: Boolean(String(process.env.INITIAL_ADMIN_SETUP_TOKEN || '').trim()),
      authenticated: Boolean(req.user),
      user: safeUser(req.user),
      // Contagem sem dados pessoais: permite diagnosticar a inicialização sem expor usuários.
      totalUsuarios
    });
  } catch (error) { return next(error); }
});

app.post('/api/auth/setup', async (req, res, next) => {
  try {
    const setupRateKey = `initial-setup|${String(req.ip || 'unknown')}`;
    const rateRecord = await get('SELECT blocked_until FROM auth_rate_limits WHERE rate_key = ?', [sha256(setupRateKey)]);
    if (rateRecord?.blocked_until && new Date(rateRecord.blocked_until).getTime() > Date.now()) {
      return res.status(429).json({ error: 'Muitas tentativas de configuração. Aguarde 15 minutos.' });
    }
    const configuredToken = String(process.env.INITIAL_ADMIN_SETUP_TOKEN || '');
    const suppliedToken = String(req.body?.setupToken || '');
    const tokenBuffer = Buffer.from(configuredToken);
    const suppliedBuffer = Buffer.from(suppliedToken);
    const tokenMatches = tokenBuffer.length > 0 && tokenBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(tokenBuffer, suppliedBuffer);
    if (!tokenMatches) {
      const limit = await updateLoginLimit(setupRateKey, true);
      await writeAudit(req, 'auth.initial_setup_failed', 'auth', null, { blocked: limit.blocked });
      return res.status(limit.blocked ? 429 : 403).json({ error: limit.blocked ? 'Muitas tentativas de configuração. Aguarde 15 minutos.' : 'Token inicial inválido ou não configurado no Vercel.' });
    }
    await updateLoginLimit(setupRateKey, false);
    const count = await get('SELECT COUNT(*) AS total FROM usuarios');
    if (Number(count?.total || 0) > 0) return res.status(409).json({ error: 'A configuração inicial já foi concluída. Entre com seu usuário.' });

    const nome = String(req.body?.nome || '').trim().slice(0, 100);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;
    if (!nome || nome.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180 || !passwordsAreValid(password)) {
      return res.status(400).json({ error: 'Informe nome, e-mail válido e senha com pelo menos 12 caracteres (máximo 128).' });
    }
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();
    // A verificação e a inserção acontecem em uma única instrução para impedir
    // que duas solicitações simultâneas criem dois administradores iniciais.
    const created = await run(
      `INSERT INTO usuarios (email, nome, role, password_hash, active, created_at, updated_at)
       SELECT ?, ?, 'admin', ?, 1, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM usuarios)`, [email, nome, passwordHash, now, now]
    );
    if (created.changes !== 1) {
      return res.status(409).json({ error: 'A configuração inicial já foi concluída. Entre com seu usuário.' });
    }
    const user = await get('SELECT id, email, nome, role FROM usuarios WHERE email = ?', [email]);
    if (!user) throw new Error('Não foi possível localizar o administrador inicial recém-criado.');
    req.user = safeUser(user);
    await writeAudit(req, 'auth.initial_admin_created', 'usuario', user.id, { email });
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await run('INSERT INTO sessoes (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [sha256(token), user.id, expiresAt, now]);
    setSessionCookie(res, token);
    return res.status(201).json({ user: safeUser(user), setupComplete: true });
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    return next(error);
  }
});

async function updateLoginLimit(rateKey, failed) {
  const now = new Date();
  const key = sha256(rateKey);
  const current = await get('SELECT attempts, window_started_at, blocked_until FROM auth_rate_limits WHERE rate_key = ?', [key]);
  if (!failed) {
    await run('DELETE FROM auth_rate_limits WHERE rate_key = ?', [key]);
    return { blocked: false };
  }
  const windowStart = current && now.getTime() - new Date(current.window_started_at).getTime() < 15 * 60 * 1000
    ? current.window_started_at : now.toISOString();
  const attempts = (windowStart === current?.window_started_at ? Number(current.attempts) : 0) + 1;
  const blockedUntil = attempts >= 5 ? new Date(now.getTime() + 15 * 60 * 1000).toISOString() : null;
  await run(
    `INSERT INTO auth_rate_limits (rate_key, attempts, window_started_at, blocked_until) VALUES (?, ?, ?, ?)
     ON CONFLICT(rate_key) DO UPDATE SET attempts = excluded.attempts, window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until`,
    [key, attempts, windowStart, blockedUntil]
  );
  return { blocked: Boolean(blockedUntil), blockedUntil };
}

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const ip = String(req.ip || 'unknown');
    const rateKey = `${email}|${ip}`;
    const rateRecord = await get('SELECT blocked_until FROM auth_rate_limits WHERE rate_key = ?', [sha256(rateKey)]);
    if (rateRecord?.blocked_until && new Date(rateRecord.blocked_until).getTime() > Date.now()) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.' });
    }
    const user = email ? await get('SELECT id, email, nome, role, active, password_hash FROM usuarios WHERE email = ?', [email]) : null;
    const valid = Boolean(user && Number(user.active) === 1 && await verifyPassword(password, user.password_hash));
    if (!valid) {
      const limit = await updateLoginLimit(rateKey, true);
      await writeAudit(req, 'auth.login_failed', 'auth', null, { email: email.slice(0, 180), blocked: limit.blocked });
      return res.status(limit.blocked ? 429 : 401).json({ error: limit.blocked ? 'Muitas tentativas. Conta temporariamente bloqueada por 15 minutos.' : 'E-mail ou senha inválidos.' });
    }
    await updateLoginLimit(rateKey, false);
    await run('DELETE FROM sessoes WHERE expires_at <= ?', [new Date().toISOString()]);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await run('INSERT INTO sessoes (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [sha256(token), user.id, expiresAt, now]);
    await run('UPDATE usuarios SET last_login_at = ?, updated_at = ? WHERE id = ?', [now, now, user.id]);
    req.user = safeUser(user);
    await writeAudit(req, 'auth.login_success', 'usuario', user.id);
    setSessionCookie(res, token);
    return res.json({ user: safeUser(user), expiresAt });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    if (req.sessionTokenHash) {
      await writeAudit(req, 'auth.logout', 'usuario', req.user.id);
      await run('DELETE FROM sessoes WHERE token_hash = ?', [req.sessionTokenHash]);
    }
    clearSessionCookie(res);
    return res.json({ loggedOut: true });
  } catch (error) { return next(error); }
});

app.get('/api/auth/me', (req, res) => req.user
  ? res.json({ user: safeUser(req.user) })
  : res.status(401).json({ error: 'Não autenticado.' }));

// Nenhum dado financeiro ou documento é acessível sem uma sessão válida.
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (!req.user) return res.status(401).json({ error: 'Faça login para continuar.' });
  return next();
});

// Lista as contas e aceita filtros opcionais.
app.get('/api/contas', requireRole('admin', 'financeiro', 'consulta'), async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];
    const search = String(req.query.busca || '').trim();
    const status = String(req.query.status || '').trim();
    const categoria = String(req.query.categoria || '').trim();
    const tipo = String(req.query.tipo || '').trim();
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
    if (tipo && tipo !== 'todos') {
      if (!ACCOUNT_TYPES.has(tipo)) return res.status(400).json({ error: 'Filtro de tipo inválido.' });
      conditions.push('tipo = ?');
      params.push(tipo);
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
    const rows = await all(`SELECT ${ACCOUNT_COLUMNS} FROM contas ${where} ORDER BY data_vencimento ASC, id DESC`, params);
    res.json(rows.map((row) => serializeAccountForUser(row, req.user)));
  } catch (error) {
    next(error);
  }
});

// Cadastra uma conta a pagar ou a receber.
app.post('/api/contas', requireRole('admin', 'financeiro'), async (req, res, next) => {
  try {
    const { errors, value } = validateAccount(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });

    const createdAt = new Date().toISOString();
    const result = await run(
      `INSERT INTO contas (tipo, fornecedor, data_criacao, data_vencimento, valor, status, descricao, categoria, numero_documento)
       VALUES (?, ?, ?, ?, ?, 'pendente', ?, ?, ?)`,
      [value.tipo || 'pagar', value.fornecedor, createdAt, value.data_vencimento, value.valor,
        value.descricao || null, value.categoria || 'Outros', value.numero_documento || null]
    );
    const createdAccount = await accountById(result.lastID);
    await writeAudit(req, 'account.created', 'conta', result.lastID, { tipo: value.tipo || 'pagar', contraparte: value.fornecedor, valor: value.valor, data_vencimento: value.data_vencimento });
    res.status(201).json(serializeAccountForUser(createdAccount, req.user));
  } catch (error) {
    next(error);
  }
});

// Edita os dados da conta e/ou altera seu status.
app.put('/api/contas/:id', requireRole('admin', 'financeiro'), async (req, res, next) => {
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
    const updatedType = value.tipo || current.tipo || 'pagar';
    let auditAction = 'account.updated';
    if (value.status === 'liquidada') auditAction = updatedType === 'receber' ? 'account.received' : 'account.paid';
    else if (value.status === 'pendente') auditAction = 'account.reopened';
    await writeAudit(req, auditAction, 'conta', id, {
      fields,
      tipo_anterior: current.tipo || 'pagar',
      tipo_atual: updatedType
    });
    res.json(serializeAccountForUser(await accountById(id), req.user));
  } catch (error) {
    next(error);
  }
});

// Remove a conta e seu documento (ambos persistidos no banco remoto).
app.delete('/api/contas/:id', requireRole('admin', 'financeiro'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
    const current = await accountById(id);
    if (!current) return res.status(404).json({ error: 'Conta não encontrada.' });
    await run('DELETE FROM contas WHERE id = ?', [id]);
    await writeAudit(req, 'account.deleted', 'conta', id, { tipo: current.tipo || 'pagar', contraparte: current.fornecedor, valor: current.valor });
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

// Recebe o documento e salva o conteúdo binário diretamente no Turso Cloud.
app.post('/api/contas/:id/anexo', requireRole('admin', 'financeiro'), async (req, res, next) => {
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
    if (buffer.length > MAX_ATTACHMENT_BYTES) return res.status(413).json({ error: 'O arquivo ultrapassa o limite de 3 MB.' });

    const remoteFileId = `${crypto.randomUUID()}.${extension}`;
    const safeOriginalName = String(nome || `documento.${extension}`).replace(/\\/g, '/').split('/').pop().slice(0, 180);

    await run(
      'UPDATE contas SET anexo_nome = ?, anexo_arquivo = ?, anexo_mime = ?, anexo_tamanho = ?, anexo_conteudo = ? WHERE id = ?',
      [safeOriginalName, remoteFileId, normalizedMime, buffer.length, buffer, id]
    );
    await writeAudit(req, 'document.uploaded', 'conta', id, { nome: safeOriginalName, mime: normalizedMime, tamanho: buffer.length });
    res.json(serializeAccountForUser(await accountById(id), req.user));
  } catch (error) {
    next(error);
  }
});

// Faz download/visualização do documento diretamente do BLOB no Turso Cloud.
app.get('/api/contas/:id/anexo', requireRole('admin', 'financeiro'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
    const account = await get(
      'SELECT anexo_nome, anexo_arquivo, anexo_mime, anexo_conteudo FROM contas WHERE id = ?', [id]
    );
    if (!account) return res.status(404).json({ error: 'Conta não encontrada.' });
    if (!account.anexo_arquivo || !account.anexo_conteudo) {
      return res.status(404).json({ error: 'Esta conta não possui documento armazenado no Turso Cloud.' });
    }
    await writeAudit(req, 'document.downloaded', 'conta', id, { nome: account.anexo_nome || null, mime: account.anexo_mime || null });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', account.anexo_mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.attachment(account.anexo_nome || 'documento');
    return res.send(Buffer.from(account.anexo_conteudo));
  } catch (error) {
    next(error);
  }
});

// Desvincula e apaga o documento no mesmo banco remoto.
app.delete('/api/contas/:id/anexo', requireRole('admin', 'financeiro'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
    const account = await accountById(id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada.' });
    if (!account.anexo_arquivo) return res.status(404).json({ error: 'Esta conta não possui documento anexado.' });
    await run('UPDATE contas SET anexo_nome = NULL, anexo_arquivo = NULL, anexo_mime = NULL, anexo_tamanho = NULL, anexo_conteudo = NULL WHERE id = ?', [id]);
    await writeAudit(req, 'document.deleted', 'conta', id, { nome: account.anexo_nome || null });
    res.json(serializeAccountForUser(await accountById(id), req.user));
  } catch (error) {
    next(error);
  }
});

// Administração: somente o perfil admin pode gerenciar usuários e consultar a auditoria.
app.get('/api/admin/users', requireRole('admin'), async (req, res, next) => {
  try {
    const users = await all(`SELECT id, email, nome, role, active, created_at, updated_at, last_login_at
                             FROM usuarios ORDER BY nome COLLATE NOCASE ASC`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(users.map((user) => ({ ...user, active: Number(user.active) === 1 })));
  } catch (error) { next(error); }
});

app.post('/api/admin/users', requireRole('admin'), async (req, res, next) => {
  try {
    const nome = String(req.body?.nome || '').trim().slice(0, 100);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = String(req.body?.role || 'consulta');
    const password = req.body?.password;
    if (nome.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180 || !ROLES.has(role) || !passwordsAreValid(password)) {
      return res.status(400).json({ error: 'Informe nome, e-mail válido, perfil e senha com pelo menos 12 caracteres.' });
    }
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);
    const result = await run(
      'INSERT INTO usuarios (email, nome, role, password_hash, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [email, nome, role, passwordHash, now, now]
    );
    await writeAudit(req, 'user.created', 'usuario', result.lastID, { email, role });
    res.status(201).json({ id: result.lastID, email, nome, role, active: true });
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'Já existe um usuário com esse e-mail.' });
    next(error);
  }
});

app.patch('/api/admin/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
    const current = await get('SELECT id, email, nome, role, active FROM usuarios WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const nome = req.body?.nome === undefined ? current.nome : String(req.body.nome).trim().slice(0, 100);
    const role = req.body?.role === undefined ? current.role : String(req.body.role);
    const active = req.body?.active === undefined
      ? Number(current.active)
      : (req.body.active === true ? 1 : req.body.active === false ? 0 : -1);
    if (nome.length < 2 || !ROLES.has(role) || ![0, 1].includes(active)) return res.status(400).json({ error: 'Nome, perfil ou estado inválido.' });
    if (id === req.user.id && active === 0) return res.status(400).json({ error: 'Você não pode desativar seu próprio usuário.' });
    if (current.role === 'admin' && Number(current.active) === 1 && (role !== 'admin' || active === 0)) {
      const others = await get("SELECT COUNT(*) AS total FROM usuarios WHERE role = 'admin' AND active = 1 AND id <> ?", [id]);
      if (Number(others?.total || 0) === 0) return res.status(409).json({ error: 'O sistema precisa manter ao menos um administrador ativo.' });
    }
    const now = new Date().toISOString();
    await run('UPDATE usuarios SET nome = ?, role = ?, active = ?, updated_at = ? WHERE id = ?', [nome, role, active, now, id]);
    if (active === 0) await run('DELETE FROM sessoes WHERE user_id = ?', [id]);
    await writeAudit(req, 'user.updated', 'usuario', id, { role_anterior: current.role, role_novo: role, active_anterior: Number(current.active), active_novo: active });
    res.json({ id, email: current.email, nome, role, active: Boolean(active) });
  } catch (error) { next(error); }
});

app.post('/api/admin/users/:id/reset-password', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const password = req.body?.password;
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
    if (!passwordsAreValid(password)) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 12 caracteres (máximo 128).' });
    const target = await get('SELECT id, email FROM usuarios WHERE id = ?', [id]);
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const passwordHash = await hashPassword(password);
    await run('UPDATE usuarios SET password_hash = ?, updated_at = ? WHERE id = ?', [passwordHash, new Date().toISOString(), id]);
    await run('DELETE FROM sessoes WHERE user_id = ?', [id]);
    await writeAudit(req, 'user.password_reset', 'usuario', id, { email: target.email, sessions_revoked: true });
    res.json({ updated: true, sessionsRevoked: true });
  } catch (error) { next(error); }
});

app.get('/api/admin/audit', requireRole('admin'), async (req, res, next) => {
  try {
    const requested = Number(req.query.limit || 100);
    const limit = Number.isInteger(requested) ? Math.min(200, Math.max(1, requested)) : 100;
    const events = await all(
      `SELECT id, actor_user_id, actor_email, action, target_type, target_id, metadata, ip_address, user_agent, created_at
       FROM auditoria ORDER BY id DESC LIMIT ?`, [limit]
    );
    await writeAudit(req, 'audit.viewed', 'auditoria', null, { returned: events.length });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(events.map((event) => ({ ...event, metadata: (() => { try { return JSON.parse(event.metadata || '{}'); } catch { return {}; } })() })));
  } catch (error) { next(error); }
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
  res.status(500).json({ error: 'Erro interno do servidor. Consulte os Runtime Logs do Vercel para detalhes.' });
});

// A aplicação Express é exportada para o Vercel. O listen() é usado apenas no modo local,
// mas também exige as credenciais do mesmo banco Turso: não existe fallback para SQLite.
if (require.main === module) {
  ensureDatabaseReady().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log('================================================');
      console.log('  METALÚRGICA USINAGEM EUROLATINA');
      console.log(`  Sistema disponível em http://localhost:${PORT}`);
      console.log('  Banco de dados: Turso Cloud (remoto)');
      console.log('================================================');
    });
  }).catch((error) => {
    console.error('Não foi possível conectar ao banco obrigatório Turso Cloud:', error.message);
    process.exitCode = 1;
  });

  process.on('SIGINT', () => turso?.close().finally(() => process.exit(0)));
  process.on('SIGTERM', () => turso?.close().finally(() => process.exit(0)));
}

module.exports = app;
