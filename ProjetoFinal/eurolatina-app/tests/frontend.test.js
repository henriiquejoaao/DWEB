'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('interface contém Dashboard e Agenda mensal e o JavaScript é válido', () => {
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

  assert.ok(scriptMatch, 'O JavaScript principal deve existir no index.html');
  assert.match(html, /id="view-dashboard"/);
  assert.match(html, /id="view-contas"/);
  assert.match(html, /Agenda de contas/);
  assert.match(html, /id="calendar-grid"/);
  assert.match(html, /id="selected-day-list"/);
  assert.match(html, /onclick="mudarMes\(-1\)"/);
  assert.match(html, /onclick="mudarMes\(1\)"/);
  assert.match(html, /onclick="irParaHoje\(\)"/);
  assert.doesNotMatch(html, /id="list-overdue"|id="list-today"|id="list-week"/);

  assert.doesNotThrow(() => new vm.Script(scriptMatch[1]), 'O JavaScript da interface deve ter sintaxe válida');
});
