export const out = (text = '') => process.stdout.write(text + '\n');
export const err = (text = '') => process.stderr.write(text + '\n');
export const printJson = (value) => out(JSON.stringify(value, null, 2));
