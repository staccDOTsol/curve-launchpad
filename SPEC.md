# Stacc — Curve Launchpad Rewrite Spec

Forked from `rckprtr/curve-launchpad@feature/migration`.

The launchpad is the substrate. Two front-ends live on top of it, neither knows the other exists:

- **stacc-ui** — looks like a normal launchpad. SOL in, SOL out, trade tokens.
- **stacc-flip** — looks like a casino. SOL in, FLIP, SOL out.

Both speak to the same Anchor program. The casino mechanics live on-chain in `curve-launchpad`.

---

## 1. Quote token swap: native SOL → LST

The bonding curve no longer takes native SOL. It takes an LST.

- LST mint: `6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f`
- The curve math (`virtual/real_*_reserves`) is unchanged — units flip from lamports of SOL to atomic units of the LST. Atomic-units 1:1, decimals assumed 9.
- `Global.quote_mint: Pubkey` is the source of truth. `initialize` seeds it from the constant `STACC_QUOTE_MINT`; `set_params` can rotate it (authority-gated).
- All state field names rename: `*_sol_reserves` → `*_quote_reserves`. Event field names rename. Ix arg names rename (`max_sol_cost` → `max_quote_cost`, `min_sol_output` → `min_quote_output`).

### Why LST?
- Curve reserves earn ~6–8% APY passively. Curves grow even when nobody trades.
- Post-migration, the Raydium LP holds LST/MEME — the LST side keeps compounding.

### Sanctum-on-the-frontend
- Users still think in SOL. The program is mint-agnostic from their point of view.
- `stacc-ui` composes Sanctum router instructions client-side: a buy tx is `[deposit-sol-to-LST, buy_with_lst]`. A sell tx is `[sell_to_lst, lst-to-sol-via-sanctum]`.
- Program is unaware of Sanctum. Program just sees LST in / LST out.

---

## 2. Revoke freeze authority on launch

`create.rs` mints the fixed supply, removes mint authority (already does this), and now **also removes freeze authority** via a second `SetAuthority` CPI with `AuthorityType::FreezeAccount` set to `None`. Standard hygiene; removes the "rug your bag via freeze" attack.

---

## 3. Migration: Raydium CPMM, LP retained

The current `migrate.rs` initializes a Raydium CPMM pool with WSOL/MEME and **burns the LP**. Rewrite:

- Initialize pool with **LST/MEME** (use `Global.quote_mint`, not `native_mint`).
- **Do not burn LP.** The LP token account stays held by a program-derived authority (the `BondingCurve` PDA or a dedicated `PoolAuthority` PDA — TBD during implementation).
- This is what makes post-migration coinflip raids possible. The program retains the right to remove liquidity via CPI.

Out of scope for PR-1; tracked separately.

---

## 4. Coinflip — on-chain mechanic

### Pre-migration
- Wager: user signs a flip with N atomic units of MEME from curve A (A is `attacker_curve`).
- Target: curve B (`target_curve`), any other curve whose `complete == false` or whose post-mig LP is alive.
- VRF: Switchboard On-Demand (single-tx; we still gate the settle into a second tx for UX drama, but the randomness is requested + revealed in the same flip txn).
- Outcome computed via `flip_settle`:
  - **Win (50%)**:
    - Compute `stolen_lst` = wager-MEME's value in LST under A's current curve price (i.e. what A would pay if A bought back N MEME).
    - Cap at min(stolen_lst, target B's `real_quote_reserves`). No artificial cap; only the literal availability cap.
    - 95% of `stolen_lst` is deposited into A's `real_quote_reserves` (bumps the curve, raises MEME price).
    - 5% goes to `Global.fee_recipient` (treasury).
    - The wagered MEME is burned (it was never sold to A, so A's `real_token_reserves` is unchanged — supply just shrinks). MEME `token_total_supply` decrements.
    - B's `real_quote_reserves` decrements by `stolen_lst`. B's curve gets weaker.
  - **Loss (50%)**:
    - The wagered MEME is sold back into A's curve (using `apply_sell` AMM math). Resulting LST proceeds — call it `loss_lst` — are routed to B's `real_quote_reserves` (B gets stronger).
    - A's `real_quote_reserves` decrements by `loss_lst`. A pays for the loss out of its own reserves.
- Symmetric: wars are bidirectional. Losing a raid funds the rival.

### Post-migration
- Same outcome model, different mechanics. A and/or B may have graduated to Raydium.
- For a graduated A receiving a win deposit: zap-in via CPI to Raydium CPMM. Program uses half the stolen LST to swap for MEME from A's own pool, then deposits both sides.
- For a graduated B losing reserves: program (LP authority) CPIs `withdraw` on Raydium for a proportional slice of the LP, takes the LST side, sends it to A. MEME side is held in a program-owned ATA and burned (so we don't widen MEME circulating supply unilaterally).

Out of scope for PR-1.

### House cut
- 5% of LST flowing on a winning flip goes to `Global.fee_recipient`.
- Losses fund the target curve, not treasury.

### Steal size
- Uncapped beyond reserve availability. Whales can drain small curves; that's a feature.

### RNG
- Switchboard On-Demand VRF. We pick this for single-tx settlement.
- Multi-tx UX (commit + reveal animation) is a frontend convention; the program exposes a single `flip(...)` ix that does request+resolve atomically.

### State
New per-curve account or extension on `BondingCurve`:
- `total_flips_in: u64`, `total_flips_won: u64`, `total_lst_raided_in: u64`, `total_lst_raided_out: u64` — for indexing/leaderboards.
- Per-flip event emitted: `FlipEvent { attacker_curve, target_curve, wager_meme, outcome, stolen_lst, treasury_cut, slot, signature_hash }`.

---

## 5. Instructions (PR-1 surface)

| Existing | Status |
|---|---|
| `initialize` | extended — sets `quote_mint` |
| `set_params` | extended — accepts `quote_mint` (authority only) |
| `create` | extended — revokes freeze authority |
| `buy` | rewritten — LST in via SPL transfer; fee in LST to recipient |
| `sell` | rewritten — LST out via SPL transfer from BC's LST ATA; fee in LST |
| `withdraw` | rewritten — drains BC's LST ATA, not lamports |
| `migrate` | deferred to PR-2 (Raydium LST + LP custody) |

| New (PR-2+) | |
|---|---|
| `flip` | Switchboard VRF integrated, settles win/loss path |
| `migrate_with_lp_retained` | Raydium CPMM init + LP held by program |
| `flip_post_mig_zap_in` | helper CPI for graduated curves |
| `flip_post_mig_lp_drain` | helper CPI for graduated targets |

---

## 6. Accounts

### Buy
The bonding curve PDA needs an ATA for the LST quote mint. New account:
- `bonding_curve_quote_account: TokenAccount` (authority = `bonding_curve` PDA, mint = `Global.quote_mint`)
- `user_quote_account: TokenAccount` (authority = user, mint = `Global.quote_mint`)
- `fee_recipient_quote_account: TokenAccount` (authority = `Global.fee_recipient`, mint = `Global.quote_mint`)

The `bonding_curve` PDA still holds its own rent in SOL; it just no longer transacts in SOL.

### Sell / Withdraw
Mirror of buy account set.

---

## 7. Frontend integrations

### stacc-ui (existing repo at `~/triton/stacc-ui`)
- Compose buy: `[sanctum_deposit_sol, curve_launchpad.buy]`
- Compose sell: `[curve_launchpad.sell, sanctum_unstake_lst_to_sol]`
- All LST handling invisible to the user; UI displays everything in SOL using a real-time LST/SOL rate.

### stacc-flip (greenfield, `~/triton/stacc-flip`)
- Casino lobby. Live flip feed. Leaderboard.
- Composes: `[sanctum_deposit_sol, curve_launchpad.buy (cheapest curve, just enough MEME to flip), curve_launchpad.flip (target = highest TVL)]`.
- Hidden "advanced" toggle reveals manual source/target pickers.

### stacc-backend (greenfield)
- Hono on Bun, Triton One Yellowstone gRPC subscription on the program ID, Neon Postgres via Drizzle.
- Indexes: curves, trades, flips, migrations. Computes leaderboard, auto-pick decisions, live feed.
- Single API consumed by both frontends.

---

## 8. Risks called out

- **No cap on steal size**: by design, but means a well-capitalized attacker can one-shot a small curve. The "loss funds the target" symmetry is the only natural disincentive. We accept this.
- **Program-held Raydium LP**: requires careful authority modeling for `flip_post_mig_lp_drain`. PR-2 design needs Raydium IDL and account audit.
- **Switchboard On-Demand cost**: ~0.001 SOL per flip. Frontend should warn the user.
- **MEME `token_total_supply` burn on flip win**: changes the bonding curve's invariant supply slightly. Need to revisit AMM math to confirm this is safe (likely fine since `real_token_reserves` is not touched on a win, only the user's burnt MEME — which never re-entered the curve).
- **Freeze-revoke breaks any future "pause trading" feature.** Acceptable — we never want that anyway.
