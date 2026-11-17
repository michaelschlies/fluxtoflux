import { loadConfig } from './config.js';
import { FluxerClient } from './client.js';
import { Bridge } from './bridge.js';
import { Store } from './store.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const checkOnly = process.argv.includes('--check');
const backfillOnly = process.argv.includes('--backfill');
const linkFlag = process.argv.indexOf('--link');
const onlyLink = linkFlag > 0 ? process.argv[linkFlag + 1] : undefined;

const cfg = loadConfig();
const clients = new Map(Object.entries(cfg.instances).map(([k, v]) => [k, new FluxerClient(k, v, log)]));

// Resolve each instance's API/gateway URLs from its discovery document.
for (const client of clients.values()) {
  await client.discover();
  log(`[${client.key}] ${client.origin} -> api ${client.apiBase}, gateway ${client.endpoints.gateway}`);
}

const store = checkOnly ? null : new Store(cfg.options.dataDir);
const bridge = new Bridge(cfg, clients, store, log);

if (checkOnly) {
  let failed = false;
  for (const link of cfg.links) {
    for (const [inst, chan] of Object.entries(link.channels)) {
      try {
        const ch = await clients.get(inst).rest('GET', `/channels/${chan}`);
        log(`ok   [${inst}] "${link.name}" -> #${ch.name ?? chan}`);
      } catch (err) {
        failed = true;
        log(`FAIL [${inst}] "${link.name}" channel ${chan}: ${err.message}`);
      }
    }
  }
  try {
    await bridge.setupWebhooks();
  } catch (err) {
    failed = true;
    log(`FAIL webhook setup: ${err.message} (the bot needs Manage Webhooks, or set links[].webhooks)`);
  }
  process.exit(failed ? 1 : 0);
}

await bridge.setupWebhooks();

if (backfillOnly) {
  if (onlyLink && !cfg.links.some((l) => l.name === onlyLink)) {
    log(`FAIL no link named "${onlyLink}"`);
    process.exit(1);
  }
  const ok = await bridge.catchUp({ link: onlyLink });
  await bridge.idle();
  log(ok ? 'backfill finished' : 'backfill finished with errors');
  process.exit(ok ? 0 : 1);
}

bridge.attach();
bridge.holdForCatchUp(); // live messages for channels being caught up wait until the history is relayed

for (const client of clients.values()) {
  client.on('fatal', (err) => {
    log(`[${client.key}] fatal: ${err.message}`);
    process.exit(1);
  });
  await client.connect();
}

bridge.catchUp().then((ok) => ok || log('catch-up finished with errors'));

const shutdown = () => {
  log('shutting down');
  for (const c of clients.values()) c.stop();
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
