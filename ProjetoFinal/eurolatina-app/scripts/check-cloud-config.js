'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const missing = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']
  .filter((key) => !String(process.env[key] || '').trim());

if (missing.length) {
  console.error(`Configuração incompleta. Variáveis ausentes: ${missing.join(', ')}.`);
  console.error('Conecte o Turso Cloud ao projeto Vercel ou preencha o arquivo .env.local para desenvolvimento.');
  process.exit(1);
}

const { createClient } = require('@libsql/client');
const client = createClient({
  url: process.env.TURSO_DATABASE_URL.trim(),
  authToken: process.env.TURSO_AUTH_TOKEN.trim()
});

(async () => {
  try {
    const result = await client.execute('SELECT 1 AS conectado');
    if (Number(result.rows[0]?.conectado) !== 1) throw new Error('O banco respondeu, mas o teste SELECT 1 não retornou o resultado esperado.');
    console.log('Conexão com Turso Cloud confirmada.');
    console.log('O sistema usará o banco remoto; nenhum SQLite local será criado.');
  } catch (error) {
    console.error(`Não foi possível conectar ao Turso Cloud: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();
