/** Stripe India marketplace transfers are not generally supported. Never infer approval from API credentials. */
export function stripeConnectPayoutPolicy(env: Record<string, string | undefined> = process.env) {
  const requested = env.STRIPE_CONNECT_PAYOUTS_ENABLED === 'true';
  const approved = env.STRIPE_CONNECT_PLATFORM_APPROVED === 'true';
  const mode = env.STRIPE_CONNECT_APPROVED_CHARGE_MODEL;
  // This release deliberately has no implemented and verified Connect payout adapter.
  // Approval alone cannot make unimplemented money movement safe.
  return {
    enabled: false,
    requested,
    approved,
    mode: mode || null,
    reason: requested
      ? 'Automatic driver payouts are blocked: approved charge model and verified payout adapter required'
      : 'Automatic driver payouts disabled pending Stripe India platform approval and integration testing',
  } as const;
}

export function assertStripeConnectPayoutsDisabled(env: Record<string, string | undefined> = process.env) {
  const policy = stripeConnectPayoutPolicy(env);
  if (policy.requested) throw new Error(policy.reason);
  return policy;
}
