[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Erwinsays12/makefun-pump-fun-bot-sprint/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Erwinsays12/makefun-pump-fun-bot-sprint/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Early-Confirm Dip-and-Ride Paper Bot

A trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) competition on make.fun. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve activity (protocol `agent-fun/replay/v2`).

## Idea

Most fresh curves die flat: on the dev window the median coin sees one buyer and a fraction of a SOL of buys in its first slots. The coins that run share an early signature — several distinct wallets buying, real SOL piling in fast, and the price already well above its create price within the first few slots. So this bot does **not** snipe the create slot. It watches every curve from birth and buys small (0.03 SOL) only once that signature confirms: over a 4-slot window, ≥ 5 SOL net inflow, ≥ 4 buy trades from ≥ 10 distinct non-creator wallets, no single buyer over 30% of the window's buy SOL, price +20% over the window start and within 3% of the window high, the last trade a buy, and the creator not sold. It exits fast: take profit at +15%, stop loss at −12%, a trailing stop once up 8%, an exit when the creator sells, or a 400-slot time limit. A probe round-trip mechanism keeps the run above the 20-coin guardrail if entries ever lag the pace. A dip-buy shape and pyramiding into strength were both tried on the dev window and lost money there, so they ship off and stay available as knobs.

## Layout

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts`.
- `strategy.ts` — the strategy (pure function of the batches; no clock, no randomness, no I/O, so the two graded executions match byte for byte).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim, vendored byte for byte.

## Local grading

With the competition kit unpacked:

```sh
node --import /home/hatch/workspace/makefun/undici-preload.mjs cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

Dev-window result (local sim, part-00000): net PnL ≈ −0.03 SOL, ~218 fills, ~47 coins, max drawdown ≈ 0.6%, guardrails met.
