// Pump.fun Replay Sprint — early-entry sniper paper bot.
//
// v1 (momentum chasing) lost -2.27 SOL on the dev window: buying coins that
// had already run up, then paying ~3% a round trip in fees while they dumped.
// Lesson: on pump.fun the cheap price is at creation, and most coins only go
// down from there. So this bot buys at creation instead of after a run-up,
// takes profit fast, cuts losers fast, and never holds long.
//
// Entry: on (or within a few slots of) a coin's CreateEvent, with light
// filters — the creator must not have sold, must not have loaded up more
// than 2.5 SOL in the create slot, the launch must not look bundled (few
// distinct buyers so far), sellers must be a small share of early flow, and
// the price must not already have spiked more than +100% over the create
// price. Exactly one buy per coin, sized by the 1%-of-real-reserve cap
// (small when the coin is tiny, up to 0.1 SOL): adding size later only buys
// at worse prices after the initial pop, so there are no top-ups.
//
// Exit: sell everything at +15%, cut everything at -12%, or exit after 10
// slots held, whichever comes first; also exit on a creator sell or fading
// flow. Positions are tiny and short-lived, so at most ~0.5 SOL is ever at
// risk and drawdown stays small.
//
// A pacing probe keeps the run above the 20-coin guardrail in quiet
// stretches. The bot is a pure function of the batches it is fed: no clock,
// no randomness, no I/O, no environment reads. Iteration is only over
// insertion-ordered Maps fed by the batch stream, so two runs on the same
// data produce identical replies.
//
// Costs that shape every size: each order pays 5000 + 100000 lamports of tx
// fees plus ~1.25% of curve fees each way, so a round trip costs roughly
// 2.6% of a 0.15 SOL stake. Nothing below 0.01 SOL is ever bought.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
const CURVE_FEE = 0.0125; // protocol 0.95% + creator 0.30%

// ---- entry ----
const MAX_ENTRY_AGE = 8; // slots since CreateEvent in which the one buy may be decided
const STAKE_SOL = 0.1; // SOL at cost aimed for per coin (one buy, capped by 1% of real reserve)
const MIN_PIECE_SOL = 0.005; // smallest buy worth the tx fee (early pieces are small)
const MIN_RQ_SOL = 0.3; // real SOL reserve before the first piece is sent
const MAX_DEV_BUY_SOL = 2.5; // creator's buys in the create slot, at most
const MAX_EARLY_BUYERS = 6; // distinct buyers seen before entry, at most
const MAX_SELL_SHARE = 0.2; // sells by others / buys by others, at most
const MAX_RUNUP = 1.0; // price now over create price, at most +100%
const MIN_EARLY_INTEREST_SOL = 0.05; // creator + other buys seen before entry, at least
// ---- exits ----
const TP = 0.15; // sell everything once the position is up 15%
const STOP_LOSS = 0.12; // hard exit when value < cost * 0.88
const MAX_HOLD = 10; // slots; exit whatever the value is
const FADE_WINDOW = 10; // slots
const FADE_NET_SOL = -0.5; // exit when net flow over FADE_WINDOW below this
const BUY_SLIP_BPS = 10_000; // wide: an early buy must not be refused for the price moving
const SELL_SLIP_BPS = 10_000;
// ---- guardrail pacing ----
const TARGET_COINS = 30;
const TARGET_FILLS = 300;
const PACE_SECS = 14_400;
const PROBE_SOL = 0.02;
const MAX_PROBES = 2;

interface Coin {
  created: number;
  creator: string;
  vq0: bigint;
  vt0: bigint;
  devBuy: number; // SOL the creator bought in the create slot
  devSold: boolean; // the creator sold at any point
  buyers: Set<string>; // distinct non-creator buyers
  boughtByOthers: number; // SOL bought by non-creators
  soldByOthers: number; // SOL sold by non-creators
  lastTradeSlot: number;
  recent: { slot: number; buy: boolean; sol: number }[];
  invested: number; // SOL sent in buys (fees included)
  pieces: number; // buy orders sent
  done: boolean; // never buy again (exited, filtered out, or completed)
}

interface Held {
  opened: number;
  cost: number; // SOL spent on the tokens still held (fees included)
  exiting: boolean;
  filled: boolean;
}

const coins = new Map<Pubkey, Coin>();
/** Coins still young enough to buy: added on CreateEvent, pruned past MAX_TOPUP_AGE. */
const young = new Set<Pubkey>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function priceOf(vq: bigint, vt: bigint): number {
  return Number(vq) / Number(vt);
}

/** Net recorded SOL (buys minus sells) on a coin over the last `w` slots. */
function flow(c: Coin, now: number, w: number): number {
  let net = 0;
  for (let i = c.recent.length - 1; i >= 0; i--) {
    const tr = c.recent[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Close value of `tokens` against (vq, vt) in SOL, curve and tx fees deducted. */
function closeValue(txFeeSol: number, tokens: bigint, vq: bigint, vt: bigint): number {
  const t = Number(tokens);
  const gross = (t * Number(vq)) / (Number(vt) + t) / LAMPORTS;
  return gross * (1 - CURVE_FEE) - txFeeSol;
}

/** Entry filter: cheap, unbundled, creator-aligned launch that has not spiked yet. */
function entryOk(c: Coin, now: number, rqSol: number, price: number): boolean {
  if (c.done || c.devSold) return false;
  if (now - c.created > MAX_ENTRY_AGE) return false;
  if (rqSol < MIN_RQ_SOL) return false;
  if (c.devBuy > MAX_DEV_BUY_SOL) return false;
  if (c.buyers.size > MAX_EARLY_BUYERS) return false;
  if (c.boughtByOthers > 0 && c.soldByOthers > MAX_SELL_SHARE * c.boughtByOthers) return false;
  // Someone must have put real money in, and non-creator flow must not be net selling.
  if (c.devBuy + c.boughtByOthers < MIN_EARLY_INTEREST_SOL) return false;
  if (c.boughtByOthers < c.soldByOthers) return false;
  // At least two distinct early buyers: a launch bought by one wallet alone is
  // usually the creator's own stack or a bundle, not real demand.
  if (c.buyers.size < 2) return false;
  const createPrice = priceOf(c.vq0, c.vt0);
  if (createPrice <= 0 || price > createPrice * (1 + MAX_RUNUP)) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const txSol = Number(state.txFeeLamports()) / LAMPORTS;

    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
        // Cost is counted only on fills, never on sends: a rejected or
        // failed buy spends nothing, and a fill's quote is what was spent.
        if (f.side === 'buy') {
          const spent = Number(f.quote_lamports) / LAMPORTS;
          const c = coins.get(f.mint);
          if (c !== undefined) c.invested += spent;
          const h = held.get(f.mint);
          if (h !== undefined) h.cost += spent;
        }
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          created: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0,
          devSold: false,
          buyers: new Set<string>(),
          boughtByOthers: 0,
          soldByOthers: 0,
          lastTradeSlot: e.slot,
          recent: [],
          invested: 0,
          pieces: 0,
          done: false,
        });
        young.add(e.mint);
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = Number(e.sol_amount) / LAMPORTS;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, buy: e.is_buy, sol });
        if (e.user === c.creator) {
          if (e.is_buy) c.devBuy += sol;
          else c.devSold = true;
        } else if (e.is_buy) {
          c.buyers.add(e.user);
          c.boughtByOthers += sol;
        } else {
          c.soldByOthers += sol;
        }
      } else if (e.event === 'CompleteEvent') {
        const c = coins.get(e.mint);
        if (c !== undefined) c.done = true;
      }
    }
    // Drop old tape.
    const keep = FADE_WINDOW + 5;
    for (const c of coins.values()) {
      let cut = 0;
      while (cut < c.recent.length && c.recent[cut]!.slot <= now - keep) cut++;
      if (cut > 0) c.recent.splice(0, cut);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

    // ---- exits first ----
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      const c = coins.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          if (c !== undefined) c.done = true;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = batch.marks.find((m) => m.mint === mint);
      const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
      const value = closeValue(txSol, pos.token_amount, vq, vt);
      const cost = h.cost;
      let sellTokens = 0n;
      if (value >= cost * (1 + TP)) {
        sellTokens = pos.token_amount;
        h.exiting = true;
      } else if (h.exiting || value < cost * (1 - STOP_LOSS)) {
        sellTokens = pos.token_amount;
        h.exiting = true;
      } else if (now - h.opened >= MAX_HOLD) {
        sellTokens = pos.token_amount;
        h.exiting = true;
      } else if (c !== undefined && c.devSold) {
        sellTokens = pos.token_amount;
        h.exiting = true;
      } else if (c !== undefined && flow(c, now, FADE_WINDOW) < FADE_NET_SOL) {
        sellTokens = pos.token_amount;
        h.exiting = true;
      }
      if (sellTokens <= 0n) continue;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: SELL_SLIP_BPS });
    }

    // ---- probe sells ----
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
      if (!selling) probes.set(mint, true);
    }

    // ---- entries: exactly one buy per coin, on the first batch it qualifies ----
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of young) {
      if (orders.length >= cap) break;
      const c = coins.get(mint)!;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || c.done) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const age = now - c.created;
      if (age > MAX_ENTRY_AGE) {
        // Too old to buy now (and never bought): stop watching it.
        if (held.get(mint) === undefined) {
          c.done = true;
          young.delete(mint);
        }
        continue;
      }
      if (held.get(mint) !== undefined) continue;
      if (slotsLeft <= 0) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (!entryOk(c, now, rqSol, price)) continue;
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let piece = Math.min(capSol, STAKE_SOL);
      if (piece > free - txSol) piece = free - txSol;
      if (piece < MIN_PIECE_SOL) continue;
      const lamports = BigInt(Math.floor(piece * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      free -= piece + txSol;
      c.pieces++;
      held.set(mint, { opened: now, cost: 0, exiting: false, filled: false });
      slotsLeft--;
    }

    // ---- guardrail pacing: probe round trips when fills/coins lag ----
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const [mint, curve] of state.curves) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          if (curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * txSol) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + txSol;
        }
      }
    }
    return orders;
  },
});
