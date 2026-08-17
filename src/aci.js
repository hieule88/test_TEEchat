// One SDK instance for the whole app (README-FRONTEND.md §2: "Keep one SDK
// instance in your app"). Import it anywhere: `import { aci } from './aci'`.
import { LeviathanACI, AciError } from './leviathan-aci';

// serviceOrigin MUST equal the Edge's WALLET_SERVICE_ORIGIN exactly
// (scheme + host + port), or binds are refused "different service".
export const aci = new LeviathanACI({
  serviceOrigin:
    import.meta.env.VITE_EDGE_ORIGIN ?? 'https://leviathan-edge-test.duckdns.org:8443',
});

// Session spend cap the user authorizes when opening a session (shown before
// the Falcon popup).
export const MAX_SPEND_MC = 100_000;

export { AciError };
