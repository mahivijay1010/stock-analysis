/**
 * src/services/money — exact decimal money math (spec §4, plan §2).
 * Pure, dependency-light (decimal.js only). The B2 transaction ledger and all
 * future accounting consume THIS module; nothing else may do money arithmetic
 * in floats.
 */
export {
  INTERNAL_SCALE,
  DISPLAY_SCALE,
  MoneyDecimal,
  Money,
  MoneyInput,
  ZERO,
  money,
  add,
  sub,
  mul,
  div,
  sum,
  eq,
  toDisplayString,
  toDbString,
  allocateByWeights,
} from "./money";
export {
  Lot,
  LotAllocation,
  SellFifoResult,
  purchaseLot,
  markedValue,
  unrealizedMarkedPnl,
  projectedMarkedPnl,
  forecastChangeFromToday,
  sellFifo,
  applySplit,
  perShareBasis,
  totalBasis,
} from "./lots";
