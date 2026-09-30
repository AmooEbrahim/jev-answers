import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, redact } from '../config.js';
import { ask } from '../pipeline.js';
import { sessionsDir } from '../session.js';
import { location, status as skillStatus, TARGETS } from '../skill.js';
import { parse } from './args.js';
import { out } from './output.js';

async function checkHome(config) {
  try {
    await fs.mkdir(sessionsDir(config), { recursive: true, mode: 0o700 });
    const probe = path.join(sessionsDir(config), `.doctor-${process.pid}`);
    await fs.writeFile(probe, '');
    await fs.rm(probe);
    return null;
  } catch (err) {
    return err.message;
  }
}

export async function run(argv) {
  const { values: flags } = parse(argv, { live: { type: 'boolean', default: false } }, { allowPositionals: false });
  const { values, sources, file } = loadConfig();
  const shown = redact(values);

  out(`Config file: ${file}`);
  for (const key of Object.keys(sources)) {
    out(`  ${key.padEnd(20)} ${String(shown[key]).padEnd(40)} (${sources[key]})`);
  }
  let ok = true;

  const homeProblem = await checkHome(values);
  out(homeProblem ? `FAIL  session folder ${sessionsDir(values)} is not writable: ${homeProblem}` : `ok    session folder ${sessionsDir(values)} is writable`);
  ok &&= !homeProblem;

  for (const project of [false, true]) {
    for (const target of Object.keys(TARGETS)) {
      const loc = location(target, { project });
      if (project && loc.dir === location(target).dir) continue; // cwd is the home directory
      const state = await skillStatus(loc);
      if (!project || state !== 'not installed') out(`skill ${loc.display}: ${state}`);
    }
  }

  if (!values.api_key) {
    out('FAIL  no API key configured (run "jev-answers setup")');
    ok = false;
  }

  if (flags.live && ok) {
    const started = Date.now();
    const result = await ask(
      { label: 'doctor', context: 'The sky is blue.', questions: { ping: { type: 'noul', instructions: 'Is the sky blue?' } } },
      { config: values },
    );
    const ms = Date.now() - started;
    if (result.status === 'ok') {
      out(`ok    live request succeeded in ${ms} ms (model ${result.response.model ?? values.model})`);
    } else {
      out(`FAIL  live request failed after ${ms} ms: ${result.error.type}: ${result.error.message}`);
      ok = false;
    }
    if (result.session) out(`      session: ${result.session}`);
  }
  return ok ? 0 : 1;
}
