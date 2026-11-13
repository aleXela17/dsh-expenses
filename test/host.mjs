// Host-half verification: projection fold + the prices route against the live Polza API.
import { pathToFileURL } from 'node:url'

const target = process.argv[2] ? pathToFileURL(process.argv[2]).href : new URL('../index.js', import.meta.url).href
const { apply, expensesUnit, PRICES_PATH, tokenDelta, todayTokens } = await import(target)

const registrations = []
const routes = []
const services = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  connection: { requestRejection: () => undefined },
}

const ctx = {
  sessionProjections: { register: async (unit) => registrations.push(unit) },
  get: (name) => services[name],
  inject: (deps, callback) => {
    const sub = { ...ctx, effect: (fn) => fn() }
    for (const dep of deps) sub[dep] = services[dep]
    return callback(sub)
  },
  effect: (fn) => fn(),
}

await apply(ctx)

const failures = []
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures.push(name)
}

check('unit registered', registrations.length === 1)
check('stateVersion is 3', registrations[0]?.stateVersion === 3, String(registrations[0]?.stateVersion))
check('route registered', routes.length === 1 && routes[0].path === PRICES_PATH, routes.map((r) => r.path).join(','))

// Fold one assistant message with cache tokens and one tool call.
const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 20000, cacheWriteTokens: 5 }
let state = expensesUnit.init({ createdAt: 1 })
state = expensesUnit.apply(state, {
  type: 'assistant/message',
  time: 1794214513802,
  data: { message: { source: { model: 'deepseek/deepseek-v4.1-flash-1017' } }, usage },
})
state = expensesUnit.apply(state, { type: 'tool/call', time: 1794214513902, data: {} })
const bucket = state.models['deepseek/deepseek-v4.1-flash-1017']
check(
  'cache tokens folded',
  bucket?.cacheRead === 20000 && bucket?.cacheWrite === 5 && bucket?.input === 1000 && bucket?.requests === 1,
  JSON.stringify(bucket),
)
const day = state.days['2026-11-09']
check('day bucket keeps cache', day?.models['deepseek/deepseek-v4.1-flash-1017']?.cacheRead === 20000)
check('tool call counted', state.toolCalls === 1)
const reparsed = expensesUnit.stateSchema.parse(JSON.parse(JSON.stringify(state)))
check('schema round-trip', reparsed.models['deepseek/deepseek-v4.1-flash-1017'].cacheWrite === 5)

// Watchdog: the ledger read is optional, but the arithmetic must be exact.
const bucketOf = (input, cacheRead, requests) => ({ input, output: 0, cacheRead, cacheWrite: 0, requests })
const delta = tokenDelta({ m: bucketOf(10, 5, 2) }, { m: bucketOf(4, 9, 1) })
check(
  'token delta subtracts and floors at zero',
  delta.m.input === 6 && delta.m.cacheRead === 0 && delta.m.requests === 1,
  JSON.stringify(delta),
)
check('delta ignores models absent from the baseline', tokenDelta({ fresh: bucketOf(7, 0, 1) }, {}).fresh.input === 7)
const ledgerToday = todayTokens(Date.now())
check('ledger is readable', ledgerToday !== null, ledgerToday === null ? 'no usage-ledger.json' : ledgerToday.day)

// Drive the route with a real request to polza.ai.
const result = await new Promise((resolve) => {
  const req = { method: 'GET', url: PRICES_PATH, headers: {} }
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.body = text ?? ''
      resolve({ status: this.status, body: this.body })
    },
  }
  Promise.resolve(routes[0].handler(req, res)).catch((error) => resolve({ status: -1, body: String(error) }))
})

const body = result.body ? JSON.parse(result.body) : {}
check('route answers 200', result.status === 200, String(result.status))
check('live catalogue ok', body.ok === true, body.error ?? '')
check('catalogue non-trivial', Object.keys(body.prices ?? {}).length > 250, `${Object.keys(body.prices ?? {}).length} priced models`)
const flash = body.prices?.['deepseek/deepseek-v4.1-flash-1017']
check(
  'flash tariff matches API',
  flash && Math.abs(flash.input - 8.65693786) < 1e-6 && Math.abs(flash.cacheRead - 0.8333136) < 1e-6,
  JSON.stringify(flash),
)
check('balance present', typeof body.balance?.spent === 'number', JSON.stringify(body.balance))
check(
  'watchdog payload present',
  body.watch === null || (typeof body.watch === 'object' && typeof body.watch.budget === 'number'),
  JSON.stringify(body.watch && { budget: body.watch.budget, day: body.watch.day }),
)
check('currency is RUB', body.currency === 'RUB', String(body.currency))

if (flash) {
  const cost =
    (1_000_000 / 1e6) * flash.input +
    (1_000_000 / 1e6) * flash.output +
    (100_000_000 / 1e6) * flash.cacheRead
  console.log(`synthetic cost for 1M in + 1M out + 100M cache: ${cost.toFixed(2)} ₽`)
  check('cache dominates the bill', cost > 80, cost.toFixed(2))
}

console.log(failures.length === 0 ? '\nALL HOST CHECKS PASSED' : `\nFAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
