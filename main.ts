// Entrypoint for the early-confirm dip-and-ride pump.fun replay bot.
// The grader runs `node /bot/main.ts` (Node 22 strips the types; no build, no install).
// All decisions live in strategy.ts; this file only wires the kit's replay shim to it.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
