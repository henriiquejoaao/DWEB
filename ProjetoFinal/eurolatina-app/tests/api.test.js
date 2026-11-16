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

test('servidor exige Turso Cloud e não mantém fallback local', () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(source, /TURSO_DATABASE_URL/);
  assert.match(source, /TURSO_AUTH_TOKEN/);
  assert.match(source, /Turso Cloud/);
  assert.doesNotMatch(source, /require\(['"]sqlite3['"]\)/);
  assert.doesNotMatch(source, /database\.sqlite/);
  assert.doesNotMatch(source, /UPLOAD_DIR|DB_FILE/);
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

test('API CRUD, status, filtros e anexos em uma base Turso exclusiva de testes', {
  skip: !configuredTestDatabase && 'Defina TURSO_TEST_DATABASE_URL e TURSO_TEST_AUTH_TOKEN para executar o teste remoto.'
}, async (t) => {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      TURSO_DATABASE_URL: process.env.TURSO_TEST_DATABASE_URL,
      TURSO_AUTH_TOKEN: process.env.TURSO_TEST_AUTH_TOKEN
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let createdId = null;

  async function request(route, method = 'GET', body) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    return { response, data };
  }

  t.after(async () => {
    if (createdId) await request(`/api/contas/${createdId}`, 'DELETE').catch(() => {});
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
  assert.match(await home.text(), /Contas a pagar/i);

  let result = await request('/api/health');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.banco, 'Turso Cloud');
  assert.equal(result.data.persistencia, 'remota');

  const supplier = `Teste automatizado ${randomUUID()}`;
  result = await request('/api/contas', 'POST', {
    fornecedor: supplier, data_vencimento: '2026-12-10', valor: 1850.5,
    categoria: 'Matéria-prima', numero_documento: 'NF TESTE', descricao: 'Barras para usinagem CNC'
  });
  assert.equal(result.response.status, 201);
  createdId = result.data.id;
  assert.ok(createdId);
  assert.equal(result.data.status, 'pendente');

  result = await request(`/api/contas/${createdId}`, 'PUT', {
    fornecedor: `${supplier} Editado`, data_vencimento: '2026-12-11', valor: 2000,
    categoria: 'Ferramentas e insumos', descricao: 'Conta editada'
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.valor, 2000);

  result = await request(`/api/contas/${createdId}/anexo`, 'POST', {
    nome: 'fatura.pdf', mime: 'application/pdf', dados: 'data:application/pdf;base64,JVBERi0xLjQKJUVPRg=='
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.anexo_nome, 'fatura.pdf');

  const download = await fetch(`${baseUrl}/api/contas/${createdId}/anexo`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /application\/pdf/);
  assert.ok((await download.arrayBuffer()).byteLength > 0);

  result = await request(`/api/contas/${createdId}/anexo`, 'DELETE');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.anexo_arquivo, null);

  result = await request(`/api/contas/${createdId}`, 'PUT', { status: 'liquidada' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, 'liquidada');
  assert.match(result.data.data_liquidacao, /^\d{4}-\d{2}-\d{2}$/);

  result = await request(`/api/contas/${createdId}`, 'PUT', { status: 'pendente' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, 'pendente');
  assert.equal(result.data.data_liquidacao, null);

  result = await request(`/api/contas?busca=${encodeURIComponent(supplier)}&status=pendente`);
  assert.equal(result.response.status, 200);
  assert.ok(result.data.some((account) => account.id === createdId));
});
