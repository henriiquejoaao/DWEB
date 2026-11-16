'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const root = path.join(__dirname, '..');
const configuredTestDatabase = Boolean(
  process.env.TURSO_TEST_DATABASE_URL && process.env.TURSO_TEST_AUTH_TOKEN
);

test('servidor exige Turso Cloud e não oferece backup nem fallback local', () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(source, /TURSO_DATABASE_URL/);
  assert.match(source, /TURSO_AUTH_TOKEN/);
  assert.match(source, /Turso Cloud/);
  assert.doesNotMatch(source, /require\(['"]sqlite3['"]\)/);
  assert.doesNotMatch(source, /database\.sqlite/);
  assert.doesNotMatch(source, /api\/admin\/backup|BACKUP_ENCRYPTION_KEY/);
  assert.match(source, /ACCOUNT_TYPES/);
  assert.match(source, /account\.received/);
  assert.match(source, /account\.paid/);
  assert.match(source, /authorization\.denied/);
  assert.match(source, /password_hash/);
  assert.match(source, /scrypt/);
  assert.match(source, /INSERT INTO usuarios[\s\S]+WHERE NOT EXISTS \(SELECT 1 FROM usuarios\)/);
});

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`O servidor encerrou durante a inicialização (código ${child.exitCode}).`);
    try {
      const response = await fetch(`${url}/api/health`);
      const data = await response.json();
      if (response.ok && data.status === 'ok') return;
      if (response.status >= 500) throw new Error(`Health check falhou: ${data.erro || JSON.stringify(data)}`);
    } catch (error) {
      if (error.message.startsWith('Health check falhou:')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('O servidor não iniciou dentro do período de teste.');
}

test('API autenticada: contas a pagar/receber, filtros, documentos, RBAC e auditoria', {
  skip: !configuredTestDatabase && 'Defina TURSO_TEST_DATABASE_URL e TURSO_TEST_AUTH_TOKEN para executar o teste remoto.'
}, async (t) => {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const setupToken = `test-${randomUUID()}`;
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      TURSO_DATABASE_URL: process.env.TURSO_TEST_DATABASE_URL,
      TURSO_AUTH_TOKEN: process.env.TURSO_TEST_AUTH_TOKEN,
      INITIAL_ADMIN_SETUP_TOKEN: setupToken
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let adminCookie = '';
  let activeCookie = '';
  const createdIds = [];

  async function request(route, method = 'GET', body, options = {}) {
    const headers = { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.cookie === undefined ? (activeCookie ? { Cookie: activeCookie } : {}) : (options.cookie ? { Cookie: options.cookie } : {})) };
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const cookieHeader = response.headers.get('set-cookie');
    if (cookieHeader) {
      activeCookie = cookieHeader.split(';')[0];
      if (route === '/api/auth/setup') adminCookie = activeCookie;
    }
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    return { response, data };
  }

  t.after(async () => {
    activeCookie = adminCookie;
    for (const id of createdIds) await request(`/api/contas/${id}`, 'DELETE').catch(() => {});
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 1500);
    });
  });

  await waitForServer(baseUrl, child).catch((error) => { throw new Error(`${error.message}\n${stderr}`); });
  const home = await fetch(baseUrl);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Gestão financeira/i);

  let result = await fetch(`${baseUrl}/api/contas`);
  assert.equal(result.status, 401, 'Dados financeiros não devem ser públicos');

  result = await request('/api/health');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.banco, 'Turso Cloud');
  assert.equal(result.data.persistencia, 'remota');

  result = await request('/api/auth/setup', 'POST', {
    setupToken, nome: 'Admin de teste', email: `admin-${randomUUID()}@teste.invalid`, password: 'SenhaForteTeste!2026'
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.user.role, 'admin');

  const payableName = `Fornecedor teste ${randomUUID()}`;
  result = await request('/api/contas', 'POST', {
    tipo: 'pagar', fornecedor: payableName, data_vencimento: '2026-12-10', valor: 1850.5,
    categoria: 'Matéria-prima', numero_documento: 'NF TESTE', descricao: 'Barras para usinagem CNC'
  });
  assert.equal(result.response.status, 201);
  const payableId = result.data.id;
  createdIds.push(payableId);
  assert.equal(result.data.tipo, 'pagar');
  assert.equal(result.data.status, 'pendente');

  const customerName = `Cliente teste ${randomUUID()}`;
  result = await request('/api/contas', 'POST', {
    tipo: 'receber', fornecedor: customerName, data_vencimento: '2026-12-12', valor: 4200.75,
    categoria: 'Serviços de usinagem', numero_documento: 'NF RECEBER', descricao: 'Serviço de torneamento CNC'
  });
  assert.equal(result.response.status, 201);
  const receivableId = result.data.id;
  createdIds.push(receivableId);
  assert.equal(result.data.tipo, 'receber');

  result = await request(`/api/contas?tipo=receber&busca=${encodeURIComponent(customerName)}`);
  assert.equal(result.response.status, 200);
  assert.ok(result.data.some((account) => account.id === receivableId));
  assert.ok(!result.data.some((account) => account.id === payableId));

  result = await request(`/api/contas/${payableId}`, 'PUT', {
    fornecedor: `${payableName} Editado`, data_vencimento: '2026-12-11', valor: 2000,
    categoria: 'Ferramentas e insumos', descricao: 'Conta editada'
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.valor, 2000);
  assert.equal(result.data.tipo, 'pagar');

  result = await request(`/api/contas/${payableId}/anexo`, 'POST', {
    nome: 'fatura.pdf', mime: 'application/pdf', dados: 'data:application/pdf;base64,JVBERi0xLjQKJUVPRg=='
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.anexo_nome, 'fatura.pdf');

  const download = await fetch(`${baseUrl}/api/contas/${payableId}/anexo`, { headers: { Cookie: adminCookie } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /application\/pdf/);
  assert.ok((await download.arrayBuffer()).byteLength > 0);

  result = await request(`/api/contas/${payableId}/anexo`, 'DELETE');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.anexo_arquivo, null);

  result = await request(`/api/contas/${payableId}`, 'PUT', { status: 'liquidada' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, 'liquidada');
  assert.match(result.data.data_liquidacao, /^\d{4}-\d{2}-\d{2}$/);

  result = await request(`/api/contas/${receivableId}`, 'PUT', { status: 'liquidada' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.tipo, 'receber');
  assert.equal(result.data.status, 'liquidada');

  result = await request('/api/admin/users', 'POST', {
    nome: 'Usuário consulta', email: `consulta-${randomUUID()}@teste.invalid`,
    password: 'SenhaConsultaForte!2026', role: 'consulta'
  });
  assert.equal(result.response.status, 201);
  const consultaEmail = result.data.email;
  result = await request('/api/auth/login', 'POST', { email: consultaEmail, password: 'SenhaConsultaForte!2026' });
  assert.equal(result.response.status, 200);
  const consultaCookie = activeCookie;
  result = await request('/api/contas', 'GET', undefined, { cookie: consultaCookie });
  assert.equal(result.response.status, 200, 'Perfil consulta pode listar contas');
  result = await request(`/api/contas/${payableId}/anexo`, 'GET', undefined, { cookie: consultaCookie });
  assert.equal(result.response.status, 403, 'Perfil consulta não pode acessar documentos');
  result = await request('/api/contas', 'POST', { tipo: 'receber', fornecedor: 'Sem permissão', data_vencimento: '2026-12-20', valor: 10 }, { cookie: consultaCookie });
  assert.equal(result.response.status, 403, 'Perfil consulta não pode cadastrar contas');

  activeCookie = adminCookie;
  result = await request('/api/admin/audit?limit=200');
  assert.equal(result.response.status, 200);
  assert.ok(result.data.some((event) => event.action === 'account.received'));
  assert.ok(result.data.some((event) => event.action === 'document.downloaded'));
});
