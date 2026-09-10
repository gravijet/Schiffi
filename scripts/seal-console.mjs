/**
 * Fold the superadmin console into a single file, then delete its pieces.
 *
 * The console is served by the server to one account. Its *chunks*, though,
 * would be ordinary files under /assets/ - and a file under /assets/ is served
 * to anyone who knows its name. The names carry content hashes and nothing
 * public links to them, but "nobody can guess it" is a weaker promise than
 * "it is not there", and the requirement here is the strong one.
 *
 * So after the build the console's own script and stylesheet are inlined into
 * console.html and their files are removed from dist. What remains under
 * /assets/ is only what the public site already ships.
 *
 * Run automatically by `npm run build`.
 */
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../client/dist');
const PAGE = join(DIST, 'console.html');

const html = await readFile(PAGE, 'utf8').catch(() => null);
if (html === null) {
  console.error('[seal-console] client/dist/console.html is missing - was the client built?');
  process.exit(1);
}

const removed = [];
let out = html;

// The entry script. Its own imports stay external (they are chunks the public
// site ships too), so the relative specifier has to become an absolute one.
const scriptTag = /<script type="module"[^>]*src="\/assets\/(console\.[^"]+\.js)"[^>]*><\/script>/;
const scriptMatch = scriptTag.exec(out);
if (scriptMatch) {
  const file = join(DIST, 'assets', scriptMatch[1]);
  const code = (await readFile(file, 'utf8')).replace(/from"\.\//g, 'from"/assets/');
  out = out.replace(scriptTag, `<script type="module">${code}</script>`);
  removed.push(file);
}

// Its stylesheet. Shared stylesheets (dom.css) are left as links.
const styleTag = /<link rel="stylesheet"[^>]*href="\/assets\/(console\.[^"]+\.css)"[^>]*>/;
const styleMatch = styleTag.exec(out);
if (styleMatch) {
  const file = join(DIST, 'assets', styleMatch[1]);
  out = out.replace(styleTag, `<style>${await readFile(file, 'utf8')}</style>`);
  removed.push(file);
}

if (!removed.length) {
  console.error('[seal-console] found nothing to inline - the build output changed shape');
  process.exit(1);
}

await writeFile(PAGE, out);
for (const file of removed) await unlink(file);

console.log(`[seal-console] inlined ${removed.length} file(s); console.html is now self-contained`);
