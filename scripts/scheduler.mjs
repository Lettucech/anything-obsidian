export async function runScheduler({ registry, runVault, sleep, now = Date.now, logger = console }) {
  const nextRunAt = new Map();
  let running = true;

  while (running) {
    const current = now();
    const vaults = (await registry.list()).filter((vault) => vault.enabled);

    for (const vault of vaults) {
      if ((nextRunAt.get(vault.id) ?? 0) > current) continue;
      try {
        await runVault(vault.id);
      } catch (error) {
        logger.error(`Vault '${vault.id}' sync failed: ${message(error)}`);
      }
      nextRunAt.set(vault.id, now() + intervalMs(vault.syncIntervalSeconds));
    }

    const upcoming = [...nextRunAt.values()].filter((time) => time > now());
    const waitMs = upcoming.length ? Math.max(1_000, Math.min(...upcoming) - now()) : 30_000;
    running = await sleep(waitMs);
  }
}

function intervalMs(value) {
  const seconds = Number(value);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1_000;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
