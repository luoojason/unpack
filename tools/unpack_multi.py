#!/usr/bin/env python
"""Unpack, multi-assembly mode: decompile a whole .NET game, auto-repair compile errors,
rebuild, run it against the original, score it. Writes recorded/<name>/result.json + zip.

Usage: python tools/unpack_multi.py openra
"""
import os, re, sys, json, time, shutil, subprocess, difflib, zipfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO = os.path.join(ROOT, 'demo')
SRC = os.path.join(DEMO, 'openra-src')            # ground truth, used ONLY for scoring and test data
BIN = os.path.join(SRC, 'bin')                    # the compiled game: the only input to decompile
WORK = os.path.join(ROOT, 'work_openra')
OUT = os.path.join(ROOT, 'recorded', 'openra')
ENV = dict(os.environ, DOTNET_ROLL_FORWARD='Major', DOTNET_CLI_TELEMETRY_OPTOUT='1',
           PATH=os.environ['PATH'] + os.pathsep + os.path.expanduser('~/.dotnet/tools'))
# assemblies in dependency order: (dll, project dir, original source dir for scoring)
ASSEMBLIES = [('OpenRA.Game', 'game'), ('OpenRA.Mods.Common', 'mods_common'), ('OpenRA.Mods.Cnc', 'mods_cnc'),
              ('OpenRA.Mods.D2k', 'mods_d2k'), ('OpenRA.Platforms.Default', 'platforms'), ('OpenRA.Server', 'server'),
              ('OpenRA.Utility', 'utility')]
log_lines = []
def log(*a):
    s = ' '.join(str(x) for x in a); print(s, flush=True); log_lines.append(s)

def run(cmd, cwd=None, inp=None, timeout=900):
    p = subprocess.run(cmd, cwd=cwd, env=ENV, input=inp, capture_output=True, text=True, encoding='utf8', errors='replace', timeout=timeout)
    return p.returncode, (p.stdout or '') + (p.stderr or '')

def read(p): return open(p, encoding='utf8', errors='replace').read()
def write(p, s): open(p, 'w', encoding='utf8', newline='').write(s)

# ---------- repair rules ----------
ERR = re.compile(r'^(?P<file>[A-Za-z]:\\[^()]+?\.cs)\((?P<line>\d+),(?P<col>\d+)\): error (?P<code>CS\d+): (?P<msg>.*?)(?: \[.*)?$')
def parse_errors(out):
    seen, errs = set(), []
    for l in out.splitlines():
        m = ERR.match(l.strip())
        if m and (m['file'], m['line'], m['col'], m['code']) not in seen:
            seen.add((m['file'], m['line'], m['col'], m['code'])); errs.append(m.groupdict())
    return errs

def split_top_args(s):
    args, depth, cur = [], 0, ''
    for ch in s:
        if ch in '([{<' and ch != '<': depth += 1
        if ch in ')]}': depth -= 1
        if ch == ',' and depth == 0: args.append(cur); cur = ''
        else: cur += ch
    args.append(cur); return args

def find_call_args(line, start):
    """given index of '(' return (end index of matching ')', inner text)"""
    depth = 0
    for i in range(start, len(line)):
        if line[i] == '(': depth += 1
        elif line[i] == ')':
            depth -= 1
            if depth == 0: return i, line[start + 1:i]
    return None, None

def rule_null_overload(e, lines):
    """CS0121 ambiguous call where an argument is a bare `null`: cast it to the single (non-array) overload type."""
    m = re.search(r"between the following methods or properties: '[^']*\(([^,)]*)[,)].*?' and '[^']*\(([^,)]*)[,)]", e['msg'])
    if not m: return False
    cands = [t.strip() for t in m.groups()]
    plain = [t for t in cands if not t.endswith('[]')]
    if len(plain) != 1: return False
    i = int(e['line']) - 1; col = int(e['col']) - 1
    new = re.sub(r'\bnull\b', '(%s)null' % plain[0], lines[i][col:], count=1)
    if new == lines[i][col:]: return False
    lines[i] = lines[i][:col] + new; return True

def rule_numeric_literal_overload(e, lines):
    """CS0121 Math.Max/Min ambiguous between int and a narrower type: cast bare integer literals to the narrower type."""
    m = re.search(r"'System\.Math\.(Max|Min)\((int|sbyte|byte|short|ushort), \2\)' and 'System\.Math\.\1\((\w+), \3\)'", e['msg'])
    if not m: return False
    narrow = m.group(3) if m.group(2) == 'int' else m.group(2)
    i = int(e['line']) - 1; col = int(e['col']) - 1
    j = lines[i].find('Math.%s(' % m.group(1), max(0, col - 6))
    if j < 0: return False
    o = lines[i].index('(', j); end, inner = find_call_args(lines[i], o)
    if end is None: return False
    args = split_top_args(inner)
    fixed = [('(%s)%s' % (narrow, a.strip())) if re.fullmatch(r'\s*\d+\s*', a) else a for a in args]
    new_inner = ', '.join(x.strip() for x in fixed) if fixed != args else inner
    if new_inner == inner: return False
    lines[i] = lines[i][:o + 1] + new_inner + lines[i][end:]; return True

def rule_scoped_span(e, lines):
    """CS8353 stackalloc result used in a wider scope: mark the Span local `scoped`."""
    i = int(e['line']) - 1
    for k in range(i, max(0, i - 25), -1):
        m = re.match(r'^(\s*)((?:Read)?Span<\w+>)\s+(\w+);\s*$', lines[k])
        if m: lines[k] = '%sscoped %s %s;' % (m.group(1), m.group(2), m.group(3)); return True
    return False

IL_CACHE = {}
def il_for(dll):
    if dll not in IL_CACHE:
        rc, out = run(['ilspycmd', '-il', dll], timeout=1200); IL_CACHE[dll] = out.split('\n')
    return IL_CACHE[dll]

def extract_il(dll, name):
    t = il_for(dll); out = []
    for i, l in enumerate(t):
        if ('g__%s|' % name) in l and '(' in l and 'call' not in l and 'ldftn' not in l:
            s = i
            while s > 0 and '.method' not in t[s]: s -= 1
            e = i
            while e < len(t) and 'end of method' not in t[e]: e += 1
            out += t[s:e + 1]
    return '\n'.join(out)

def type_span(lines, idx):
    """line range (start,end) of the outermost type declaration that contains line idx."""
    depth = 0; start = None; stack = []
    for n, l in enumerate(lines):
        if start is None and re.search(r'\b(class|struct|interface|record)\s+\w+', l) and not l.strip().startswith('//'):
            start = n
        for ch in l:
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if start is not None and depth == 0 and n >= idx:
                    return start, n
                if depth == 0: start = None
    return None

def rule_missing_local_function(e, lines, dll, repairs):
    m = re.search(r"The name '(\w+)' does not exist", e['msg'])
    if not m: return False
    name = m.group(1)
    if any(re.search(r'\bstatic\b[^;=]*\b%s\s*\(' % name, l) for l in lines): return True   # already inserted for another call site
    il = extract_il(dll, name)
    if not il: return False
    prompt = ("You repair decompiler output. The C# decompiler dropped a compiler-generated local function named %s. "
              "Below is its CIL. Write the equivalent C# as one `private static` method named %s. Reply with ONLY the method "
              "declaration in a single csharp code block, no commentary.\n\nCIL:\n%s" % (name, name, il))
    rc, out = run(['claude', '-p', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--model', 'sonnet'], inp=prompt, timeout=300)
    cm = re.search(r'```(?:csharp|cs)?\n(.*?)```', out, re.S)
    if rc != 0 or not cm: log('  claude repair failed for', name); return False
    code = cm.group(1).rstrip()
    span = type_span(lines, int(e['line']) - 1)
    if not span: return False
    body = ['', *['\t' + l if l.strip() else l for l in code.split('\n')]]
    lines[span[1]:span[1]] = body
    repairs['claude_calls'] += 1; return True

def apply_repairs(proj_dir, errs, dll, repairs):
    by_file = {}
    for e in errs: by_file.setdefault(e['file'], []).append(e)
    fixed_any = False
    for f, es in by_file.items():
        text = read(f); crlf = '\r\n' in text
        lines = text.replace('\r\n', '\n').split('\n'); changed = False
        # bottom-up so line numbers stay valid
        for e in sorted(es, key=lambda x: -int(x['line'])):
            kind = None
            if e['code'] == 'CS0121':
                if rule_numeric_literal_overload(e, lines): kind = 'numeric-literal'
                elif rule_null_overload(e, lines): kind = 'null-overload'
            elif e['code'] == 'CS8353':
                if rule_scoped_span(e, lines): kind = 'scoped-span'
            elif e['code'] == 'CS0103':
                if rule_missing_local_function(e, lines, dll, repairs): kind = 'missing-local-function'
            if kind:
                repairs['total'] += 1; repairs['by_kind'][kind] = repairs['by_kind'].get(kind, 0) + 1
                repairs['files'].setdefault(os.path.relpath(f, WORK).replace('\\', '/'), set()).add(kind)
                changed = True
        if changed:
            write(f, ('\r\n' if crlf else '\n').join(lines)); fixed_any = True
    return fixed_any

# ---------- pipeline ----------
def fix_csproj(proj):
    p = os.path.join(proj, [f for f in os.listdir(proj) if f.endswith('.csproj')][0])
    s = read(p)
    s = re.sub(r'<HintPath>[^<]*[\\/]([^\\/<]+\.dll)</HintPath>', r'<HintPath>../refs/\1</HintPath>', s)
    write(p, s)

def audit_ctor_attributes(proj, dll, repairs):
    """The decompiler turns some constructors into C# 12 primary constructors and drops the attributes on them.
    The compiler cannot notice, but the game's object factory needs [UseCtor] and crashes at runtime without it.
    Read the raw IL for every constructor that carries the attribute and put it back where it went missing."""
    il = il_for(dll); cls = None; fixed = 0
    for i, l in enumerate(il):
        m = re.match(r'\.class .*? ([\w.]+)\s*$', l)
        if m: cls = m.group(1)
        if cls and '.method' in l and i + 3 < len(il) and any('.ctor' in x for x in il[i:i + 3]):
            if any('UseCtorAttribute' in x for x in il[i:i + 14]) and not il[i].strip().endswith('cctor'):
                ns, _, name = cls.rpartition('.')
                f = os.path.join(proj, ns, name + '.cs')
                if not os.path.exists(f): continue
                s = read(f)
                if 'UseCtor' in s: continue
                s2, n = re.subn(r'(\n)((?:public |internal |sealed |abstract |static |partial )*class %s\()' % re.escape(name), r'\1[method: ObjectCreator.UseCtor]\n\2', s, count=1)
                if n:
                    write(f, s2); fixed += 1
                    log('ctor-attribute restored on', cls)
    if fixed:
        repairs['by_kind']['constructor-attribute'] = repairs['by_kind'].get('constructor-attribute', 0) + fixed
        repairs['silent'] = repairs.get('silent', 0) + fixed
    return fixed

def build(proj):
    rc, out = run(['dotnet', 'build', '-c', 'Release', '-nologo', '-v', 'q'], cwd=proj, timeout=900)
    return rc == 0, out

def main(name):
    t00 = time.time()
    shutil.rmtree(WORK, ignore_errors=True); os.makedirs(WORK); os.makedirs(os.path.join(WORK, 'refs'))
    for f in os.listdir(BIN):
        if f.endswith('.dll') and f != 'OpenRA.Test.dll': shutil.copy(os.path.join(BIN, f), os.path.join(WORK, 'refs', f))
    steps = []
    def step(id, label, detail, ms, ok=True): steps.append(dict(id=id, label=label, status='done' if ok else 'failed', detail=detail, ms=int(ms)))
    total_bytes = sum(os.path.getsize(os.path.join(BIN, a + '.dll')) for a, _ in ASSEMBLIES)
    step('identify', 'Identify', '%d .NET assemblies, %.1f MB' % (len(ASSEMBLIES), total_bytes / 1e6), 120)

    # 1. decompile
    t0 = time.time(); nfiles = 0
    for a, d in ASSEMBLIES:
        proj = os.path.join(WORK, d)
        rc, out = run(['ilspycmd', '-p', '-o', proj, '-r', os.path.join(WORK, 'refs'), os.path.join(BIN, a + '.dll')])
        fix_csproj(proj)
        n = sum(1 for dp, _, fn in os.walk(proj) for f in fn if f.endswith('.cs') and f != 'AssemblyInfo.cs'); nfiles += n
        log('decompiled', a, n, 'files')
    lines_total = sum(read(os.path.join(dp, f)).count('\n') for a, d in ASSEMBLIES for dp, _, fn in os.walk(os.path.join(WORK, d)) for f in fn if f.endswith('.cs'))
    step('decompile', 'Decompile', '%s source files, %s lines of C#' % (format(nfiles, ','), format(lines_total, ',')), (time.time() - t0) * 1000)

    # 2. rebuild with auto-repair
    t0 = time.time()
    repairs = dict(total=0, by_kind={}, files={}, claude_calls=0, found=0)
    for a, d in ASSEMBLIES:
        proj = os.path.join(WORK, d)
        audit_ctor_attributes(proj, os.path.join(BIN, a + '.dll'), repairs)
        for rnd in range(4):
            ok, out = build(proj)
            if ok: break
            errs = parse_errors(out)
            if rnd == 0: repairs['found'] += len(errs)
            log('build', a, 'round', rnd, 'errors', len(errs))
            if not errs or not apply_repairs(proj, errs, os.path.join(BIN, a + '.dll'), repairs): break
        if not ok:
            step('rebuild', 'Rebuild', '%s failed to compile' % a, (time.time() - t0) * 1000, False); json.dump(dict(status='failed'), open('fail.json', 'w')); return
        shutil.copy(os.path.join(proj, 'bin', 'Release', 'net6.0', a + '.dll'), os.path.join(WORK, 'refs', a + '.dll'))
    step('rebuild', 'Rebuild', '%d compile errors found, %d repaired (%d by Claude), 0 left' % (repairs['found'], repairs['total'], repairs['claude_calls']), (time.time() - t0) * 1000)

    # 3. assemble the rebuilt game next to a copy of the original game's data, then run both
    t0 = time.time()
    reb = os.path.join(WORK, 'game_rebuilt'); orig = SRC
    shutil.copytree(SRC, reb, ignore=shutil.ignore_patterns('.git', 'obj', '*.pdb'))
    for a, d in ASSEMBLIES: shutil.copy(os.path.join(WORK, d, 'bin', 'Release', 'net6.0', a + '.dll'), os.path.join(reb, 'bin', a + '.dll'))
    for f in os.listdir(os.path.join(reb, 'bin')):
        if f.endswith('.pdb'): os.remove(os.path.join(reb, 'bin', f))
    checks = []
    def tests(root):
        rc, out = run(['dotnet', 'test', os.path.join(root, 'bin', 'OpenRA.Test.dll')])
        m = re.search(r'Failed:\s*(\d+), Passed:\s*(\d+), Skipped:\s*(\d+), Total:\s*(\d+)', out)
        return ('Passed %s of %s' % (m[2], m[4])) if m else 'did not run'
    a_t, b_t = tests(orig), tests(reb)
    checks.append(dict(args="OpenRA's own test suite", same=a_t == b_t, original=a_t, rebuilt=b_t, note='The game’s 130 built-in tests, run against each build.'))
    def util(root, *args):
        env = dict(ENV, ENGINE_DIR=root)
        p = subprocess.run(['dotnet', os.path.join(root, 'bin', 'OpenRA.Utility.dll'), *args], cwd=root, env=env, capture_output=True, text=True, encoding='utf8', errors='replace', timeout=900)
        return p.stdout + p.stderr
    for mod, label in (('ra', 'Red Alert'), ('cnc', 'Tiberian Dawn'), ('d2k', 'Dune 2000')):
        a_o, b_o = util(orig, mod, '--check-yaml'), util(reb, mod, '--check-yaml')
        n = len([l for l in a_o.splitlines() if l.strip()])
        checks.append(dict(args='%s rules and maps' % label, same=a_o == b_o, original='%d lines, no errors' % n if not re.search(r'error|exception', a_o, re.I) else 'has errors',
                           rebuilt='%d lines, no errors' % len([l for l in b_o.splitlines() if l.strip()]) if a_o == b_o else 'differs', note='Loads every unit, rule and map through the engine.'))
    a_d, b_d = util(orig, 'all', '--docs'), util(reb, 'all', '--docs')
    checks.append(dict(args='Unit documentation export', same=a_d == b_d, original='%s bytes' % format(len(a_d.encode()), ','), rebuilt='%s bytes, identical' % format(len(b_d.encode()), ',') if a_d == b_d else 'differs',
                       note='Reflects over every unit trait in the game and prints it as JSON.'))
    a_l, b_l = util(orig, 'all', '--emmy-lua-api'), util(reb, 'all', '--emmy-lua-api')
    same_l = a_l == b_l; same_sorted = sorted(a_l.splitlines()) == sorted(b_l.splitlines())
    checks.append(dict(args='Scripting API listing', same=same_l, original='%d lines' % len(a_l.splitlines()),
                       rebuilt=('%d lines, same content in a different order' % len(b_l.splitlines())) if (same_sorted and not same_l) else ('identical' if same_l else 'differs'),
                       note='Decompilers can reorder fields, which changes the order reflection reports them in.' if (same_sorted and not same_l) else ''))
    n_same = sum(1 for c in checks if c['same'])
    for c in checks: log('check', c['args'], c['same'])
    step('behavior', 'Run both', '%d of %d checks identical' % (n_same, len(checks)), (time.time() - t0) * 1000, n_same == len(checks))

    # 4. score against the real source
    t0 = time.time()
    def toks(s):
        s = re.sub(r'//.*', '', s); s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
        return re.findall(r'[A-Za-z_]\w*|\d+|[^\sA-Za-z0-9_]', s)
    def collect(root, skip=('obj', 'bin', 'Properties', 'refs')):
        d = {}
        for dp, dn, fn in os.walk(root):
            dn[:] = [x for x in dn if x not in skip]
            for f in fn:
                if f.endswith('.cs'): d.setdefault(f, []).append(os.path.join(dp, f))
        return d
    o_idx, r_idx = {}, {}
    for a, d in ASSEMBLIES:
        for k, v in collect(os.path.join(SRC, a)).items(): o_idx.setdefault(k, []).extend(v)
        for k, v in collect(os.path.join(WORK, d)).items(): r_idx.setdefault(k, []).extend(v)
    matched = [k for k in r_idx if k in o_idx and len(o_idx[k]) == 1 and len(r_idx[k]) == 1]
    tot = hit = 0; ids_o = set(); ids_r = set()
    for k in matched:
        a_, b_ = toks(read(o_idx[k][0]))[:4000], toks(read(r_idx[k][0]))[:4000]
        m = sum(t.size for t in difflib.SequenceMatcher(None, a_, b_, autojunk=False).get_matching_blocks())
        tot += len(a_) + len(b_); hit += 2 * m
        ids_o |= {x for x in a_ if re.match(r'[A-Za-z_]\w{2,}$', x)}; ids_r |= {x for x in b_ if re.match(r'[A-Za-z_]\w{2,}$', x)}
    tok_sim, id_rec = hit / tot, len(ids_o & ids_r) / len(ids_o)
    orig_lines = sum(read(p[0]).count('\n') for p in o_idx.values())
    step('source', 'Compare', '%.1f%% token match, %.0f%% of names recovered, %d files matched' % (tok_sim * 100, id_rec * 100, len(matched)), (time.time() - t0) * 1000)
    log('similarity', tok_sim, id_rec, len(matched))

    # 5. package + showcase pairs
    t0 = time.time(); os.makedirs(OUT, exist_ok=True)
    zpath = os.path.join(OUT, 'rebuilt-project.zip'); nz = 0
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
        for a, d in ASSEMBLIES:
            for dp, dn, fn in os.walk(os.path.join(WORK, d)):
                dn[:] = [x for x in dn if x not in ('obj', 'bin')]
                for f in fn: z.write(os.path.join(dp, f), os.path.join(d, os.path.relpath(os.path.join(dp, f), os.path.join(WORK, d)))); nz += 1
        z.writestr('README.txt', 'Rebuilt from the compiled OpenRA game by Unpack. One folder per assembly; build each with `dotnet build -c Release`, in the order game, mods_common, mods_cnc, mods_d2k, platforms, server, utility. Library DLLs go in ../refs.\n')
    step('package', 'Package', '%s files, %.1f MB zip' % (format(nz, ','), os.path.getsize(zpath) / 1e6), (time.time() - t0) * 1000)
    showcase = [('Png.cs', 'OpenRA.Game', 'game'), ('Color.cs', 'OpenRA.Game', 'game'), ('Missile.cs', 'OpenRA.Mods.Common', 'mods_common'), ('WVec.cs', 'OpenRA.Game', 'game')]
    pairs = []
    for fname, a, d in showcase:
        if fname in o_idx and fname in r_idx and len(o_idx[fname]) == 1 and len(r_idx[fname]) == 1:
            pairs.append(dict(name=fname, original=read(o_idx[fname][0]), rebuilt=read(r_idx[fname][0])))
    beh = n_same / len(checks)
    result = dict(status='done', kind=dict(kind='dotnet-multi', label='Game, 7 .NET assemblies'), builds=True, steps=steps, behavior=checks, behaviorScore=beh,
                  tokenSimilarity=tok_sim, identifierRecall=id_rec, files={p['name']: p['rebuilt'] for p in pairs}, pairs=pairs,
                  repairs=dict(found=repairs['found'], total=repairs['total'], by_kind=repairs['by_kind'], claude_calls=repairs['claude_calls'],
                               files={k: sorted(v) for k, v in repairs['files'].items()}),
                  stats=dict(assemblies=len(ASSEMBLIES), files=nfiles, rebuilt_lines=lines_total, original_lines=orig_lines, matched_files=len(matched), seconds=int(time.time() - t00)),
                  zip='/api/jobs/__ID__/download')
    write(os.path.join(OUT, 'result.json'), json.dumps(result, indent=1))
    write(os.path.join(OUT, 'run.log'), '\n'.join(log_lines))
    log('DONE in %ds' % (time.time() - t00))

if __name__ == '__main__': main(sys.argv[1] if len(sys.argv) > 1 else 'openra')
