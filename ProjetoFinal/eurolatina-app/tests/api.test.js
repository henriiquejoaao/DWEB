'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

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
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`O servidor encerrou durante a inicialização (código ${child.exitCode}).`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch (_) {
      // O servidor ainda está iniciando.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('O servidor não iniciou dentro do período de teste.');
}

test('API de contas a pagar: CRUD, status, filtros e anexos', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eurolatina-api-'));
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DB_FILE: path.join(tempDir, 'test.sqlite') },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 1500);
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child).catch((error) => { throw new Error(`${error.message}\n${stderr}`); });

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

  const home = await fetch(baseUrl);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Contas a pagar/);
  for (const asset of ['/logo-eurolatina.jpeg', '/logo-fatec.png']) {
    const response = await fetch(`${baseUrl}${asset}`);
    assert.equal(response.status, 200, `Asset não servido: ${asset}`);
  }

  let result = await request('/api/health');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, 'ok');

  result = await request('/api/contas');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data, []);

  result = await request('/api/contas', 'POST', {
    fornecedor: 'Fornecedor de Aço Teste', data_vencimento: '2026-12-10', valor: 1850.5,
    categoria: 'Matéria-prima', numero_documento: 'NF 123', descricao: 'Barras para usinagem CNC'
  });
  assert.equal(result.response.status, 201);
  const id = result.data.id;
  assert.ok(result.data.data_criacao);
  assert.equal(result.data.status, 'pendente');

  result = await request('/api/contas', 'POST', { fornecedor: '', data_vencimento: '2026-02-30', valor: -1 });
  assert.equal(result.response.status, 400);

  result = await request(`/api/contas/${id}`, 'PUT', {
    fornecedor: 'Fornecedor Atualizado', data_vencimento: '2026-12-11', valor: 2000,
    categoria: 'Ferramentas e insumos', descricao: 'Conta editada'
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.fornecedor, 'Fornecedor Atualizado');
  assert.equal(result.data.valor, 2000);

  result = await request(`/api/contas/${id}/anexo`, 'POST', {
    nome: 'fatura.pdf', mime: 'application/pdf', dados: 'data:application/pdf;base64,JVBERi0xLjQKJUVPRg=='
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.anexo_nome, 'fatura.pdf');

  const download = await fetch(`${baseUrl}/api/contas/${id}/anexo`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /application\/pdf/);
  assert.ok((await download.arrayBuffer()).byteLength > 0);

  result = await request(`/api/contas/${id}/anexo`, 'DELETE');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.anexo_arquivo, null);

  result = await request(`/api/contas/${id}`, 'PUT', { status: 'liquidada' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, 'liquidada');
  assert.match(result.data.data_liquidacao, /^\d{4}-\d{2}-\d{2}$/);

  result = await request(`/api/contas/${id}`, 'PUT', { status: 'pendente' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, 'pendente');
  assert.equal(result.data.data_liquidacao, null);

  result = await request('/api/contas?busca=Atualizado&status=pendente');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.length, 1);

  result = await request(`/api/contas/${id}`, 'DELETE');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.deleted, true);

  result = await request(`/api/contas/${id}`);
  assert.equal(result.response.status, 404);
});
