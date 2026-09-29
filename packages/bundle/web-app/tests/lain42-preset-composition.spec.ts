/** The shipped Lain42 presets must assemble the intended model prompts and tools through Loader. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as Persona from '@deepseek-ai/dsh-persona'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import * as Lain42Tools from '../src/lain42-tools.ts'
import { expect, it, onTestFinished } from 'vitest'
import { expectedLain42AgentPrompts } from './expected/lain42-agent-prompts.ts'

const modes = [
  { mode: 'general', preset: 'lain42-web' },
  { mode: 'coding', preset: 'lain42-web-coding' },
  { mode: 'research', preset: 'lain42-web-research' },
  { mode: 'content', preset: 'lain42-web-content' },
] as const

it('loads each shipped browser preset and exposes only its pinned prompt and account-scoped read tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lain42-presets-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  const fixtureRows = loadOverlayPatches(
    'lain42-agent-test-base',
    fileURLToPath(new URL('./fixtures/lain42-agent/cordis.yml', import.meta.url))
  ).flatMap(patch => patch.insert ?? [])
  const presetRows = loadOverlayPatches(
    'lain42-agent-shipped-presets',
    fileURLToPath(new URL('../presets/lain42-web.patch.yml', import.meta.url))
  ).flatMap(patch => patch.insert ?? [])
  expect(presetRows.map(row => (row.config as { id?: unknown } | undefined)?.id))
    .toEqual(modes.map(row => row.preset))

  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...fixtureRows, ...presetRows]))
  ctx.baseUrl = `${pathToFileURL(directory).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent-preset-registry', AgentPresets],
    ['@deepseek-ai/dsh-agent-preset', AgentPreset],
    ['@deepseek-ai/dsh-persona', Persona],
    ['@deepseek-ai/dsh-tool-web', ToolWeb],
    ['@deepseek-ai/dsh-web-app/lain42-tools', Lain42Tools],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
    resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()

  const roster = await ctx.agentPresets.list()
  expect(roster.map(row => row.id)).toEqual(modes.map(({ preset }) => preset))
  expect(roster.every(row => row.broken === undefined)).toBe(true)

  for (const { mode, preset } of modes) {
    const scope = createScope(ctx, {})
    try {
      await ctx.agentPresets.mount(scope.ctx, preset)
      const key = scopeOf(scope.ctx)
      if (key === undefined) throw new Error(`Expected a mounted scope for ${mode}`)
      const assembly = await ctx.systemPrompt.assemble({ scope: key })
      expect(assembly.sections.find(section => section.name === PERSONA_PREFIX_SECTION)?.text)
        .toBe(expectedLain42AgentPrompts.prompts[mode])
      expect(assembly.tools.map(tool => tool.name).sort())
        .toEqual(expectedLain42AgentPrompts.tools)
    } finally {
      await scope.dispose()
    }
  }
})
