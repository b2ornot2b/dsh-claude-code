/**
 * Stretch goal: does the published .d.ts surface typecheck out-of-tree, and do
 * the packages' `declare module '@deepseek-ai/cordis'` augmentations land so
 * `ctx.approval` / `ctx.userQuestions` are typed without any cast?
 */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

export async function boot(): Promise<ApprovalOutcome> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(ApprovalService, { policy: 'ask' })

  // Typed service accessors, straight off the augmented Context interface.
  const session = ctx.sessions.create(SessionId('typed-spike'))
  session.append('turn/start', { turn: 1 })
  const agent = { id: SessionId('typed-spike'), session } as unknown as Agent

  ctx.userQuestions.registerProvider({
    ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
      return Promise.resolve({ answers: request.questions.map(q => ({ id: q.id, selected: [q.options?.[0]?.label ?? ''] })) })
    },
  })
  await ctx.userQuestions.ask({
    questions: [{ id: 'q1', question: 'typed?', options: [{ label: 'a' }, { label: 'b' }] }],
  })

  ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  // ctx.get() narrows to `X | undefined`; the typed accessor does not.
  const approval = ctx.get('approval')
  if (approval === undefined) throw new Error('approval not mounted')
  return await approval.request({ agent, toolName: 'Bash' })
}
