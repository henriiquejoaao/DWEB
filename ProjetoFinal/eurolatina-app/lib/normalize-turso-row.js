'use strict';

/**
 * Converte uma linha do @libsql/client em um objeto simples com chaves de coluna.
 * Não usa row.toJSON(): no driver, a serialização JSON de Row pode produzir um
 * array posicional; isso faria campos como `total` ficarem undefined.
 */
function normalizeTursoRow(row, columns) {
  if (!row) return row;
  const names = Array.isArray(columns) ? columns : [];
  const normalized = {};

  for (let index = 0; index < names.length; index += 1) {
    const column = names[index];
    let value;
    try {
      value = row[column];
    } catch {
      value = undefined;
    }
    if (value === undefined) value = row[index];
    normalized[column] = value;
  }

  if (names.length === 0 && typeof row === 'object') {
    return Array.isArray(row) ? [...row] : { ...row };
  }
  return normalized;
}

module.exports = normalizeTursoRow;
