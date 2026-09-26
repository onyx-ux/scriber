// The dashboard as one string: index.html followed by every stylesheet and
// script it loads from /dash/, in the order it loads them.
//
// The page was one file until 2026-09-27 and several tests read its text to
// check what it draws. It is now a short index.html, dash/app.css and ten
// classic scripts under dash/app/ (see ADR-0002), and those tests read this
// instead, so they keep checking the whole page rather than the shell.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const DASHBOARD_DIR = fileURLToPath(new URL('../../../dashboard/html/', import.meta.url));

export async function dashboardSource(page = 'index.html') {
  const html = await readFile(join(DASHBOARD_DIR, page), 'utf8');
  const refs = [
    ...html.matchAll(/<link rel="stylesheet" href="\/(dash\/[^"]+\.css)">|<script src="\/(dash\/[^"]+\.js)"><\/script>/g),
  ].map((m) => m[1] ?? m[2]);
  const parts = await Promise.all(refs.map((ref) => readFile(join(DASHBOARD_DIR, ref), 'utf8')));
  return [html, ...parts].join('\n');
}
