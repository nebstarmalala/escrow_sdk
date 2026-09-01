// Fails if src/Types.php is out of date with the spec.
//
// Same guard as the TypeScript package's, pointed at the PHP shapes. Without it
// the generated file silently rots the first time the spec moves, and PHPStan
// goes on cheerfully checking arrays against a contract the API no longer has.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const committed = resolve(here, '../src/Types.php');
const generator = resolve(here, 'generate-types.mjs');

const before = readFileSync(committed, 'utf8');
const backup = committed + '.bak';
writeFileSync(backup, before);

try {
  execFileSync(process.execPath, [generator], { stdio: 'pipe' });
  const after = readFileSync(committed, 'utf8');

  if (normalize(before) !== normalize(after)) {
    // Put the committed file back so a failed check does not leave a dirty
    // tree behind - a check that mutates the repo is a check people stop
    // running.
    writeFileSync(committed, before);
    console.error(
      [
        'src/Types.php is out of date with shared/partner-openapi.yaml.',
        '',
        'Run:  node scripts/generate-types.mjs',
        'and commit the result.',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log('generated PHP types ok');
} finally {
  rmSync(backup, { force: true });
}

// Line endings differ between a Windows checkout and Linux CI; that is not drift.
function normalize(s) {
  return s.replace(/\r\n/g, '\n').trimEnd();
}
