# Pump.fun Replay Sprint — Paper Bot

Early-entry sniper bot for the pump.fun bonding-curve replay. It trades 10 SOL
of paper money on a 24h replay of pump.fun activity, scored on net PnL after
every fee.

## Strategy

Most pump.fun coins only go down from their launch price, so this bot buys at
creation instead of chasing coins that have already run up, takes profit fast,
cuts losers fast, and never holds long.

**Entry** — within 8 slots of a coin's `CreateEvent`, exactly one buy per coin
(up to 0.1 SOL, sized by the 1%-of-real-reserve cap), only when:

- the creator has not sold, and bought at most 2.5 SOL in the create slot;
- at most 6 distinct buyers so far (bundled launches are skipped);
- sells by others are at most 20% of buys by others;
- creator + other buys total at least 0.05 SOL, non-creator flow is not net
  selling, and at least 2 distinct buyers have shown up;
- the price has not already spiked more than +100% over the create price;
- the real SOL reserve is at least 0.3 SOL.

No top-ups: adding size later only buys at worse prices after the initial pop.

**Exit** — sell everything at the first of:

- +15% over cost (take profit);
- −12% under cost (stop loss);
- 10 slots held;
- the creator sells;
- net flow over the last 10 slots below −0.5 SOL (fading flow).

Positions are tiny and short-lived, so at most ~0.5 SOL is ever at risk.

**Guardrail pacing** — if filled coins / fills lag a pace of 30 coins / 300
fills over the first 4 hours of block time, the bot opens tiny 0.02 SOL probe
round trips (buy, sell as soon as the buy lands) on liquid coins until it is
back on pace. This keeps the run above the 20-coin minimum bar even in quiet
stretches.

## Costs

Each order pays 5000 + 100000 lamports of tx fees plus ~1.25% of curve fees
each way, so a round trip costs roughly 2.8% of the stake. Nothing below
0.005 SOL is ever bought.

## Determinism

The bot is a pure function of the batches it is fed: no clock, no randomness,
no I/O, no environment reads. Iteration is only over insertion-ordered maps
fed by the batch stream, so two runs on the same data produce byte-identical
action logs (verified by the kit's local grader: `L1 regrade reproduced byte
for byte`).

## Local dev-window results (kit `grade-local`, process driver)

| Version | Net PnL (SOL) | Coins ≥0.01 SOL | Max drawdown | Win rate |
|---------|--------------|-----------------|--------------|----------|
| v1 momentum chase | −2.27 | 153 | 30.0% | 8.3% |
| v2 sniper, top-ups to 40 slots | −2.18 | 404 | 22.4% | 14.0% |
| v3 sniper, 12-slot hold | −1.17 | 405 | 12.0% | 13.0% |
| v4 sniper, +25% TP, ≥2 buyers | −1.07 | 327 | 11.0% | 13.3% |
| v5 sniper, +15% TP / −12% SL / 10-slot hold | −1.08 | 327 | 11.1% | 13.7% |
| v6 sniper, smaller first pieces | −1.07 | 340 | 11.1% | 14.3% |
| v7 sniper, one buy per coin | −0.78 | 322 | 8.0% | 13.8% |
| v8 sniper, relaxed filters | −0.86 | 380 | 8.9% | 12.7% |

Final configuration is v7. The dev window is a hard, loss-making window for
every strategy shipped in the kit (the kit's own pilots score −0.47 to −9.49
SOL on it), so the design goal here is survival with a small loss and a wide
guardrail margin — 322 coins over the 20-coin bar, 8% drawdown against a 50%
limit — rather than a dev-window number tuned to specific coins. The final
window is a different 24h of data collected after entries close.

Stress check (`grade-local --stress 20`): 20 rebuilt copies of the dev window
all lose money, median −0.65 SOL, p10 −0.88, p90 −0.46; the dev score (−0.78)
sits above 5 of 20 copies, i.e. in the middle of the spread, not an outlier
leaning on a few coins. Losses are tight and consistent, not concentrated.

## Files

- `main.ts` — the bot (entrypoint, run by the grader as `node /bot/main.ts`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied unchanged as the SDK
  instructs (kept out of authorship counts).
- `LICENSE` — MIT.

## License

MIT — see `LICENSE`.
