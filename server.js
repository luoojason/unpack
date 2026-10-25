// Unpack: drop in a program, get a rebuilt project back, with a fidelity report.
// Zero dependencies. Run: node server.js  (needs dotnet SDK + ilspycmd on PATH)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = process.env.PORT || 8701;
const HOST = process.env.HOST || '127.0.0.1';
// Online mode: never execute uploaded programs (set UNPACK_RUN=0). Samples we ship are still run.
const RUN_UPLOADS = process.env.UNPACK_RUN !== '0';
const MAX_UPLOAD = 100 * 1024 * 1024;
const ROOT = __dirname;
const WORK = path.join(ROOT, 'work');
const SAMPLES = {
  snake: {
    name: 'Snake (console game)',
    binary: path.join(ROOT, 'demo/snake/orig_build/Snake.dll'),
    sourceDir: path.join(ROOT, 'demo/snake/Snake'),
    // replay vectors: args fed to both builds, stdout compared
    vectors: [
      ['--replay', '7', 'RRRRDDDDLLLLUUUURRRRDDDDRRRRRRRRRRRR'],
      ['--replay', '3', 'DDDDRRRRUUUULLLLDDDD'],
      ['--replay', '11', 'RRRRRRRRRRRRRRRRRRRR'],
    ],
  },
};
fs.mkdirSync(WORK, { recursive: true });
const jobs = new Map();

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { shell: false, windowsHide: true, ...opts });
    let out = '', err = '';
    const t = setTimeout(() => p.kill(), opts.timeout || 120000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

// ---- identify ----
function identify(buf, name) {
  const lower = name.toLowerCase();
  if (buf.slice(0, 4).toString('latin1') === 'PK\x03\x04') {
    if (lower.endsWith('.jar')) return { kind: 'jar', label: 'Java archive' };
    if (lower.endsWith('.apk')) return { kind: 'apk', label: 'Android package' };
    return { kind: 'zip', label: 'ZIP archive' };
  }
  if (lower.endsWith('.asar')) return { kind: 'asar', label: 'Electron app archive' };
  if (buf.slice(0, 2).toString('latin1') === 'MZ') {
    try {
      const pe = buf.readUInt32LE(0x3c);
      if (buf.slice(pe, pe + 4).toString('latin1') !== 'PE\0\0') throw 0;
      const magic = buf.readUInt16LE(pe + 24);
      const ddOff = pe + 24 + (magic === 0x20b ? 112 : 96);
      const clrRva = buf.readUInt32LE(ddOff + 14 * 8);
      if (clrRva) return { kind: 'dotnet', label: '.NET assembly (managed)' };
      return { kind: 'native-pe', label: 'Native Windows program' };
    } catch { return { kind: 'native-pe', label: 'Windows program' }; }
  }
  if (buf.slice(0, 4).toString('latin1') === '\x7fELF') return { kind: 'native-elf', label: 'Native Linux program' };
  return { kind: 'unknown', label: 'Unknown file type' };
}

// ---- source similarity (token LCS ratio) ----
function tokens(src) {
  return src
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .match(/[A-Za-z_][A-Za-z0-9_]*|\d+|[^\sA-Za-z0-9_]/g) || [];
}
function lcsRatio(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint32Array(b.length + 1), cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++)
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return (2 * prev[b.length]) / (a.length + b.length);
}
function readCs(dir) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['obj', 'bin', 'Properties'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.cs')) files.push(p);
    }
  })(dir);
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}
// identifiers that survive compilation (types/members) vs. ones that are erased (locals)
function identifierRecall(origSrc, newSrc) {
  const ids = (s) => new Set((s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []));
  const a = ids(origSrc), b = ids(newSrc);
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return a.size ? hit / a.size : 0;
}

// ---- pipeline ----
function step(job, id, label) { job.steps.push({ id, label, status: 'running', t: Date.now() }); job.current = id; }
function done(job, id, detail, ok = true) {
  const s = job.steps.find((x) => x.id === id);
  s.status = ok ? 'done' : 'failed'; s.detail = detail; s.ms = Date.now() - s.t;
}

async function pipeline(job, binPath, fileName, sample) {
  const dir = path.join(WORK, job.id);
  const outDir = path.join(dir, 'rebuilt');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const buf = fs.readFileSync(binPath);
    step(job, 'identify', 'Identifying program');
    const kind = identify(buf, fileName);
    job.kind = kind; job.sha256 = sha256(buf); job.size = buf.length;
    done(job, 'identify', `${kind.label} · ${(buf.length / 1024).toFixed(0)} KB`);

    if (kind.kind === 'dotnet') {
      step(job, 'decompile', 'Decompiling to C# source');
      const r = await run('ilspycmd', ['-p', '-o', outDir, binPath]);
      const cs = [];
      (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : e.name.endsWith('.cs') && cs.push(p); } })(outDir);
      if (r.code !== 0 || !cs.length) { done(job, 'decompile', (r.err || r.out).slice(0, 300), false); throw new Error('decompile failed'); }
      job.rebuiltFiles = cs.map((f) => path.relative(outDir, f).replace(/\\/g, '/'));
      done(job, 'decompile', `${cs.length} source file(s), ${cs.reduce((n, f) => n + fs.readFileSync(f, 'utf8').split('\n').length, 0)} lines`);

      step(job, 'rebuild', 'Rebuilding with the .NET compiler');
      const rb = path.join(dir, 'rebuilt_build');
      const b = await run('dotnet', ['build', '-c', 'Release', '-o', rb, '-nologo', '-v', 'q'], { cwd: outDir, timeout: 240000 });
      const dll = fs.existsSync(rb) ? fs.readdirSync(rb).find((f) => f.endsWith('.dll') && f.toLowerCase() === path.basename(binPath).toLowerCase()) : null;
      job.builds = b.code === 0 && !!dll;
      done(job, 'rebuild', job.builds ? 'Compiled with 0 errors' : (b.out + b.err).split('\n').filter((l) => /error/.test(l)).slice(0, 3).join('\n'), job.builds);

      // fidelity: behaviour
      step(job, 'behavior', 'Running original and rebuilt side by side');
      // a lone uploaded dll has no runtime config; write one so `dotnet x.dll` can start
      const rc = binPath.replace(/\.(dll|exe)$/i, '') + '.runtimeconfig.json';
      if (!fs.existsSync(rc)) {
        fs.writeFileSync(rc, JSON.stringify({ runtimeOptions: { tfm: 'net8.0', framework: { name: 'Microsoft.NETCore.App', version: '8.0.0' }, rollForward: 'LatestMajor' } }));
      }
      const vectors = sample ? sample.vectors : (RUN_UPLOADS ? [[]] : []);
      const results = [];
      if (job.builds) {
        for (const v of vectors) {
          const [a, c] = await Promise.all([
            run('dotnet', [binPath, ...v], { timeout: 15000 }),
            run('dotnet', [path.join(rb, dll), ...v], { timeout: 15000 }),
          ]);
          results.push({ args: v.join(' ') || '(no args)', same: a.out === c.out && a.code === c.code, original: a.out.slice(0, 600), rebuilt: c.out.slice(0, 600) });
        }
      }
      job.behavior = results;
      const same = results.filter((x) => x.same).length;
      job.behaviorScore = results.length ? same / results.length : 0;
      done(job, 'behavior', results.length ? `${same}/${results.length} test runs produce identical output` : 'Skipped (rebuild failed)', same === results.length && results.length > 0);

      // fidelity: source
      step(job, 'source', 'Comparing against the true source');
      const rebuiltSrc = cs.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
      job.rebuiltSource = rebuiltSrc;
      job.files = Object.fromEntries(cs.map((f) => [path.relative(outDir, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')]));
      if (sample && job.builds) { job.playable = true; job._orig = binPath; job._rebuilt = path.join(rb, dll); job._seed = sample.vectors[0][1]; }
      if (sample) {
        const orig = readCs(sample.sourceDir);
        job.originalSource = orig;
        job.tokenSimilarity = lcsRatio(tokens(orig), tokens(rebuiltSrc));
        job.identifierRecall = identifierRecall(orig, rebuiltSrc);
        done(job, 'source', `${(job.tokenSimilarity * 100).toFixed(1)}% token match · ${(job.identifierRecall * 100).toFixed(0)}% of names recovered`);
      } else {
        done(job, 'source', 'No original source supplied, so no source score');
      }
    } else if (kind.kind === 'native-pe' || kind.kind === 'native-elf') {
      step(job, 'decompile', 'Static analysis of native code');
      const strs = (buf.toString('latin1').match(/[\x20-\x7e]{8,}/g) || []).slice(0, 400);
      fs.writeFileSync(path.join(outDir, 'strings.txt'), strs.join('\n'));
      fs.writeFileSync(path.join(outDir, 'README.md'), `# ${fileName}\n\nNative binary. Only string extraction ran; full pseudocode needs the Ghidra engine.\n`);
      job.rebuiltFiles = ['README.md', 'strings.txt'];
      job.partial = true;
      done(job, 'decompile', `Native code: extracted ${strs.length} strings. Full pseudocode needs the Ghidra engine.`);
    } else {
      step(job, 'decompile', 'Looking inside');
      done(job, 'decompile', `${kind.label} is not supported yet`, false);
      throw new Error('unsupported');
    }

    step(job, 'package', 'Packaging download');
    const zip = path.join(dir, 'rebuilt-project.zip');
    if (process.platform === 'win32') await run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zip}' -Force`]);
    else await run('zip', ['-r', '-q', zip, '.'], { cwd: outDir });
    job.zip = fs.existsSync(zip) ? `/api/jobs/${job.id}/download` : null;
    done(job, 'package', job.zip ? 'Ready' : 'Zip failed', !!job.zip);
    job.status = 'done';
  } catch (e) {
    job.status = 'failed'; job.error = String(e.message || e);
  }
}

function newJob() {
  const id = crypto.randomBytes(5).toString('hex');
  const job = { id, status: 'running', steps: [], created: Date.now() };
  jobs.set(id, job);
  return job;
}


// ---- OpenRA live panel: run the original and the rebuilt engine side by side ----
const ORA_REB = process.env.OPENRA_REB || path.join(ROOT, 'openra_app', 'reb');
const ORA_ORIG = process.env.OPENRA_ORIG || path.join(ROOT, 'openra_app', 'orig');
const ORA_CHECKS = {
  ra: { label: 'Red Alert rules and maps', args: ['ra', '--check-yaml'] },
  cnc: { label: 'Tiberian Dawn rules and maps', args: ['cnc', '--check-yaml'] },
  d2k: { label: 'Dune 2000 rules and maps', args: ['d2k', '--check-yaml'] },
  docs: { label: 'Unit documentation export', args: ['all', '--docs'] },
  lua: { label: 'Scripting API listing', args: ['all', '--emmy-lua-api'] },
};
const oraCache = new Map();
function oraUtil(root, args) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile('dotnet', [path.join(root, 'bin', 'OpenRA.Utility.dll'), ...args],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 120000,
        env: { ...process.env, DOTNET_ROLL_FORWARD: 'Major', DOTNET_CLI_TELEMETRY_OPTOUT: '1', ENGINE_DIR: root } },
      (err, stdout, stderr) => resolve({ text: String(stdout || '') + String(stderr || ''), ms: Date.now() - t0, failed: !!err && !stdout }));
  });
}
const oraBusy = { n: 0 };
setTimeout(async () => { for (const id of ['docs', 'lua', 'ra', 'cnc', 'd2k']) { try { await oraRun(id); } catch {} } }, 3000);
async function oraRun(id) {
  if (oraCache.has(id)) return oraCache.get(id);
  const c = ORA_CHECKS[id];
  const p = (async () => {
    const [o, r] = await Promise.all([oraUtil(ORA_ORIG, c.args), oraUtil(ORA_REB, c.args)]);
    const same = o.text === r.text;
    const sorted = !same && o.text.split('\n').sort().join('\n') === r.text.split('\n').sort().join('\n');
    return { o, r, same, sorted };
  })();
  oraCache.set(id, p);
  p.catch(() => oraCache.delete(id));
  return p;
}
function oraPreview(id, text, lines) {
  if (id === 'docs') { try { return JSON.stringify(JSON.parse(text).TraitInfos.slice(0, 3), null, 1).split('\n').slice(0, 60).join('\n'); } catch (e) {} }
  return lines.slice(0, 60).join('\n');
}
async function openraRoute(url) {
  if (!fs.existsSync(path.join(ORA_REB, 'bin', 'OpenRA.Utility.dll'))) return { code: 503, body: { error: 'OpenRA is not installed on this server' } };
  if (oraBusy.n >= 3) return { code: 429, body: { error: 'Busy, try again in a few seconds' } };
  oraBusy.n++;
  try {
    if (url.pathname === '/api/openra/run') {
      const id = url.searchParams.get('check');
      if (!ORA_CHECKS[id]) return { code: 404, body: { error: 'unknown check' } };
      const x = await oraRun(id);
      const ol = x.o.text.split('\n'), rl = x.r.text.split('\n');
      let diff = -1; for (let i = 0; i < Math.max(ol.length, rl.length); i++) if (ol[i] !== rl[i]) { diff = i; break; }
      return { code: 200, body: { id, label: ORA_CHECKS[id].label, command: 'OpenRA.Utility ' + ORA_CHECKS[id].args.join(' '),
        same: x.same, sameContent: x.same || x.sorted, bytes: x.o.text.length, lines: ol.length, msOriginal: x.o.ms, msRebuilt: x.r.ms,
        hash: crypto.createHash('sha256').update(x.r.text).digest('hex').slice(0, 16),
        original: oraPreview(id, x.o.text, ol), rebuilt: oraPreview(id, x.r.text, rl),
        firstDiff: diff < 0 ? null : { line: diff + 1, original: (ol[diff] || '').slice(0, 200), rebuilt: (rl[diff] || '').slice(0, 200) } } };
    }
    const q = (url.searchParams.get('q') || '').trim().slice(0, 40);
    if (q.length < 2) return { code: 400, body: { error: 'Type at least 2 letters' } };
    const x = await oraRun('docs');
    const find = (t) => { let j; try { j = JSON.parse(t); } catch { return []; } const lo = q.toLowerCase();
      return (j.TraitInfos || []).filter((i) => i.Name.toLowerCase().includes(lo) || (i.Description || '').toLowerCase().includes(lo)).slice(0, 8)
        .map((i) => ({ name: i.Name, ns: i.Namespace, desc: (i.Description || '').slice(0, 220), props: (i.Properties || []).length, requires: (i.RequiresTraits || []).length })); };
    const a = find(x.o.text), b = find(x.r.text);
    return { code: 200, body: { q, original: a, rebuilt: b, same: JSON.stringify(a) === JSON.stringify(b) } };
  } finally { oraBusy.n--; }
}

// ---- http ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(ROOT, 'public/index.html')));
  }
  if (req.method === 'GET' && /^\/media\/[\w.-]+\.(mp4|webm|jpg|png)$/.test(url.pathname)) {
    const f = path.join(ROOT, 'public', url.pathname);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(f).size, type = /mp4$/.test(f) ? 'video/mp4' : /webm$/.test(f) ? 'video/webm' : /png$/.test(f) ? 'image/png' : 'image/jpeg';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 0, b = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1, 'cache-control': 'public, max-age=3600' });
      return fs.createReadStream(f, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'cache-control': 'public, max-age=3600' });
    return fs.createReadStream(f).pipe(res);
  }
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const name = path.basename(decodeURIComponent(req.headers['x-filename'] || 'upload.bin'));
    const job = newJob();
    const dir = path.join(WORK, job.id); fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    const ws = fs.createWriteStream(p);
    let got = 0;
    req.on('data', (c) => { got += c.length; if (got > MAX_UPLOAD) { req.destroy(); ws.destroy(); jobs.delete(job.id); } });
    req.pipe(ws);
    ws.on('finish', () => { json({ id: job.id }); pipeline(job, p, name, null); });
    return;
  }
  if (url.pathname === '/api/openra/run' || url.pathname === '/api/openra/search') {
    const out = await openraRoute(url);
    return json(out.body, out.code);
  }
  if (req.method === 'POST' && url.pathname === '/api/sample/openra') {
    const dir = path.join(ROOT, 'recorded', 'openra');
    if (!fs.existsSync(path.join(dir, 'result.json'))) return json({ error: 'recording missing' }, 404);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    const job = newJob(); job.recorded = true; job.zipPath = path.join(dir, 'rebuilt-project.zip');
    let t = 300;
    for (const st of rec.steps) {
      const dur = Math.min(2200, Math.max(700, st.ms / 25));
      setTimeout(() => job.steps.push({ id: st.id, label: st.label, status: 'running', detail: '' }), t);
      setTimeout(() => { const x = job.steps.find((q) => q.id === st.id); x.status = st.status; x.detail = st.detail; }, t + dur);
      t += dur + 120;
    }
    setTimeout(() => { const { steps, ...rest } = rec; Object.assign(job, rest, { zip: `/api/jobs/${job.id}/download`, status: 'done' }); }, t);
    return json({ id: job.id });
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/sample/')) {
    const s = SAMPLES[url.pathname.split('/').pop()];
    if (!s) return json({ error: 'no such sample' }, 404);
    const job = newJob();
    const dir = path.join(WORK, job.id); fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, path.basename(s.binary));
    fs.copyFileSync(s.binary, p);
    json({ id: job.id });
    pipeline(job, p, path.basename(s.binary), s);
    return;
  }
  const pm = url.pathname.match(/^\/api\/jobs\/(\w+)\/play$/);
  if (pm) {
    const job = jobs.get(pm[1]);
    if (!job || !job.playable) return json({ error: 'not playable' }, 404);
    const seed = url.searchParams.get('seed') || '7', moves = url.searchParams.get('moves') || '';
    if (!/^\d{1,6}$/.test(seed) || !/^[UDLR.]{0,600}$/.test(moves)) return json({ error: 'bad input' }, 400);
    const args = ['--replay', seed, moves || '.'];
    const [a, b] = await Promise.all([run('dotnet', [job._orig, ...args], { timeout: 8000 }), run('dotnet', [job._rebuilt, ...args], { timeout: 8000 })]);
    return json({ original: a.out, rebuilt: b.out, match: a.out === b.out });
  }
  const m = url.pathname.match(/^\/api\/jobs\/(\w+)(\/download)?$/);
  if (m) {
    const job = jobs.get(m[1]);
    if (!job) return json({ error: 'unknown job' }, 404);
    if (m[2]) {
      const z = job.zipPath || path.join(WORK, job.id, 'rebuilt-project.zip');
      if (!fs.existsSync(z)) return json({ error: 'not ready' }, 404);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="rebuilt-project.zip"' });
      return fs.createReadStream(z).pipe(res);
    }
    const { _orig, _rebuilt, _seed, zipPath, ...pub } = job;
    return json({ ...pub, seed: _seed });
  }
  json({ error: 'not found' }, 404);
});
server.listen(PORT, HOST, () => console.log(`Unpack on http://127.0.0.1:${PORT}`));
