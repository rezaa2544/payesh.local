'use strict';

// CI negative control: inject a temporary regression only into the isolated
// server child, then prove that the ordinary pull-leak test turns red.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-pl57-negative-'));
const preload = path.join(temp, 'inject-leak.cjs');
const preloadSource = `'use strict';
const path = require('node:path');
const root = process.env.PAYESH_TEST_ROOT;
const entry = path.resolve(process.argv[1] || '');
if (process.env.PAYESH_NEGATIVE_LEAK === '1' && entry === path.join(root, 'server', 'index.js')) {
  const policy = require(path.join(root, 'server', 'policy.js'));
  policy.scrubUser = (row) => ({ ...(row || {}) });
  policy.scrubUserFor = (_viewer, row) => ({ ...(row || {}) });
  policy.scrubUserIdentity = (row) => ({ ...(row || {}) });
}
`;

try {
  fs.writeFileSync(preload, preloadSource, { mode: 0o600 });
  const env = {
    ...process.env,
    PAYESH_TEST_ROOT: root,
    PAYESH_NEGATIVE_LEAK: '1',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
  };
  const result = spawnSync(process.execPath, [path.join(__dirname, 'pull-leak-57.js')], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);

  const expectedDetection = /FAIL\s+PL-1[012]\b/.test(output)
    && output.includes('PULL-LEAK-57-FAILED');
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error('ordinary pull-leak test passed despite injected secret-field leak');
  }
  if (!expectedDetection) {
    throw new Error(`test failed without a matching PL-10/11/12 leak assertion (exit=${result.status})`);
  }
  console.log(`NEGATIVE-LEAK-CONTROL-OK expected_exit_nonzero=${result.status} leak_assertion=detected`);
} catch (error) {
  console.error(`NEGATIVE-LEAK-CONTROL-FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
