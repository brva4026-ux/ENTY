#!/usr/bin/env node
// Gate de diseno: corre el lint del skill de diseno (design-taste-frontend) con
// la allowlist de marca del proyecto y falla si aparece cualquier hallazgo NUEVO.
//
//   node scripts/design-gate.mjs [--update] [--json]
//
// El lint del skill banea ~560 cosas en este repo, pero casi todas son la
// identidad deliberada de TicketFlow (azul de marca, gradientes del shell
// nocturno, glass, sombras de overlay, emoji de la demo). La allowlist de marca
// esta en design-gate.baseline.json con el motivo de cada una.
//
// El gate no es un "allowlist" que deje pasar: es un TRIQUETE. Los conteos
// actuales estan aceptados, pero crecer en cualquier regla falla, y una regla
// que no este en el baseline tambien falla. Asi el numero solo puede bajar.
//
// El skill vive en .agents/ (gitignored: "skills locales de la sesion"), asi que
// en CI este gate se salta con un aviso. Para correrlo en CI habria que vendorizar
// el skill en el repo.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '..');
const repo = resolve(frontend, '..');
const baselinePath = join(here, 'design-gate.baseline.json');

const args = process.argv.slice(2);
const update = args.includes('--update');
const asJson = args.includes('--json');

// El skill puede estar en el repo o en un checkout aparte (TASTE_SKILL_DIR).
const skillDir = process.env.TASTE_SKILL_DIR
  ? resolve(process.env.TASTE_SKILL_DIR)
  : join(repo, '.agents', 'skills', 'design-taste-frontend');
const linter = join(skillDir, 'scripts', 'lint.mjs');

if (!existsSync(linter)) {
  // En CI el skip se hace visible como anotacion (amarillo en el PR), para que
  // no pase por un verde real. Un gate que no puede fallar no es un gate.
  const inCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const msg = `design-gate NO VERIFICO: el skill de diseno no esta instalado (${linter}).`;
  if (inCi) console.log(`::warning title=design-gate::${msg}`);
  console.log(`[design-gate] SKIP: ${msg}`);
  console.log('[design-gate] Es una skill local de sesion (.agents/ esta en .gitignore).');
  console.log('[design-gate] Para que verifique en CI, vendoriza el skill (o define TASTE_SKILL_DIR).');
  process.exit(0);
}

const run = spawnSync(process.execPath, [linter, 'frontend/src', '--app', '--json'], {
  cwd: repo,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (run.error) {
  console.error(`[design-gate] no se pudo correr el linter: ${run.error.message}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error('[design-gate] el linter no devolvio JSON parseable.');
  console.error(run.stdout?.slice(0, 400) || '(sin salida)');
  console.error(run.stderr?.slice(0, 400) || '');
  process.exit(2);
}

const counts = {};
for (const f of report.findings) counts[f.id] = (counts[f.id] || 0) + 1;

const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, 'utf8'))
  : { allowed: {}, brand: {} };

if (update) {
  const next = { note: baseline.note, allowed: counts, brand: baseline.brand || {} };
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  console.log(`[design-gate] baseline actualizado: ${Object.keys(counts).length} reglas, ${report.findings.length} hallazgos.`);
  process.exit(0);
}

const allowed = baseline.allowed || {};
const brand = baseline.brand || {};

// Una regla nueva (que no estaba en el baseline) siempre falla: o es un defecto
// real, o es marca nueva y hay que justificarla y anotarla con --update.
const regressions = [];
const improvements = [];
for (const [id, n] of Object.entries(counts)) {
  const max = allowed[id];
  if (max === undefined) regressions.push({ id, found: n, allowed: 0, isNew: true });
  else if (n > max) regressions.push({ id, found: n, allowed: max, isNew: false });
}
for (const [id, max] of Object.entries(allowed)) {
  const n = counts[id] || 0;
  if (n < max) improvements.push({ id, found: n, allowed: max });
}

if (asJson) {
  console.log(JSON.stringify({ total: report.findings.length, regressions, improvements }, null, 2));
} else {
  const total = report.findings.length;
  const totalAllowed = Object.values(allowed).reduce((a, b) => a + b, 0);
  console.log(`[design-gate] ${total} hallazgos (presupuesto ${totalAllowed}).`);
  if (improvements.length) {
    console.log('\nMEJORAS (baja el baseline con --update para fijarlas):');
    for (const i of improvements) console.log(`  - ${i.id}: ${i.found} (baseline ${i.allowed})`);
  }
  if (regressions.length) {
    console.log('\nFALLOS:');
    for (const r of regressions) {
      const why = brand[r.id];
      const tag = r.isNew ? 'REGLA NUEVA' : `crecio ${r.allowed} -> ${r.found}`;
      console.log(`  - ${r.id}: ${tag}`);
      if (why) console.log(`      marca aceptada: ${why}`);
    }
    console.log('\n[design-gate] FAIL. Si el hallazgo es marca deliberada, documentalo en');
    console.log('              design-gate.baseline.json y corre con --update. Si no, arreglalo.');
  } else {
    console.log('[design-gate] OK: sin hallazgos nuevos.');
  }
}

process.exit(regressions.length ? 1 : 0);
