'use strict';
/**
 * Кодовые страницы Windows (0x80-0xFF) для корректного отображения кириллицы.
 * Сгенерировано автоматически, руками не править.
 */

const CP866 = "\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u0419\u041a\u041b\u041c\u041d\u041e\u041f\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042a\u042b\u042c\u042d\u042e\u042f\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043a\u043b\u043c\u043d\u043e\u043f\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044a\u044b\u044c\u044d\u044e\u044f\u0401\u0451\u0404\u0454\u0407\u0457\u040e\u045e\u00b0\u2219\u00b7\u221a\u2116\u00a4\u25a0\u00a0";

const CP1251 = "\u0402\u0403\u201a\u0453\u201e\u2026\u2020\u2021\u20ac\u2030\u0409\u2039\u040a\u040c\u040b\u040f\u0452\u2018\u2019\u201c\u201d\u2022\u2013\u2014\ufffd\u2122\u0459\u203a\u045a\u045c\u045b\u045f\u00a0\u040e\u045e\u0408\u00a4\u0490\u00a6\u00a7\u0401\u00a9\u0404\u00ab\u00ac\u00ad\u00ae\u0407\u00b0\u00b1\u0406\u0456\u0491\u00b5\u00b6\u00b7\u0451\u2116\u0454\u00bb\u0458\u0405\u0455\u0457\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u0419\u041a\u041b\u041c\u041d\u041e\u041f\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042a\u042b\u042c\u042d\u042e\u042f\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043a\u043b\u043c\u043d\u043e\u043f\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044a\u044b\u044c\u044d\u044e\u044f";


const TABLES = { cp866: CP866, cp1251: CP1251 };

/** Декодирует однобайтовую кодировку (cp866 / cp1251). */
function decodeSingleByte(buf, encoding) {
  const table = TABLES[encoding];
  if (!table) return buf.toString('utf8');
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out += b < 0x80 ? String.fromCharCode(b) : table[b - 0x80];
  }
  return out;
}

/**
 * Насколько «похож на текст» результат декодирования.
 * Кириллица и обычный ASCII — плюс, рамки/блоки/битые символы — минус.
 */
const RARE = new Set('ЄєЎў¤Ґґ‡¦¨¬®ЇїЈјЅѕЌќџѢѣѤѥѦѧѨѩѪѫѬѭѮѯѰѱѲѳѴѵѶѷѸѹѺѻѼѽѾѿ'.split(''));

function plausibility(s) {
  let score = 0;
  let prevCyrUpper = false;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const isLower = c >= 0x430 && c <= 0x44F;
    const isUpper = (c >= 0x410 && c <= 0x42F) || c === 0x401;
    if (c === 0xFFFD) { score -= 8; continue; }
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) { score -= 3; continue; }
    if (c < 0x7F) { score += 1; prevCyrUpper = false; continue; }
    if (RARE.has(ch)) { score -= 6; prevCyrUpper = false; continue; }      // «╟руЁєцхэю», «‡аЈаг¦Ґ­®»
    if (isLower) {
      // строчная после заглавной посреди слова — почти всегда следствие неверной кодировки
      if (prevCyrUpper) score -= 2;
      score += 2;
      prevCyrUpper = false;
      continue;
    }
    if (isUpper) { score += 1; prevCyrUpper = true; continue; }
    if (c === 0x451) { score += 2; prevCyrUpper = false; continue; }        // ё
    if (c >= 0x400 && c <= 0x4FF) { score += 1; prevCyrUpper = false; continue; }
    if (c >= 0x2500 && c <= 0x25FF) { score -= 3; prevCyrUpper = false; continue; }
    if (c >= 0x2100 && c <= 0x23FF) { score -= 3; prevCyrUpper = false; continue; }
    if (c === 0xA0 || c === 0xB0 || c === 0xB7) { prevCyrUpper = false; continue; }
    score += 0.5;
    prevCyrUpper = false;
  }
  return score;
}

/** Обратные таблицы: символ → байт (для «перекодировать и посмотреть»). */
const REVERSE = Object.create(null);
for (const [name, table] of Object.entries({ cp866: CP866, cp1251: CP1251 })) {
  const map = new Map();
  for (let i = 0; i < table.length; i++) map.set(table[i], 0x80 + i);
  REVERSE[name] = map;
}

/** Кодирует строку обратно в однобайтовую кодировку (символы вне таблицы → «?»). */
function encodeSingleByte(str, encoding) {
  const map = REVERSE[encoding];
  if (!map) return Buffer.from(str, 'utf8');
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (map.has(ch)) out.push(map.get(ch));
    else out.push(0x3F);
  }
  return Buffer.from(out);
}

/**
 * Лечение «кракозябр»: если текст явно декодирован не той кодировкой,
 * перекодируем его обратно в байты и пробуем другую таблицу.
 * Пример: «╟руЁєцхэю яЁхфьхЄют» → «Загружено предметов».
 */
function repairMojibake(s) {
  if (!s) return s;
  if (!/[\u0080-\uFFFF]/.test(s)) return s;

  const looksBroken = /[\u2500-\u257F]/.test(s) || [...s].some((ch) => RARE.has(ch));
  if (!looksBroken) return s;

  const base = plausibility(s);
  let best = s;
  let bestScore = base;

  for (const from of ['cp866', 'cp1251']) {
    const bytes = encodeSingleByte(s, from);
    for (const to of ['cp866', 'cp1251']) {
      if (to === from) continue;
      const candidate = decodeSingleByte(bytes, to);
      if (candidate === s) continue;
      if (/\uFFFD|\?{3,}/.test(candidate)) continue;
      const score = plausibility(candidate);
      if (score > bestScore + 2) { best = candidate; bestScore = score; }
    }
  }
  return best;
}

function isValidUtf8(buf) {
  return !buf.toString('utf8').includes('\uFFFD');
}

/**
 * Определяет кодировку куска вывода: utf8 / cp866 / cp1251.
 * Валидный UTF-8 принимается сразу; иначе сравниваем cp866 и cp1251 по «похожести на текст».
 * @param {Buffer} buf
 * @returns {'utf8'|'cp866'|'cp1251'}
 */
function detectEncoding(buf) {
  const asUtf8 = buf.toString('utf8');
  if (!/[\u0080-\uFFFF]/.test(asUtf8)) return 'utf8'; // чистый ASCII — разницы нет

  if (isValidUtf8(buf)) return 'utf8';

  // хвост может быть обрезан посреди многобайтового символа — проверяем без 1-3 последних байт
  for (let cut = 1; cut <= 3 && cut < buf.length; cut++) {
    if (isValidUtf8(buf.subarray(0, buf.length - cut))) return 'utf8';
  }

  const s866 = plausibility(decodeSingleByte(buf, 'cp866'));
  const s1251 = plausibility(decodeSingleByte(buf, 'cp1251'));
  return s866 >= s1251 ? 'cp866' : 'cp1251';
}

module.exports = { decodeSingleByte, encodeSingleByte, detectEncoding, repairMojibake, plausibility, CP866, CP1251, TABLES };
