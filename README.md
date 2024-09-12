# events-publisher

# Usage

Mainnet url: `wss://events.drift.trade/ws`

## Subscribing to events

Some events are user specific, they may be filtered by `UserAccount` address via the `user` field.

```
{ "type": "subscribe", "channel": <event_type>, "user": Option<user_account> }
```

Valid [`event_type`s](https://github.com/drift-labs/protocol-v2/blob/fadbc9948b130c33f690e40db83c91b22718d2fc/sdk/src/events/types.ts#L97):

| Event Type                    | Description                                                    | Specificity |
|-------------------------------|----------------------------------------------------------------|-------------|
| DepositRecord                 | Emitted on account deposits, withdrawals, and transfers        | User        |
| FundingPaymentRecord          | Emitted on user funding payment events                         | User        |
| LiquidationRecord             | Emitted on liquidation events                                  | User        |
| FundingRateRecord             | Emitted on market funding rate updates                         | Market      |
| OrderRecord                   | Emitted on order placement, contains order details             | User        |
| OrderActionRecord             | Emitted on order actions (place, fill, cancel)                 | User        |
| SettlePnlRecord               | Emitted on user PnL Settlement                                 | User        |
| NewUserRecord                 | Emitted on new user account creation                           | User        |
| LPRecord                      | Emitted on user LP (aka BAL) changes                           | User        |
| InsuranceFundRecord           | Emitted on insurance fund changes                              | Market      |
| InsuranceFundStakeRecord      | Emitted on insurance fund staking events                       | User Auth   |
| SpotInterestRecord            | Emitted on spot market interest update                         | Market      |
| CurveRecord                   | Emitted on AMM curve parameters                                | Market      |
| SwapRecord                    | Emitted on swap (jupiter) events                               | User        |
| SpotMarketVaultDepositRecord  | Emitted on deposits into spot market vaults                    | Market      |
