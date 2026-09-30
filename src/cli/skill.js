import { ErrorType, JevAnswersError } from '../errors.js';
import { detectTargets, install, location, parseTargets, render, status, TARGETS, uninstall } from '../skill.js';
import { parse } from './args.js';
import { out } from './output.js';

const USAGE = 'Usage: jev-answers skill install|uninstall|status|show [--target claude,agents] [--project] [--force]';

export async function run(argv) {
  const [action, ...rest] = argv;
  if (!['install', 'uninstall', 'status', 'show'].includes(action)) {
    throw new JevAnswersError(ErrorType.INVALID_INPUT, USAGE);
  }
  const { values } = parse(
    rest,
    { target: { type: 'string' }, project: { type: 'boolean', default: false }, force: { type: 'boolean', default: false } },
    { allowPositionals: false },
  );

  if (action === 'show') {
    process.stdout.write(await render());
    return 0;
  }
  const locate = (target) => location(target, { project: values.project });

  if (action === 'status') {
    for (const project of [false, true]) {
      for (const target of Object.keys(TARGETS)) {
        const loc = location(target, { project });
        if (project && loc.dir === location(target).dir) continue; // cwd is the home directory
        out(`${loc.display.padEnd(36)} ${await status(loc)}`);
      }
    }
    return 0;
  }

  let targets;
  if (values.target) targets = parseTargets(values.target);
  else if (action === 'install') targets = detectTargets().length ? detectTargets() : Object.keys(TARGETS);
  else targets = Object.keys(TARGETS);

  let code = 0;
  for (const target of targets) {
    const loc = locate(target);
    try {
      if (action === 'install') out(`${await install(loc, { force: values.force })}: ${loc.file}`);
      else {
        const result = await uninstall(loc);
        out(result === 'removed' ? `removed: ${loc.file}` : `not installed: ${loc.file}`);
      }
    } catch (err) {
      if (!(err instanceof JevAnswersError) || err.type !== ErrorType.SKILL_CONFLICT) throw err;
      out(`skipped: ${err.message}`);
      code = 1;
    }
  }
  return code;
}
