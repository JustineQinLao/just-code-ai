import type * as Sdk from '@anthropic-ai/claude-agent-sdk';

export type { Sdk };

// The Agent SDK is an ES module and the extension is CommonJS. The bundle (esbuild) inlines it; under plain tsc
// (tests) it is loaded with a real dynamic import, which TypeScript would otherwise turn into require().
let loaded: Promise<typeof Sdk> | undefined;
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<typeof Sdk>;

export function sdk(): Promise<typeof Sdk> {
  if (!loaded) {
    loaded = (typeof __JUSTCODE_BUNDLE__ !== 'undefined' ? import('@anthropic-ai/claude-agent-sdk') : dynamicImport('@anthropic-ai/claude-agent-sdk'))
      .catch(e => { loaded = undefined; throw e; });
  }
  return loaded;
}

declare const __JUSTCODE_BUNDLE__: boolean | undefined;
