// The console half of an entity-notes build.
//
// campaign/entity-notes.js does the run and emits events; this turns them into
// the output the three builders have always printed. It lives here rather than
// in the module because the pipeline calls the same run and has no console to
// print to — and because printing from inside the run is what made the run
// impossible to test.
//
// Every line below appeared in at least one of the three original scripts. The
// point of collecting them is that now they appear in all three.
export function renderEntityRun({ noun, model = null }) {
  const pad = (s, n) => String(s).padEnd(n);

  return function render(event) {
    switch (event.type) {
      case 'start':
        console.log(`campaign : ${event.campaignName} -> ${event.folder}/`);
        if (model) console.log(`model    : ${model}`);
        console.log(`sessions : ${event.sessions.join(', ')}`);
        console.log(
          event.ledgerEmpty
            ? '⚠️  ledger is empty here — pull it from Drive first or aliases will not be reconciled\n'
            : `existing : ${event.existingNames.join(', ')}\n`
        );
        break;

      case 'cache-hit':
        console.log(`cache    : reusing ${event.path} (no API calls)\n`);
        break;

      case 'cache-saved':
        console.log(`cache    : saved raw extraction to ${event.path}`);
        break;

      case 'session-skipped':
        console.log(`session ${event.sessionNumber}: ${event.reason}, skipped`);
        break;

      case 'session-start':
        process.stdout.write(
          `session ${event.sessionNumber}: ${event.lines} lines (${Math.round(event.bytes / 1024)}KB) … `
        );
        break;

      case 'session-done':
        console.log(`${event.count} ${noun}(s) in ${Math.round(event.elapsedMs / 1000)}s`);
        if (event.unparsed) console.log(`  (unparsed response began: ${event.unparsed}…)`);
        break;

      case 'session-failed':
        console.log(`FAILED (${event.message})`);
        break;

      case 'unresolved':
        console.log(
          `\n⚠️  ${event.names.length} existing name(s) could not be matched to exactly one ${noun}, so ` +
            `links to them will not resolve:\n   ${event.names.join(', ')}`
        );
        break;

      case 'unmatched':
        console.log(
          `\nignored (matched nobody on the roster): ` +
            event.records.map((u) => `${u.name} (s${u.sessionNumber})`).join(', ')
        );
        break;

      case 'missing':
        console.log(`\n⚠️  no note built for: ${event.names.join(', ')} — nothing found in the transcripts`);
        break;

      case 'unusable-name':
        console.log(`  (skipped a ${noun} whose name produced no usable filename: ${JSON.stringify(event.name)})`);
        break;

      case 'record':
        console.log(`  ${pad(event.record.name, 24)} ${event.detail}`);
        if (event.record.aliases?.length) {
          console.log(`  ${pad('', 24)} aliases: ${event.record.aliases.join(', ')}`);
        }
        break;

      case 'finished':
        console.log(
          event.write
            ? `\nWrote ${event.written} note(s) to ${event.outDir}`
            : '\nDry run — re-run with --write to create the notes.'
        );
        break;

      default:
        break;
    }
  };
}

// The flags every builder shares. Subject-specific ones stay in their script.
export function commonArgs(argv) {
  const args = argv.slice(2);
  const flag = (name, fallback = null) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };
  return {
    args,
    flag,
    flagAll: (name) => args.map((a, i) => (a === name ? args[i + 1] : null)).filter(Boolean),
    which: args.find((a) => !a.startsWith('--') && !args.some((f, i) => f.startsWith('--') && args[i + 1] === a)),
    write: args.includes('--write'),
    json: args.includes('--json'),
    cachePath: flag('--cache'),
    // The configured summariser is a budget model chosen for cheap recaps.
    // Reading 4,000 lines of raw transcript for character detail is a different
    // job, so this defaults to a stronger one without touching SUMMARY_PROVIDER.
    //
    // Flash rather than Pro deliberately: every Pro model returns
    // "limit: 0 ... free_tier" on this key, so Pro is not merely throttled, it
    // is unavailable. Note also that gemini-3.6-flash is NOT in the ListModels
    // response but does serve requests — don't trust that listing to decide
    // what exists.
    model: flag('--model', 'gemini-3.6-flash'),
  };
}
