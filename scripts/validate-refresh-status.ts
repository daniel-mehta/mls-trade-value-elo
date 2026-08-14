import { readFile } from "node:fs/promises";
import type { ComparisonPool } from "../src/data/comparisonPool.js";
import { refreshStatusErrors, type RefreshStatus } from "../src/data/refreshAutomation.js";
import type { PlayerDataset } from "../src/data/types.js";

const [status, dataset, pool] = await Promise.all([
  readFile("data/refresh-status.json", "utf8").then((value) => JSON.parse(value) as RefreshStatus),
  readFile("public/data/players.json", "utf8").then((value) => JSON.parse(value) as PlayerDataset),
  readFile("public/data/comparison-pool.json", "utf8").then((value) => JSON.parse(value) as ComparisonPool),
]);

const errors = refreshStatusErrors(status, dataset, pool);
if (errors.length) throw new Error(`Refresh-status validation failed:\n- ${errors.join("\n- ")}`);
console.log(`Refresh status valid: ${status.currentSeason}/${status.previousSeason}, ${status.playerCount} players, ${status.poolCount} pool players`);
