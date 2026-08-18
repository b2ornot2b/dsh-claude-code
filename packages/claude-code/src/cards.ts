/**
 * Cards for Claude Code's OWN tools: pure projections from a mirrored CC tool
 * call onto dsh's render-intent vocabulary (spec §6's "mirror CC's own tool
 * calls into dsh cards where the shape matches — `terminal` for CC `Bash`,
 * `diff` for CC `Write`/`Edit`").
 *
 * ## Read this before wiring anything to it
 *
 * **These views cannot reach a dsh UI in rc.7, and the reason is structural.**
 * The functions here are correct, tested and ready; there is nowhere to hang
 * them. The evidence, in the order it has to be checked:
 *
 * 1. **The event carries no view.** `SessionEventMap['tool/call']` is exactly
 *    `{ turn, step, callId, name, arguments }` — no view, no card, no free
 *    field (`packages/core/session/src/types.ts:279`). `tool/result` adds only
 *    `error?` and `meta?: JsonValue` (`types.ts:291-297`), and the envelope
 *    itself (`types.ts:404-436`) has just `type`/`seq`/`time`/`data`/
 *    `ignorable` plus the two surface fields. There is no slot a writer can put
 *    a card in.
 * 2. **The card is derived by a NAME LOOKUP in the tool registry.** A UI does
 *    not read a card off the log; the host computes one:
 *    `ctx.tools.get(name, scope)?.presentCall?.(JSON.parse(raw))` for a
 *    `tool/call`, and `ctx.tools.get(call.name, scope)?.presentResult?.(...)`
 *    for a `tool/result` (`packages/host/apiproxy/src/api-proxy.ts:756-770`).
 *    `meta` is threaded INTO that call (`api-proxy.ts:770`) — it is an argument
 *    to a registered tool's own presenter, never a view in its own right.
 * 3. **Mirrored CC tools are not in that registry.** `ctx.tools.get()` resolves
 *    `this.view(scope).visible.get(name)`
 *    (`packages/core/tools/src/index.ts:1204-1206`), and `visible` is built
 *    from what plugins actually registered
 *    (`index.ts:1166-1191`). The mirror writes CC's own names — `Bash`,
 *    `Write`, `Edit`, `Read` — and dsh's own tools are the lowercase `bash`,
 *    `write`, `edit`, `read` (`packages/shell/tool-bash/src/index.ts:243`,
 *    `packages/fs/tool-fs/src/{write,read,edit}.ts`). Nothing registers the
 *    CapCase names, so the lookup returns `undefined` and the event ships with
 *    no view — the documented generic-card fallback (`api-proxy.ts:766`).
 *
 * So nothing is written into the log for this. A `ToolCallKind` hint has no
 * more of a slot than a whole card does, and a payload parked in
 * `tool/result.meta` would be read by nobody, replicate content the event
 * already carries, and grow every log that contains a `Bash` call. An honest
 * "not representable" is worth more than any of that.
 *
 * **Nothing is lost by not writing it, either**, and that is the reason this
 * shape is the right one rather than a consolation prize: every input these
 * projections need is ALREADY in the log. `tool/call` carries `name` and the
 * raw `arguments` JSON; `tool/result` carries the result content. So the card
 * is a pure function of what is durably recorded — computable on live traffic
 * and on a replay years later, by whoever ends up owning the mapping. Writing
 * a derived payload would only pin today's rendering into a permanent record.
 *
 * ### What would close the gap
 *
 * Either of these, upstream, and this module is the implementation:
 *
 * - a name-independent view path — `viewFor()` consulting a registry of
 *   presenters for FOREIGN tool namespaces when `ctx.tools.get()` misses; or
 * - a `presentation-only` registration on `ToolRegistry` — a definition with
 *   presenters and no `execute`, excluded from `schemas()`/`sdkSchemas()` and
 *   from `resolveExecution()`, so a name can be given a card without being
 *   given to the model.
 *
 * The second is the smaller change and the one this seam wants. Today's
 * registry cannot express it: `visible` is the SAME map that feeds `schemas()`
 * (`packages/core/tools/src/index.ts:1234-1236`), so registering `Bash` for its
 * card would advertise `Bash` to the model of whatever scope it was registered
 * in. There is one narrow exception — a registration through `agent.ctx` lands
 * in that agent's own layer (`index.ts:1037-1062`, `1177-1183`) and a CC-backed
 * agent never sends dsh tool schemas to a model (delta D8) — but it works only
 * for the ADAPTER path (a tool-opened session registers no agent, so its
 * presenter scope is the global one), and only while the agent is alive (a cold
 * transcript read falls back to the preset's standing key,
 * `api-proxy.ts:1596-1613`). The same log would render two different ways
 * depending on who was looking and when, which is worse than rendering one way.
 *
 * ## Contract
 *
 * Every function here is **pure and total**: same inputs, same output; no I/O,
 * no clock, no session reads; and any malformed input degrades to a generic
 * card rather than throwing. That is dsh's own presenter contract
 * (`packages/core/tools/src/index.ts:268-287`) and it is what makes these safe
 * to call on a replay path.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import type {
  DiffCallView, FileDiff, FileLocation, GenericCallView, ReadFileLine, ReadResultView,
  TerminalCallView, ToolCallKind, ToolCallView, ToolResultView,
} from '@deepseek-ai/dsh-tools'

/**
 * The completed call one {@link presentCcToolResult} describes: the result
 * content as text, and whether Claude Code reported it as a failure.
 *
 * Deliberately not dsh's `ToolResult`: that type carries `ContentBlock[]` plus a
 * tool-private `meta`, and a mirrored CC result has neither — it has the text
 * the CLI put in the `tool_result` block. Stating the smaller thing keeps these
 * functions callable from the mirror, from a test, and from a future consumer
 * that only has the log.
 */
export interface CcToolOutcome {
  /** The result text exactly as Claude Code produced it. */
  readonly text: string
  /** Whether the `tool_result` block was flagged `is_error`. */
  readonly isError: boolean
}

/**
 * Category hints for Claude Code's built-in tools, for the icon/treatment a
 * {@link GenericCallView} carries.
 *
 * Only names whose category is unambiguous appear. An unlisted tool — an MCP
 * tool (`mcp__server__thing`), a skill, a plugin's, or one a future CLI adds —
 * gets `'other'`, which is the vocabulary's own default
 * (`packages/core/tools/src/presentation.ts:16`). Guessing from a name prefix
 * would mislabel exactly the tools nobody here has seen.
 */
const TOOL_KINDS: Readonly<Record<string, ToolCallKind>> = {
  Bash: 'execute',
  BashOutput: 'read',
  Edit: 'edit',
  Glob: 'search',
  Grep: 'search',
  KillShell: 'other',
  NotebookEdit: 'edit',
  Read: 'read',
  Task: 'other',
  TodoWrite: 'other',
  WebFetch: 'fetch',
  WebSearch: 'search',
  Write: 'edit',
}

/** Longest single-line title a card carries; longer ones are elided. */
const MAX_TITLE_LENGTH = 120

/**
 * How Claude Code's `Read` numbers the lines it returns: `%6d\t` in the CLI's
 * own output, i.e. a right-aligned line number, a tab, then the line.
 */
const READ_LINE = /^\s*(\d+)\t(.*)$/

/**
 * Project one mirrored Claude Code tool call onto a dsh pending-call card.
 *
 * @param name - the tool name exactly as Claude Code reported it (`Bash`, …).
 * @param input - the tool input, parsed. Anything at all is accepted: a
 *   non-object, a missing field and a wrong-typed field all degrade to the
 *   generic card rather than throwing.
 * @returns the card. Never undefined — every call gets at least a titled
 *   generic card with a category hint.
 */
export function presentCcToolCall(name: string, input: unknown): ToolCallView {
  const args = asRecord(input)
  if (args !== undefined) {
    const view = specificCall(name, args)
    if (view !== undefined) return view
  }
  return genericCall(name, args)
}

/**
 * Project one mirrored Claude Code tool result onto a dsh completed-call card.
 *
 * @param name - the tool name exactly as Claude Code reported it.
 * @param input - the tool input, parsed (a result card often needs the call's
 *   arguments — the path a `Read` read, the file an `Edit` changed).
 * @param outcome - the result text and its error flag.
 * @returns the card, or `undefined` to keep the pending card's title and let a
 *   UI render the raw result content — which is the right answer whenever this
 *   seam has nothing to add to it.
 */
export function presentCcToolResult(
  name: string,
  input: unknown,
  outcome: CcToolOutcome,
): ToolResultView | undefined {
  const args = asRecord(input) ?? {}
  // A failure is rendered as a failure, never as the card the happy path would
  // have produced: a diff card for an `Edit` that did not apply would show a
  // change that is not in the file.
  if (outcome.isError) return undefined

  if (name === 'Bash') {
    // No `exitCode`: Claude Code's `Bash` result carries the combined output and
    // an `is_error` flag, and nothing else (confirmed against the recorded
    // `tool-call` fixture). A synthesized `0` would put an exit-status pill on a
    // card for a status the CLI never reported.
    return { card: 'terminal', output: outcome.text }
  }
  if (name === 'Write' || name === 'Edit') {
    const diffs = fileDiffs(name, args)
    return diffs === undefined ? undefined : { card: 'diff', diffs }
  }
  if (name === 'Read') return readResult(args, outcome)
  return undefined
}

/**
 * The card for a tool whose SHAPE dsh has a first-class card for.
 * @param name - the Claude Code tool name.
 * @param args - the parsed input.
 * @returns the specific card, or undefined to fall back to a generic one.
 */
function specificCall(name: string, args: Record<string, unknown>): ToolCallView | undefined {
  if (name === 'Bash') return bashCall(args)
  if (name === 'Write' || name === 'Edit') return editCall(name, args)
  return undefined
}

/**
 * A `Bash` call as a terminal card.
 *
 * `run_in_background` deliberately does NOT get one: `dsh-tool-bash` makes the
 * same distinction (`packages/shell/tool-bash/src/index.ts:102-118`), because a
 * backgrounded command produces no output to fill a terminal card with — its
 * output arrives later, through a different call.
 *
 * @param args - the parsed input.
 * @returns the terminal card, or undefined when the command is not a usable string.
 */
function bashCall(args: Record<string, unknown>): TerminalCallView | undefined {
  const command = asNonEmptyString(args['command'])
  if (command === undefined) return undefined
  if (args['run_in_background'] === true) return undefined
  const description = asNonEmptyString(args['description'])
  return {
    card: 'terminal',
    title: elide(command),
    ...(description === undefined ? {} : { description: elide(description) }),
  }
}

/**
 * A `Write` or `Edit` call as an inline-diff card.
 * @param name - `Write` or `Edit`.
 * @param args - the parsed input.
 * @returns the diff card, or undefined when the arguments do not describe one.
 */
function editCall(name: string, args: Record<string, unknown>): DiffCallView | undefined {
  const diffs = fileDiffs(name, args)
  if (diffs === undefined) return undefined
  const path = diffs[0]?.path
  return {
    card: 'diff',
    title: elide(path === undefined ? name : `${name} ${basename(path)}`),
    diffs,
    ...(path === undefined ? {} : { locations: [{ path }] }),
  }
}

/**
 * The file change a `Write` or `Edit` describes.
 *
 * `Write`'s `oldText` is `null` whether the file is new or is being overwritten:
 * a call-time presenter cannot read the file, which is exactly what dsh's
 * {@link FileDiff} documents `null` to mean
 * (`packages/core/tools/src/presentation.ts:29-38`). `Edit` DOES have a before
 * image — `old_string` is the text being replaced — so it uses it.
 *
 * @param name - `Write` or `Edit`.
 * @param args - the parsed input.
 * @returns one diff, or undefined when the arguments are not a file change.
 */
function fileDiffs(name: string, args: Record<string, unknown>): FileDiff[] | undefined {
  const path = asNonEmptyString(args['file_path'])
  if (path === undefined) return undefined
  if (name === 'Write') {
    const content = asString(args['content'])
    return content === undefined ? undefined : [{ path, oldText: null, newText: content }]
  }
  const oldText = asString(args['old_string'])
  const newText = asString(args['new_string'])
  if (oldText === undefined || newText === undefined) return undefined
  return [{ path, oldText, newText }]
}

/**
 * A completed `Read` as a line-numbered code view.
 *
 * The CLI returns its own `cat -n`-style numbering, so the structured lines a
 * {@link ReadResultView} needs are recoverable — but only exactly. This parser
 * is deliberately strict: EVERY line must match {@link READ_LINE}, or the whole
 * projection is abandoned. A partial parse would show a file with lines missing
 * and no indication that any were, which is worse than the plain text card the
 * `undefined` return falls back to.
 *
 * `totalLines` is the count of what was RETURNED, not of the file: the result
 * text does not disclose the file's length, and dsh's field is documented as
 * exact ("showing N of M"). Reporting the window's own length is the only
 * honest reading available here — it makes "showing N of N" for a full read and
 * never claims a total the seam did not see.
 *
 * @param args - the parsed input.
 * @param outcome - the result text.
 * @returns the read card, or undefined when the output is not numbered text.
 */
function readResult(
  args: Record<string, unknown>,
  outcome: CcToolOutcome,
): ReadResultView | undefined {
  const path = asNonEmptyString(args['file_path'])
  if (path === undefined || outcome.text.length === 0) return undefined
  const raw = outcome.text.split('\n')
  // A trailing newline is a formatting artifact, not an empty final line.
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop()
  const lines: ReadFileLine[] = []
  for (const line of raw) {
    const match = READ_LINE.exec(line)
    if (match === null) return undefined
    const number = Number(match[1])
    if (!Number.isSafeInteger(number) || number < 1) return undefined
    lines.push({ number, text: match[2] ?? '' })
  }
  if (lines.length === 0) return undefined
  const lang = languageOf(path)
  return {
    card: 'read',
    path,
    offset: lines[0]?.number ?? 1,
    lines,
    totalLines: lines.length,
    ...(lang === undefined ? {} : { lang }),
  }
}

/**
 * The fallback card: a titled row with a category hint and the salient input.
 * @param name - the Claude Code tool name.
 * @param args - the parsed input, or undefined when it was not an object.
 * @returns the generic card.
 */
function genericCall(name: string, args: Record<string, unknown> | undefined): GenericCallView {
  const kind = TOOL_KINDS[name] ?? 'other'
  const salient = args === undefined ? undefined : salientInput(args)
  const locations = args === undefined ? undefined : fileLocations(args)
  return {
    card: 'generic',
    title: elide(salient === undefined ? name : `${name}: ${salient}`),
    kind,
    // `rawInput` is documented as the SALIENT input, "NOT the full raw args
    // object unless that is genuinely what a reader wants"
    // (presentation.ts:60-66) — so an unrecognized tool shows its whole input
    // (there is nothing better to pick) and a recognized one shows the field
    // that identifies the call.
    ...(salient === undefined ? (args === undefined ? {} : { rawInput: args }) : { rawInput: salient }),
    ...(locations === undefined ? {} : { locations }),
  }
}

/**
 * The one input field that identifies a call, for tools whose arguments have an
 * obvious subject.
 * @param args - the parsed input.
 * @returns the field's value, or undefined when none stands out.
 */
function salientInput(args: Record<string, unknown>): string | undefined {
  for (const field of ['file_path', 'path', 'pattern', 'query', 'url', 'command', 'notebook_path']) {
    const value = asNonEmptyString(args[field])
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Files a call touches, so a capable UI can follow along.
 * @param args - the parsed input.
 * @returns the locations, or undefined when the call names no file.
 */
function fileLocations(args: Record<string, unknown>): FileLocation[] | undefined {
  const path = asNonEmptyString(args['file_path']) ?? asNonEmptyString(args['notebook_path'])
  if (path === undefined) return undefined
  const offset = asPositiveInteger(args['offset'])
  return [{ path, ...(offset === undefined ? {} : { line: offset }) }]
}

/**
 * A syntax-highlighting hint from a file extension.
 *
 * Only extensions whose language is unambiguous map. An unknown one yields
 * nothing, and dsh renders plain text — which is what the field documents
 * (`packages/core/tools/src/presentation.ts:294-299`).
 *
 * @param path - the file path.
 * @returns the language hint, or undefined.
 */
function languageOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  const extension = path.slice(dot + 1).toLowerCase()
  return LANGUAGES[extension]
}

/** Extension → language hint. Deliberately small: an unknown extension renders as plain text. */
const LANGUAGES: Readonly<Record<string, string>> = {
  c: 'c', cjs: 'js', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go', h: 'c', hpp: 'cpp',
  html: 'html', java: 'java', js: 'js', json: 'json', jsx: 'jsx', kt: 'kotlin', md: 'md',
  mjs: 'js', php: 'php', py: 'py', rb: 'rb', rs: 'rust', scss: 'scss', sh: 'bash', sql: 'sql',
  swift: 'swift', toml: 'toml', ts: 'ts', tsx: 'tsx', xml: 'xml', yaml: 'yaml', yml: 'yaml',
}

/**
 * The last path segment, for a card title.
 * @param path - the file path.
 * @returns the basename, or the whole path when it has no separator.
 */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

/**
 * Collapse a title to one bounded line: a card header is a single row, and a
 * multi-line command would otherwise break the layout of every UI that shows it.
 * @param value - the raw title.
 * @returns the bounded single-line title.
 */
function elide(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length <= MAX_TITLE_LENGTH ? line : `${line.slice(0, MAX_TITLE_LENGTH - 1)}…`
}

/**
 * Narrow an unknown to a plain record.
 * @param value - the candidate.
 * @returns the record, or undefined.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Narrow an unknown to a string.
 * @param value - the candidate.
 * @returns the string, or undefined.
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Narrow an unknown to a non-empty string.
 * @param value - the candidate.
 * @returns the string, or undefined when absent, non-string or blank.
 */
function asNonEmptyString(value: unknown): string | undefined {
  const text = asString(value)
  return text === undefined || text.trim().length === 0 ? undefined : text
}

/**
 * Narrow an unknown to a positive safe integer.
 * @param value - the candidate.
 * @returns the integer, or undefined.
 */
function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
