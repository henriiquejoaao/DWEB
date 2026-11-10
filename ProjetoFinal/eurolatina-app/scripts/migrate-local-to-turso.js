'use strict';

// Copia as contas de database.sqlite local para o banco Turso configurado nas variáveis.
// Execute uma única vez, com o banco Turso de destino vazio ou após fazer backup dele.

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@libsql/client');

const ROOT = path.resolve(__dirname, '..');
const sourceFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(ROOT, 'database.sqlite');
const uploadsDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(ROOT, 'uploads');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('Defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN antes de executar a migração.');
  process.exit(1);
}
if (!fs.existsSync(sourceFile)) {
  console.error(`Banco SQLite local não encontrado: ${sourceFile}`);
  process.exit(1);
}

function allLocal(db, sql) {
  return new Promise((resolve, reject) => db.all(sql, [], (error, rows) => error ? reject(error) : resolve(rows)));
}

function closeLocal(db) {
  return new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}

async function main() {
  const local = new sqlite3.Database(sourceFile, sqlite3.OPEN_READONLY);
  const remote = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });

  try {
    await remote.execute(`CREATE TABLE IF NOT EXISTS contas (
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
      anexo_tamanho INTEGER,
      anexo_conteudo BLOB
    )`);

    const schema = await remote.execute('PRAGMA table_info(contas)');
    const existing = new Set(schema.rows.map((row) => row.name));
    const additions = [
      ['data_criacao', 'TEXT'], ['data_liquidacao', 'TEXT'], ['descricao', 'TEXT'],
      ['categoria', "TEXT DEFAULT 'Outros'"], ['numero_documento', 'TEXT'],
      ['anexo_nome', 'TEXT'], ['anexo_arquivo', 'TEXT'], ['anexo_mime', 'TEXT'],
      ['anexo_tamanho', 'INTEGER'], ['anexo_conteudo', 'BLOB']
    ];
    for (const [name, type] of additions) {
      if (!existing.has(name)) await remote.execute(`ALTER TABLE contas ADD COLUMN ${name} ${type}`);
    }
    await remote.execute('CREATE INDEX IF NOT EXISTS idx_contas_vencimento ON contas(data_vencimento)');
    await remote.execute('CREATE INDEX IF NOT EXISTS idx_contas_status ON contas(status)');

    const rows = await allLocal(local, 'SELECT * FROM contas ORDER BY id ASC');
    let migrated = 0;
    let attachments = 0;

    for (const row of rows) {
      let attachment = row.anexo_conteudo || null;
      let attachmentName = row.anexo_nome || null;
      let attachmentFile = row.anexo_arquivo || null;
      let attachmentMime = row.anexo_mime || null;
      let attachmentSize = row.anexo_tamanho || null;

      // Migra também arquivos que a versão anterior guardava em uploads/.
      if (!attachment && attachmentFile) {
        const oldPath = path.join(uploadsDir, path.basename(attachmentFile));
        if (fs.existsSync(oldPath)) {
          attachment = fs.readFileSync(oldPath);
          attachmentSize = attachment.length;
          attachments += 1;
        } else {
          console.warn(`Aviso: anexo da conta ${row.id} não localizado; a conta será migrada sem esse arquivo.`);
          attachmentName = attachmentFile = attachmentMime = attachmentSize = null;
        }
      } else if (attachment) {
        attachments += 1;
      }

      await remote.execute({
        sql: `INSERT OR REPLACE INTO contas (
          id, fornecedor, data_criacao, data_vencimento, data_liquidacao, valor, status,
          descricao, categoria, numero_documento, anexo_nome, anexo_arquivo,
          anexo_mime, anexo_tamanho, anexo_conteudo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          row.id, row.fornecedor, row.data_criacao || null, row.data_vencimento,
          row.data_liquidacao || null, row.valor, row.status || 'pendente',
          row.descricao || null, row.categoria || 'Outros', row.numero_documento || null,
          attachmentName, attachmentFile, attachmentMime, attachmentSize,
          attachment ? Buffer.from(attachment) : null
        ]
      });
      migrated += 1;
    }

    console.log(`Migração concluída: ${migrated} conta(s) e ${attachments} anexo(s) copiados para o Turso.`);
    console.log('Confira os registros no banco remoto antes de apontar o deploy de produção para ele.');
  } finally {
    await closeLocal(local).catch(() => {});
    await remote.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error('Falha na migração:', error);
  process.exitCode = 1;
});
