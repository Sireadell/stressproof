import { createApp } from './expressApp.js';
import { createPaymentGate } from './lib/paymentGate.js';

const PORT = process.env.PORT || 3000;

// The free demo runs only against targets that have agreed to it. Ours is
// always here; others are added as builders opt in.
const demoAllowlist = (process.env.STRESSPROOF_DEMO_ALLOWLIST ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Decided once, at boot, and said out loud. A deployment that meant to charge
// and cannot is the failure worth shouting about, because it looks identical
// to a working one right up until somebody notices the runs were free.
const payment = createPaymentGate();

const app = createApp({ demoAllowlist, payment });
app.listen(PORT, () => {
  console.log(`StressProof listening on :${PORT}`);
  if (payment.mode === 'live') {
    console.log(`Paid runs: ${payment.price} USDC on ${payment.config.network} to ${payment.payTo}`);
  } else if (payment.mode === 'off') {
    console.log('Paid runs: DISABLED by configuration. Runs on this deployment are free.');
  } else {
    console.error(`Paid runs: REFUSED. ${payment.reason}`);
  }
});
