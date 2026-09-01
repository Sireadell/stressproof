import { createApp } from './expressApp.js';

const PORT = process.env.PORT || 3000;

// The free demo runs only against targets that have agreed to it. Ours is
// always here; others are added as builders opt in.
const demoAllowlist = (process.env.STRESSPROOF_DEMO_ALLOWLIST ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = createApp({ demoAllowlist });
app.listen(PORT, () => console.log(`StressProof listening on :${PORT}`));
