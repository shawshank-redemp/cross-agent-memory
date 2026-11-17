export function derivePaymentLinkAmount(eventAmountPaise: number, committedSpendPaise: number | null): number {
  if (!Number.isSafeInteger(eventAmountPaise) || eventAmountPaise <= 0) {
    throw new RangeError("Event amount must be a positive safe integer in paise");
  }
  if (
    committedSpendPaise !== null &&
    (!Number.isSafeInteger(committedSpendPaise) ||
      committedSpendPaise < 0 ||
      committedSpendPaise > eventAmountPaise)
  ) {
    throw new RangeError("Committed spend must be between zero and the event amount");
  }

  const payablePaise = eventAmountPaise - (committedSpendPaise ?? 0);
  if (payablePaise <= 0) {
    throw new RangeError("Payment link amount must be greater than zero");
  }
  return payablePaise;
}
