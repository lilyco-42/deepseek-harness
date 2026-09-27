/** Default-browser startup over a real Loader tree and listening Web server. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { apply, inject as webAppInject, internals } from '../src/index.ts'

const contexts: Context[] = []
const tempRoots: string[] = []
const originalResolveDistIndex = internals.resolveDistIndex
const originalOpenBrowser = internals.openBrowser

beforeEach(() => {
  vi.stubEnv('SSH_CONNECTION', '')
  vi.stubEnv('SSH_TTY', '')
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  internals.resolveDistIndex = originalResolveDistIndex
  internals.openBrowser = originalOpenBrowser
  vi.unstubAllEnvs()
  Reflect.deleteProperty(globalThis, '__dshWebAppApply')
  Reflect.deleteProperty(globalThis, '__dshWebServer')
  Reflect.deleteProperty(globalThis, '__dshConnection')
  Reflect.deleteProperty(globalThis, '__dshFileUploads')
  Reflect.deleteProperty(globalThis, '__dshSessionController')
})

describe('web app browser startup', () => {
  it('opens the canonical URL only after the complete page is reachable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-web-browser-open-'))
    tempRoots.push(root)
    const dist = join(root, 'dist')
    mkdirSync(dist)
    const index = join(dist, 'index.html')
    writeFileSync(index, '<!doctype html><title>ready</title>')
    internals.resolveDistIndex = () => index

    const webserverModule = join(root, 'webserver.mjs')
    const connectionModule = join(root, 'connection.mjs')
    const webAppModule = join(root, 'web-app.mjs')
    writeFileSync(webserverModule, 'export default globalThis.__dshWebServer\n')
    writeFileSync(connectionModule, [
      "export const inject = ['webServer']",
      "export const apply = ctx => ctx.provide('connection', globalThis.__dshConnection)",
      '',
    ].join('\n'))
    writeFileSync(webAppModule, [
      "export const name = 'fixture-web-app'",
      "export const inject = ['webServer']",
      'export const apply = (ctx, config) => globalThis.__dshWebAppApply(ctx, config)',
      '',
    ].join('\n'))
    const config = join(root, 'cordis.yml')
    writeFileSync(config, [
      '- id: webserver',
      `  name: ${pathToFileURL(webserverModule).href}`,
      '  config:',
      '    host: 127.0.0.1',
      '    port: 0',
      '- id: connection',
      `  name: ${pathToFileURL(connectionModule).href}`,
      '- id: web-app',
      `  name: ${pathToFileURL(webAppModule).href}`,
      '  config:',
      '    openBrowser: true',
      '    printUrl: false',
      '    surfaceContext: false',
      '    trustedHosts: []',
      '',
    ].join('\n'))

    const globals = globalThis as unknown as {
      __dshWebAppApply: typeof apply
      __dshWebServer: typeof WebServer
      __dshConnection: {
        authenticatedUrl(baseUrl: string): string
        authorizeIndex(): boolean
        requestRejection(): undefined
        rpc: object
      }
    }
    globals.__dshWebAppApply = apply
    globals.__dshWebServer = WebServer
    globals.__dshConnection = {
      authenticatedUrl: (baseUrl) => {
        const url = new URL(baseUrl)
        url.searchParams.set('token', 'fixture-token')
        return url.href
      },
      authorizeIndex: () => true,
      requestRejection: () => undefined,
      rpc: {},
    }

    let openedUrl: string | undefined
    let openedStatus: number | undefined
    let resolveOpened!: () => void
    const opened = new Promise<void>((resolve) => { resolveOpened = resolve })
    internals.openBrowser = async (url) => {
      openedUrl = url
      openedStatus = (await fetch(url)).status
      resolveOpened()
    }

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(config).href },
    })
    await ctx.loader.await()
    await opened

    expect(openedUrl).toBe(`http://127.0.0.1:${String(ctx.webServer.port)}/?token=fixture-token`)
    expect(openedStatus).toBe(200)
  })

  it('boots the real Web composition through Loader before mounting the optional bridge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-web-bridge-loader-'))
    tempRoots.push(root)
    stageDistForLoader(root)

    const webserverModule = join(root, 'webserver.mjs')
    const connectionModule = join(root, 'connection.mjs')
    const fileUploadsModule = join(root, 'file-uploads.mjs')
    const sessionControllerModule = join(root, 'session-controller.mjs')
    const webAppModule = join(root, 'web-app.mjs')
    const server = {
      host: '127.0.0.1',
      port: 4567,
      registerFallback: vi.fn(() => () => {}),
      renderIndex: (html: string) => html,
      register: vi.fn(() => () => {}),
    }
    const connection = {
      authenticatedUrl: (url: string) => url,
      authorizeIndex: () => true,
      requestRejection: () => undefined,
      rpc: {},
    }
    vi.stubGlobal('__dshWebAppApply', apply)
    vi.stubGlobal('__dshWebServer', server)
    vi.stubGlobal('__dshConnection', connection)
    vi.stubGlobal('__dshFileUploads', {})
    vi.stubGlobal('__dshSessionController', {})

    writeFileSync(webserverModule, [
      "export function apply(ctx) { ctx.provide('webServer', globalThis.__dshWebServer) }",
      '',
    ].join('\n'))
    writeFileSync(connectionModule, [
      "export const inject = ['webRuntime']",
      "export function apply(ctx) { ctx.provide('connection', globalThis.__dshConnection) }",
      '',
    ].join('\n'))
    writeFileSync(fileUploadsModule, [
      "export const inject = ['connection']",
      "export function apply(ctx) { ctx.provide('fileUploads', globalThis.__dshFileUploads) }",
      '',
    ].join('\n'))
    writeFileSync(sessionControllerModule, [
      "export const inject = ['fileUploads']",
      "export function apply(ctx) { ctx.provide('sessionController', globalThis.__dshSessionController) }",
      '',
    ].join('\n'))
    writeFileSync(webAppModule, [
      "export const name = 'web-app'",
      `export const inject = ${JSON.stringify(webAppInject)}`,
      'export const apply = (ctx, config) => globalThis.__dshWebAppApply(ctx, config)',
      '',
    ].join('\n'))

    const config = join(root, 'cordis.yml')
    writeFileSync(config, [
      '- id: webserver',
      `  name: ${pathToFileURL(webserverModule).href}`,
      '- id: connection',
      `  name: ${pathToFileURL(connectionModule).href}`,
      '- id: file-uploads',
      `  name: ${pathToFileURL(fileUploadsModule).href}`,
      '- id: session-controller',
      `  name: ${pathToFileURL(sessionControllerModule).href}`,
      '- id: web-app',
      `  name: ${pathToFileURL(webAppModule).href}`,
      '  config:',
      '    openBrowser: false',
      '    printUrl: false',
      '    surfaceContext: false',
      '    trustedHosts: []',
      '    enableLain42Bridge: true',
      '',
    ].join('\n'))

    vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', 'test-only-lain42-bridge-secret-with-32-bytes')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(config).href },
    })
    await ctx.loader.await()

    await vi.waitFor(() => {
      expect(ctx.get('webRuntime')).toEqual({ lanAddresses: [], trustedHosts: [] })
      expect(ctx.get('sessionController')).toBeDefined()
      expect(server.register).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'exact',
        path: '/lain42/bridge/v1/turn',
        handler: expect.any(Function),
      }))
    })
  })
})

/** Stage the frontend shell for a Loader boot without relying on a repo build. */
function stageDistForLoader(root: string): void {
  const dist = join(root, 'dist')
  mkdirSync(dist)
  const index = join(dist, 'index.html')
  writeFileSync(index, '<!doctype html><title>loader fixture</title>')
  internals.resolveDistIndex = () => index
}
