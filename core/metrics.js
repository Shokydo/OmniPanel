'use strict';
/**
 * Сбор метрик процессов (CPU % и RAM) для дерева процессов каждого сервера.
 * Работает без внешних зависимостей: Windows — PowerShell/WMI, Unix — ps + /proc.
 */
const os = require('os');
const { execFile } = require('child_process');

const NCORES = Math.max(1, (os.cpus() || []).length);

// предыдущие замеры CPU-времени: pid -> {cpuMs, wall}
const prevCpu = new Map();

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 24 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

/** Все процессы системы: [{ pid, ppid, cpuMs, rss }] */
async function snapshotWindows() {
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,UserModeTime,KernelModeTime,WorkingSetSize | ConvertTo-Json -Compress';
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!out.trim()) return [];
  let data;
  try { data = JSON.parse(out); } catch { return []; }
  if (!Array.isArray(data)) data = [data];
  return data.map((p) => ({
    pid: Number(p.ProcessId),
    ppid: Number(p.ParentProcessId),
    // UserModeTime/KernelModeTime — в единицах по 100 нс
    cpuMs: (Number(p.UserModeTime || 0) + Number(p.KernelModeTime || 0)) / 10000,
    rss: Number(p.WorkingSetSize || 0),
  }));
}

function parsePsTime(str) {
  // форматы: "00:12:34", "1-02:03:04"
  const m = String(str).trim().match(/^(?:(\d+)-)?(\d+):(\d+):(\d+)$/);
  if (!m) return 0;
  const [, d, h, mi, s] = m;
  return ((Number(d || 0) * 86400) + Number(h) * 3600 + Number(mi) * 60 + Number(s)) * 1000;
}

async function snapshotUnix() {
  const out = await run('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=']);
  if (!out.trim()) return [];
  const rows = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const cpuMs = parsePsTime(parts[2]);
    const rss = Number(parts[3]) * 1024; // ps отдаёт килобайты
    if (!Number.isFinite(pid)) continue;
    rows.push({ pid, ppid, cpuMs, rss });
  }
  return rows;
}

async function snapshot() {
  return process.platform === 'win32' ? snapshotWindows() : snapshotUnix();
}

/** Собирает все потомки процесса (включая его самого). */
function collectTree(rootPid, childrenMap) {
  const out = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const child of childrenMap.get(pid) || []) stack.push(child);
  }
  return out;
}

/**
 * Возвращает метрики для набора серверов.
 * @param {Array<{id:string, pid:number}>} targets
 * @returns {Promise<Map<string,{cpu:number|null, rss:number, procs:number}>>}
 */
async function collect(targets) {
  const result = new Map();
  const live = targets.filter((t) => Number(t.pid) > 0);
  if (!live.length) return result;

  const rows = await snapshot();
  if (!rows.length) return result;

  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const childrenMap = new Map();
  for (const r of rows) {
    if (!childrenMap.has(r.ppid)) childrenMap.set(r.ppid, []);
    childrenMap.get(r.ppid).push(r.pid);
  }

  const now = Date.now();

  for (const t of live) {
    const pids = collectTree(Number(t.pid), childrenMap);
    let rss = 0;
    let cpuMs = 0;
    let counted = 0;

    for (const pid of pids) {
      const row = byPid.get(pid);
      if (!row) continue;
      rss += row.rss;
      cpuMs += row.cpuMs;
      counted++;
    }
    if (!counted) continue;

    // CPU% считаем по приросту процессорного времени между замерами
    let cpu = null;
    const prev = prevCpu.get(t.id);
    if (prev && now > prev.wall) {
      const dcpu = cpuMs - prev.cpuMs;
      const dwall = now - prev.wall;
      if (dcpu >= 0 && dwall > 0) {
        cpu = Math.min(100, ((dcpu / dwall) * 100) / NCORES);
      }
    }
    prevCpu.set(t.id, { cpuMs, wall: now });
    result.set(t.id, { cpu: cpu == null ? null : Math.round(cpu * 10) / 10, rss, procs: counted });
  }

  return result;
}

function forget(id) {
  prevCpu.delete(id);
}

module.exports = { collect, forget, NCORES };
