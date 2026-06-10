# Curve Launchpad (multi-quote fork)

Currently for educational purposes only, this program has not been audited.

Fork of the original SOL-only pump-style launchpad, reworked so one coin
launches on **multiple bonding curves at once**, each against a different
quote token.

## What changed vs. upstream

- **No mint init on `create`.** The instruction takes an *existing* mint.
  The creator keeps mint authority — the program never touches it. The
  intended launch flow (implemented in the `fun-launch` frontend) is a single
  signed bundle: create mint → metadata → mint 1B tokens per curve to the
  creator → `create` each curve (which pulls 1B tokens into curve inventory)
  → revoke mint authority.
- **Multi-quote curves.** `BondingCurve` is seeded by
  `["bonding-curve", mint, quote_mint]`, so the same coin can have parallel
  curves against wSOL, USDC, USDT, a Token-2022 transfer-fee token, etc. All
  quote legs are SPL `transfer_checked` via the token interface (wSOL is used
  for the SOL curve; the frontend wraps/unwraps).
- **Per-curve target market cap.** `create(virtual_quote_reserves,
  target_market_cap)` — the virtual quote reserve is derived client-side so
  the curve completes (all real tokens sold) exactly at the target market
  cap: `vQuote0 = target_raw * vTokFinal^2 / (supply * vTok0)`.
- **50/50 fees.** Every `buy`/`sell` charges `global.fee_basis_points`
  (default 1%), split evenly between `global.fee_recipient` (platform) and
  `bonding_curve.creator`, paid in the curve's quote token.
- **Buys transfer from curve inventory and sells transfer back** (no
  `mint_to` / `burn`), since the program never holds mint authority.
- The Meteora dynamic-AMM migration CPIs were removed; `withdraw` (withdraw
  authority only, after completion) pulls remaining inventory + raised quote
  for manual migration.

> Note: quotes with a Token-2022 transfer fee (e.g. the 6K4 curve) deliver
> slightly less than the recorded reserve amounts; the curve's accounting is
> in pre-fee units, so the last sellers on such a curve may receive slightly
> less than quoted.

> Note: `tests/` still targets the upstream single-curve interface and has
> not been updated to this fork.

## Deploy

```bash
anchor build
anchor deploy            # then update declare_id! + frontend env if the program id changes
# initialize global state, then set_params to set fee_recipient / withdraw_authority
```
