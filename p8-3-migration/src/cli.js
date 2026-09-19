// P8-3 WP3 CLI entry.
// Usage:
//   node src/cli.js --dry-run --dump ./dump        # dry-run from 1.0 JSON export
//   node src/cli.js --dump ./dump --batch B1       # run a single batch (B1) on MemoryTarget
//   node src/cli.js --dump ./dump                  # full run on MemoryTarget (NOT production D1)
//
// Production execution uses D1Target bound to env.DB; that path is wired but NOT invoked here
// (no D1 binding / credentials in this repo). WP3 = implement scripts only; no production execution.
import { runMigration } from './runner.js';
import { FixtureSource, DumpSource, MemoryTarget } from './adapters.js';
import { FileCheckpoint } from './checkpoint.js';
import { createLogger } from './logger.js';

function parseArgs(argv) {
  const a = { dryRun: false, batch: null, seed: 1, dump: null, checkpoint: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--batch') a.batch = argv[++i];
    else if (x === '--seed') a.seed = Number(argv[++i]);
    else if (x === '--dump') a.dump = argv[++i];
    else if (x === '--checkpoint') a.checkpoint = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger({ console: true });

  let source;
  if (args.dump) {
    const fs = await import('node:fs');
    source = new DumpSource(args.dump, fs);
  } else {
    // No dump -> empty fixture (safe no-op). Provide --dump for real data.
    source = new FixtureSource({});
    logger.warn('no_dump', { msg: 'No --dump provided; running on empty source. Pass --dump <dir> for 1.0 data.' });
  }

  const target = new MemoryTarget();
  const checkpoint = args.checkpoint ? new FileCheckpoint(args.checkpoint) : null;

  const { stats } = await runMigration({
    source,
    target,
    opts: { dryRun: args.dryRun, batch: args.batch, seed: args.seed, logger, checkpoint },
  });

  console.log('\n=== P8-3 WP3 Migration Summary ===');
  console.log(JSON.stringify({ dryRun: args.dryRun, ...stats }, null, 2));
  console.log(`Production data touched: NO (target = ${target.constructor.name}; no D1 binding invoked)`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
