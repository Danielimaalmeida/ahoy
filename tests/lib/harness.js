'use strict';
// Shared scaffolding for the Node test suite.
//
// The property that makes this suite worth anything is that it runs OFFLINE:
// no network, no credentials, no model. `gh` is stubbed at the seam gates/lib.sh
// already had (HARNESS_GH_BIN), which is what lets the exit-code contract be
// tested rather than asserted in a README.
//
// The gates themselves are still bash, and these tests still run the real
// gates/*.sh. That is deliberate: the exit-code contract does not care what
// language calls it, and a test that ran a JavaScript imitation of a gate would
// be testing the imitation.
//
// ONE WORKSPACE PER TEST, always torn down by the caller's `after`.
//
// The bash suite shared a workspace variable across assertions and deleted it
// inside its own `expect`, so the two assertions following a delete ran `cd`
// into a directory that no longer existed. One of them exited 1 — which
// happened to be the code it wanted — and reported a green line meaning
// "nothing ran". Here a workspace is a value, not a global, and it cannot be
// deleted out from under the next assertion.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TESTS_DIR = path.resolve(__dirname, '..');
const SRC_ROOT = path.resolve(TESTS_DIR, '..');
const GH_STUB = path.join(TESTS_DIR, 'bin', 'gh');

const STORY = 'PROJ-1';

try { fs.chmodSync(GH_STUB, 0o755); } catch { /* already executable, or a filesystem without modes */ }

class Workspace {
  constructor(dir) {
    this.dir = dir;
    this.story = STORY;
  }

  get statePath() { return path.join(this.dir, 'specs', STORY, 'state.json'); }
  get stubDir() { return path.join(this.dir, 'stub'); }
  path(...parts) { return path.join(this.dir, ...parts); }

  readState() { return JSON.parse(fs.readFileSync(this.statePath, 'utf8')); }
  writeState(obj) { this.write(path.join('specs', STORY, 'state.json'), JSON.stringify(obj, null, 2) + '\n'); }
  patchState(fn) { const s = this.readState(); fn(s); this.writeState(s); }

  write(rel, contents) {
    const p = path.isAbsolute(rel) ? rel : this.path(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
    return p;
  }

  readJSON(rel) { return JSON.parse(fs.readFileSync(this.path(rel), 'utf8')); }
  writeJSON(rel, obj) { return this.write(rel, JSON.stringify(obj, null, 2) + '\n'); }

  // Copy harness scripts in, so a test exercises the real command by the real
  // name. The .sh shim and its .js implementation travel together, and so does
  // bin/lib/, because a shim with nothing behind it is not the shipping script.
  installBin(...names) {
    fs.mkdirSync(this.path('bin'), { recursive: true });
    copyDir(path.join(SRC_ROOT, 'bin', 'lib'), this.path('bin', 'lib'));
    for (const name of names) {
      const base = name.replace(/\.(sh|js)$/, '');
      for (const ext of ['.sh', '.js']) {
        const src = path.join(SRC_ROOT, 'bin', base + ext);
        if (!fs.existsSync(src)) continue;
        const dst = this.path('bin', base + ext);
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o755);
      }
    }
    return this;
  }

  installTable() {
    fs.mkdirSync(this.path('knowledge', 'process'), { recursive: true });
    for (const f of ['phases.tsv', 'state.template.json']) {
      const src = path.join(SRC_ROOT, 'knowledge', 'process', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, this.path('knowledge', 'process', f));
    }
    return this;
  }

  env(extra = {}) {
    return {
      ...process.env,
      HARNESS_GH_BIN: GH_STUB,
      HARNESS_GH_HOST: 'stub.invalid',
      STUB_GH_DIR: this.stubDir,
      STUB_GH_AUTH: '0',
      // The gates resolve the repository root via `git rev-parse
      // --show-toplevel`, which follows the CURRENT DIRECTORY. Pinning both
      // keeps a gate from resolving specs/<STORY>/state.json inside whatever
      // repository the suite happens to be run from.
      GIT_DIR: this.path('.git'),
      GIT_WORK_TREE: this.dir,
      ...extra,
    };
  }

  // Run a command inside the sandbox and return {code, out}. Never throws on a
  // non-zero exit: the exit code is the thing under test.
  run(cmd, args = [], opts = {}) {
    const r = spawnSync(cmd, args, {
      cwd: opts.cwd || this.dir,
      env: this.env(opts.env),
      encoding: 'utf8',
      input: opts.input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (r.error) return { code: 127, out: r.error.message, stdout: '', stderr: r.error.message };
    return {
      code: r.status === null ? 1 : r.status,
      out: (r.stdout || '') + (r.stderr || ''),
      stdout: r.stdout || '',
      stderr: r.stderr || '',
    };
  }

  gate(script, ...args) { return this.run(this.path('gates', script), args); }
  bin(script, ...args) { return this.run(this.path('bin', script), args); }

  destroy() {
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// A throwaway git repo, so gate_repo_root resolves and rework_ceiling's state
// writes cannot touch anything real.
function newWorkspace() {
  // realpath, because on macOS mktemp hands back a /var symlink into /private
  // and `git rev-parse --show-toplevel` reports the resolved form. Comparing
  // the two unresolved is how the sandbox guard below produces false alarms.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ahoy-test-')));
  const ws = new Workspace(dir);

  fs.mkdirSync(path.join(dir, 'gates'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs', STORY), { recursive: true });
  fs.mkdirSync(path.join(dir, 'stub'), { recursive: true });

  for (const f of fs.readdirSync(path.join(SRC_ROOT, 'gates'))) {
    if (!f.endsWith('.sh')) continue;
    const dst = path.join(dir, 'gates', f);
    fs.copyFileSync(path.join(SRC_ROOT, 'gates', f), dst);
    fs.chmodSync(dst, 0o755);
  }

  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });

  // Refuse to proceed unless the gates will resolve INTO the sandbox. Without
  // this the suite silently points every gate at the real repository.
  const resolved = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: dir, encoding: 'utf8', env: ws.env(),
  }).stdout.trim();
  if (fs.realpathSync(resolved) !== dir) {
    ws.destroy();
    throw new Error(`sandbox ${dir} resolves to ${resolved}; refusing to run`);
  }

  // Sane defaults; individual cases overwrite what they care about.
  ws.write('stub/pr-list.json', '[{"number":42}]');
  ws.write('stub/pr.json', JSON.stringify({
    state: 'OPEN',
    isDraft: false,
    headRefOid: 'aaa111',
    url: 'https://gh/x/y/pull/42',
    body: 'Implements PROJ-1 end to end.',
    statusCheckRollup: [
      { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u' },
    ],
  }, null, 2));
  ws.write('stub/diff.patch', '+  it("renders the due date", () => {});\n');

  return ws;
}

module.exports = { newWorkspace, Workspace, SRC_ROOT, TESTS_DIR, GH_STUB, STORY };
