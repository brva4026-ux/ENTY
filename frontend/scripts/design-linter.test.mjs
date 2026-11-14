import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('detects decorative effects but preserves comments, focus and native controls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enty-design-'));
  try {
    writeFileSync(join(dir, 'fixture.css'), `
/* Never use linear-gradient() and scale(0) on a card. */
.card { background: linear-gradient(red, blue); }
.card { box-shadow: 0 4px 8px black; }
.card { transform: scale(0); }
.control:focus-visible { box-shadow: 0 0 0 3px blue; }
.checkbox::before { transform: scale(0); }
.reset { box-shadow: none; backdrop-filter: none; }
`);
    const run = spawnSync(process.execPath, ['scripts/vendor/design-taste/lint.mjs', dir, '--app', '--json'], { encoding: 'utf8' });
    const ids = JSON.parse(run.stdout).findings.map(f => f.id).sort();
    assert.deepEqual(ids, ['gradient', 'scale-zero', 'shadow']);
    assert.equal(run.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
