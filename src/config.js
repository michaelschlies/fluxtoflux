import { readFileSync } from 'node:fs';

export function loadConfig(path = process.env.BRIDGE_CONFIG ?? 'config.json') {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${path}: ${err.message} (copy config.example.json to config.json)`);
  }
  const cfg = {
    instances: raw.instances ?? {},
    links: raw.links ?? [],
    options: { bridgeBots: false, maxAttachmentBytes: 25 * 1024 * 1024, dataDir: 'data', ...raw.options },
  };
  for (const [key, inst] of Object.entries(cfg.instances)) {
    // Tokens travel as FLUXER_TOKEN_<KEY>, so the key has to be a valid env var name part.
    if (!/^\w+$/.test(key)) throw new Error(`Instance key "${key}" must contain only letters, digits and underscores`);
    const token = process.env[`FLUXER_TOKEN_${key.toUpperCase()}`] ?? inst.token;
    if (!inst.origin || !token) throw new Error(`Instance "${key}" needs origin and token`);
    inst.token = token.replace(/^Bot\s+/i, '');
    inst.origin = inst.origin.replace(/\/+$/, '');
    inst.label ??= key;
  }
  const seen = new Set();
  for (const link of cfg.links) {
    const members = Object.keys(link.channels ?? {});
    if (members.length < 2) throw new Error(`Link "${link.name}" needs at least two channels`);
    for (const m of members) {
      if (!cfg.instances[m]) throw new Error(`Link "${link.name}" uses unknown instance "${m}"`);
      const id = link.channels[m];
      // Snowflakes exceed 2^53, so a bare JSON number would already be corrupted.
      if (typeof id !== 'string' || !/^\d+$/.test(id)) {
        throw new Error(`Link "${link.name}": channel for "${m}" must be a quoted numeric ID string`);
      }
      if (seen.has(`${m}:${id}`)) throw new Error(`Channel ${id} on "${m}" is used by more than one link`);
      seen.add(`${m}:${id}`);
    }
    if (link.oneWayFrom && !members.includes(link.oneWayFrom)) {
      throw new Error(`Link "${link.name}": oneWayFrom must be one of ${members.join(', ')}`);
    }
  }
  return cfg;
}
