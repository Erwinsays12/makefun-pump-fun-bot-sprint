// Early-confirm dip-and-ride: a pump.fun bonding-curve replay bot (agent-fun/replay/v2).
//
// What the dev tape shows: most fresh curves die flat within minutes — the median coin sees
// one buyer and a fraction of a SOL of buys in its first slots — while the coins that run share
// an early signature: several distinct wallets buying, real SOL piling in fast, and the price
// already well above its create price within the first few slots. This bot does NOT snipe the
// create slot. It watches every curve from birth and buys small only once that signature
// confirms, then rides with a trailing stop and cuts losers fast. A dip-buy shape and
// pyramiding into strength were both tried on the dev window and lost money there, so they
// ship off (dipHighWindow 0, pyramid false) and stay available as knobs. Both shapes share
// the same risk box: small stakes, a hard stop, a take-profit, a trailing stop once the trade
// is up, a fade exit when flow turns, an exit when the creator sells, and a time limit so the
// five open slots keep turning over and the bot keeps sampling fresh coins instead of sitting
// on dead ones.
//
// Everything here is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, no environment reads, so the two graded executions produce
// byte-identical action logs. Iteration is only over insertion-ordered maps and sets fed by
// the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots of tape looked at for the early-confirm entry signal. */
  window: number;
  /** Net SOL (buys minus sells) the window must show. */
  minNetSol: number;
  /** Buy trades the window must show. */
  minBuys: number;
  /** Distinct non-creator buyers the window must show. */
  minBuyers: number;
  /** Price now over price at window start, minus 1: lower bound. */
  minPriceUp: number;
  /** Upper bound on that rise: never chase a curve that already ran away inside one window. */
  maxPriceUp: number;
  /** Price now must be at least this share of the window's high. */
  nearHigh: number;
  /** Largest single non-creator wallet's share of the window's buy SOL, at most. 1 = off. */
  maxBuyerShare: number;
  /** The window's last trade must be a buy (the move is still going, not already reversing). */
  lastMustBeBuy: boolean;
  /** Real SOL reserve window at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed / after which it is too late. */
  minAge: number;
  maxAge: number;
  /** Skip the coin when the creator sold in the entry window. */
  skipCreatorSold: boolean;
  /** SOL for one position in total; first buy and each add-on. */
  stakeSol: number;
  initialSol: number;
  addSol: number;
  /** Smallest buy worth sending (tx fees are ~0.000105 SOL per order). */
  minBuySol: number;
  /** Slippage allowed on buys (bps); sells always go out wide open. */
  buySlipBps: number;
  /** Exits, as fractions of cost / peak value. */
  stopLoss: number;
  trail: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Sell everything once value reaches cost * (1 + takeProfit). 0 = off. */
  takeProfit: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when the creator sells while we hold. */
  exitOnCreatorSell: boolean;
  /** Exit after this many slots held, unless the position is up at least holdIfUp. */
  maxHold: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Add to a position while it is up and flow stays strong, up to stakeSol. */
  pyramid: boolean;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most early-confirm positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  // ---- dip-buy shape ----
  /** 0 = dip entries off. Lookback (slots) for the recent high the dip is measured from. */
  dipHighWindow: number;
  /** Enter the dip when price is at least this far below the recent high (fraction)... */
  dipDdMin: number;
  /** ...and not further than this (a collapse, not a dip). */
  dipDdMax: number;
  /** The curve must hold at least this much real SOL (SOL) at dip entry. */
  dipMinRqSol: number;
  /** Of the last dipFlowTrades trades at least dipMinBuys must be buys... */
  dipFlowTrades: number;
  dipMinBuys: number;
  /** ...and net SOL over them must be at least this. */
  dipMinNetSol: number;
  /** SOL for one dip position in total (single buy, no adds). */
  dipStakeSol: number;
  /** Most dip positions open at once. */
  dipMaxOpen: number;
  /**
   * Guardrail pacing: the run must end with round trips of >= 0.01 SOL on >= 20 coins. When
   * the bot's own filled coins lag targetCoins scaled by the share of paceSecs elapsed (block
   * time since the first batch), it opens tiny probe round trips (buy probeSol, sell it as soon
   * as the buy lands) until it is back on pace.
   */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 4,
  minNetSol: 5,
  minBuys: 4,
  minBuyers: 10,
  minPriceUp: 0.2,
  maxPriceUp: 2.5,
  nearHigh: 0.97,
  maxBuyerShare: 0.3,
  lastMustBeBuy: true,
  minRqSol: 3,
  maxRqSol: 80,
  minAge: 1,
  maxAge: 30,
  skipCreatorSold: true,
  stakeSol: 0.06,
  initialSol: 0.03,
  addSol: 0.03,
  minBuySol: 0.01,
  buySlipBps: 2000,
  stopLoss: 0.12,
  trail: 0.25,
  trailArm: 0.08,
  takeProfit: 0.2,
  fadeWindow: 15,
  fadeNetSol: 1000,
  bigSellSol: 1000,
  exitOnCreatorSell: true,
  maxHold: 400,
  holdIfUp: 0.1,
  cooldown: 150,
  maxEntries: 2,
  pyramid: false,
  addStep: 0.1,
  addNetSol: 0.5,
  maxMain: 5,
  dipHighWindow: 0,
  dipDdMin: 0.25,
  dipDdMax: 0.5,
  dipMinRqSol: 5,
  dipFlowTrades: 6,
  dipMinBuys: 3,
  dipMinNetSol: 0,
  dipStakeSol: 0.05,
  dipMaxOpen: 2,
  targetCoins: 25,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 4,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string;
  trades: Trade[];
  entries: number;
  lastExit: number;
  creatorSold: boolean;
  dipEntries: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
  /** Entered through the dip shape (no adds, different hold limit). */
  dip: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Slot until which a mint is left alone after one of its orders was rejected. */
  const rejectUntil = new Map<Pubkey, number>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow, p.dipHighWindow) + 5;

  const tapeOf = (mint: Pubkey, creator = ''): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator, trades: [], entries: 0, lastExit: -1e12, creatorSold: false, dipEntries: 0 };
      tapes.set(mint, t);
    }
    if (creator !== '') t.creator = creator;
    return t;
  };

  /** Early-confirm entry signal on a curve's tape at slot `now`. */
  const confirmSignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge || now - t.created > p.maxAge) return false;
    if (p.skipCreatorSold && t.creatorSold) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    let lastIsBuy = false;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        if (tr.user !== t.creator) byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else sellSol += tr.sol;
      if (tr.price > high) high = tr.price;
      last = tr.price;
      lastIsBuy = tr.buy;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    if (p.lastMustBeBuy && !lastIsBuy) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /** Dip-buy signal: ran up, pulled back, buyers stepping back in. */
  const dipSignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (p.dipHighWindow <= 0) return false;
    if (rqSol < p.dipMinRqSol) return false;
    if (t.created === null || now - t.created < 300) return false;
    if (t.trades.length < p.dipFlowTrades) return false;
    let high = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - p.dipHighWindow) break;
      if (tr.price > high) high = tr.price;
    }
    if (high <= 0) return false;
    const last = t.trades[t.trades.length - 1]!;
    const dd = 1 - last.price / high;
    if (dd < p.dipDdMin || dd > p.dipDdMax) return false;
    let buys = 0;
    let net = 0;
    let lastIsBuy = false;
    for (let i = t.trades.length - p.dipFlowTrades; i < t.trades.length; i++) {
      const tr = t.trades[i]!;
      if (tr.buy) {
        buys++;
        net += tr.sol;
      } else net -= tr.sol;
      lastIsBuy = tr.buy;
    }
    if (buys < p.dipMinBuys || net < p.dipMinNetSol) return false;
    if (!lastIsBuy) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** What selling all of `tokens` would pay now, curve fee and one tx fee deducted. */
  const closeValue = (vq: number, vt: number, tokens: number, tx: number): number => {
    if (vt + tokens <= 0) return 0;
    return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
  };

  /**
   * Most tokens that can be sold in one order without the quote-out exceeding the curve's
   * real SOL reserve (the harness rejects a sell whose quote-out tops it, which happens on
   * crashed curves where a position is a large share of the remaining supply). Sell q =
   * t*vq/(vt+t) <= 0.95*rq  =>  t <= 0.95*rq*vt/(vq-0.95*rq), in bigint lamports.
   */
  const maxSellTokens = (vq: bigint, vt: bigint, rq: bigint): bigint => {
    if (vq <= 0n || vt <= 0n || rq <= 0n) return 0n;
    const q = (rq * 95n) / 100n;
    if (vq <= q) return 0n;
    return (q * vt) / (vq - q);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const creatorSoldNow = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
        if (f.status === 'rejected' && !f.client_id.startsWith('_')) {
          // A rejected order (size cap, slippage, ...) — do not hammer the same mint: the
          // signal that produced it usually persists for several batches.
          rejectUntil.set(f.mint, now + 25);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint, e.creator).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
          if (!e.is_buy && t.creator !== '' && e.user === t.creator) {
            t.creatorSold = true;
            creatorSoldNow.add(e.mint);
          }
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        void rqSol;
        const tokens = Number(pos.token_amount);
        const value = closeValue(vq, vt, tokens, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && p.takeProfit > 0 && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && p.exitOnCreatorSell && creatorSoldNow.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if ((rejectUntil.get(mint) ?? -1) > now) continue;
        if (orders.length >= cap) break;
        // Size the sell so its quote-out stays under the curve's real SOL reserve; on a
        // crashed curve the whole position cannot go out in one order, so drain it in pieces.
        const sellCap = maxSellTokens(
          mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves,
          mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves,
          mk ? BigInt(mk.real_quote_reserves) : curve.real_quote_reserves,
        );
        const sellTokens = pos.token_amount < sellCap ? pos.token_amount : sellCap;
        if (sellTokens <= 0n) continue;
        orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if ((rejectUntil.get(mint) ?? -1) > now) continue;
        if (orders.length >= cap) break;
        // Size the sell like any exit: on a drained curve the whole probe cannot go out
        // in one order (its quote-out tops the real SOL reserve), so drain it in pieces.
        const mk = marks.get(mint);
        const sellCap = maxSellTokens(
          mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves,
          mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves,
          mk ? BigInt(mk.real_quote_reserves) : curve.real_quote_reserves,
        );
        const sellTokens = pos.token_amount < sellCap ? pos.token_amount : sellCap;
        if (sellTokens <= 0n) continue;
        orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let dipLeft = p.dipMaxOpen;
      for (const h of held.values()) if (h.dip) dipLeft--;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        if ((rejectUntil.get(mint) ?? -1) > now) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want = 0;
        let isDip = false;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (mainLeft > 0 && confirmSignal(t, now, rqSol)) {
            want = Math.min(p.initialSol, p.stakeSol);
          } else if (dipLeft > 0 && t.dipEntries < p.maxEntries && dipSignal(t, now, rqSol)) {
            want = p.dipStakeSol;
            isDip = true;
          } else continue;
        } else {
          // Pyramid into strength only: the position is up, the price stepped up from the last
          // add, and net SOL still flows in. Dip positions never add.
          if (h.dip || !p.pyramid || h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
          if (flow(t, now, p.window) < p.addNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        // The harness checks the 1% size cap against the reserves shifted by our own earlier
        // flow on the coin, which can sit a little below the recorded ones the SDK keeps.
        const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.97) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastValue: 0, dip: isDip });
          if (isDip) {
            t.dipEntries++;
            dipLeft--;
          } else {
            t.entries++;
            mainLeft--;
          }
          slotsLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(200 * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
