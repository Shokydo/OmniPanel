#!/usr/bin/env node
'use strict';
/*
 * Генератор таблицы настроек server.properties для Rust-ядра.
 *
 *   node tools/gen-props-schema.js
 *
 * Читает ui/props-schema.js — тот самый файл, по которому рисуется окно
 * настроек, — и пишет rust/omnipanel-core/src/props_schema.rs.
 *
 * Зачем: в панели 64 настройки, и они меняются от версии к версии. Если
 * держать список руками в Rust, окно настроек однажды покажет не то, что
 * сохраняет ядро. Один источник — схема интерфейса.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ui', 'props-schema.js');
const OUT = path.join(ROOT, 'rust', 'omnipanel-core', 'src', 'props_schema.rs');

const schema = require(SRC);
if (!Array.isArray(schema.props) || !schema.props.length) {
  console.error('в ui/props-schema.js нет списка props');
  process.exit(1);
}

const KINDS = { bool: 'Bool', num: 'Num', text: 'Text', enum: 'Text' };
const lines = [];
const groups = new Map();
for (const field of schema.props) {
  const kind = KINDS[field.type];
  if (!kind) {
    console.error(`непонятный тип поля ${field.key}: ${field.type}`);
    process.exit(1);
  }
  const def = field.def === undefined || field.def === null ? '' : String(field.def);
  lines.push(
    `    Field { key: ${JSON.stringify(field.key)}, kind: Kind::${kind}, group: ${JSON.stringify(field.group || '')}, def: ${JSON.stringify(def)} },`
  );
  const g = field.group || 'main';
  groups.set(g, (groups.get(g) || 0) + 1);
}

const byType = schema.props.reduce((acc, f) => {
  const kind = KINDS[f.type];
  acc[kind] = (acc[kind] || 0) + 1;
  return acc;
}, {});

const text = `/* ЭТОТ ФАЙЛ СОБИРАЕТСЯ АВТОМАТИЧЕСКИ: node tools/gen-props-schema.js
 *
 * Источник — ui/props-schema.js (по нему рисуется окно настроек).
 * Руками не править: правь схему и запусти генератор.
 *
 * Полей: ${schema.props.length} (флаги ${byType.Bool || 0}, числа ${byType.Num || 0}, текстовые ${byType.Text || 0}).
 */

/// Как разбирать значение настройки.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Bool,
    Num,
    Text,
}

/// Одна настройка server.properties.
#[derive(Debug, Clone, Copy)]
pub struct Field {
    pub key: &'static str,
    pub kind: Kind,
    /// Раздел окна настроек (main, world, players, net, pack, perf, debug).
    pub group: &'static str,
    /// Что подставляет сам сервер, если ключа в файле нет.
    pub def: &'static str,
}

/// Все настройки, которые правит панель.
pub const FIELDS: &[Field] = &[
${lines.join('\n')}
];

/// Настройка по ключу.
pub fn field(key: &str) -> Option<&'static Field> {
    FIELDS.iter().find(|f| f.key == key)
}

/// Все ключи схемы — то, что панель показывает в окне настроек.
pub fn keys() -> Vec<&'static str> {
    FIELDS.iter().map(|f| f.key).collect()
}
`;

fs.writeFileSync(OUT, text, 'utf8');
console.log(`схема настроек: ${schema.props.length} полей → ${path.relative(ROOT, OUT)}`);
const parts = [...groups.entries()].map(([g, n]) => `${g}:${n}`).join(', ');
console.log(`  разделы: ${parts}`);
console.log(
  `  типы: флаги ${byType.Bool || 0}, числа ${byType.Num || 0}, текст ${byType.Text || 0}`
);
