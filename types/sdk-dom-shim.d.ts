/**
 * Workspace-wide ambient shim for ONE DOM type that a transitive dependency of
 * `@anthropic-ai/claude-agent-sdk` references without declaring:
 * `@modelcontextprotocol/sdk`'s `shared/transport.d.ts` uses `HeadersInit`,
 * which only `lib.dom` provides.
 *
 * We keep `skipLibCheck: false` (docs/spec-review-and-plan.md §6) and refuse to
 * add `"dom"` to `lib`: DOM's `setTimeout` returns `number` and would shadow
 * Node's `NodeJS.Timeout` overload across every timer in the session actor, and
 * DOM globals have no business in a subprocess-driving Node package.
 *
 * `tsconfig.base.json` lists this file under `files`, which every extending
 * project inherits (a child overriding `include` does not drop it), so the
 * declaration is present in package builds AND in `tsconfig.tests.json`.
 * Ambient `.d.ts` inputs are never emitted, so nothing leaks into `lib/`.
 */
declare global {
  type HeadersInit = string[][] | Record<string, string | readonly string[]> | Headers
}

export {}
