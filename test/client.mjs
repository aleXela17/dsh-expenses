// Client-half verification: render the panel with a mini React and assert the
// costs, the cache column and the fallback path.
import fs from 'node:fs'

const target = process.argv[2] ?? new URL('../client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const source = fs.readFileSync(target, 'utf8')

let factory = null
const windowStub = { __ModuleLoader__: { load: ({ factory: f }) => (factory = f) } }
new Function('window', source)(windowStub)
if (!factory) throw new Error('factory not captured')

const failures = []
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures.push(name)
}

const CATALOGUE = {
  ok: true,
  currency: 'RUB',
  fetchedAt: Date.now(),
  balance: { spent: 1716.57, available: 670.96, updatedAt: null },
  prices: {
    'deepseek/deepseek-v4.1-flash-1017': {
      input: 8.65693786,
      output: 12.8568384,
      cacheRead: 0.8333136,
      cacheWrite: 0,
      label: 'DeepSeek: DeepSeek V4.1 Flash 1017',
    },
    // Prefix-less journal id must resolve through the suffix match.
    'deepseek/deepseek-flash': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, label: 'DeepSeek flash alias' },
  },
}

const now = Date.now()
const flashDay = (input, output, cacheRead) => ({
  toolCalls: 3,
  models: {
    'deepseek/deepseek-v4.1-flash-1017': { input, output, cacheRead, cacheWrite: 0, requests: 4 },
  },
})

const ROWS = [
  {
    sessionId: 's1',
    updatedAt: now,
    projections: {
      values: {
        expenses: {
          createdAt: now,
          title: 'Test session',
          toolCalls: 3,
          models: {
            'deepseek/deepseek-v4.1-flash-1017': {
              input: 1_000_000,
              output: 1_000_000,
              cacheRead: 100_000_000,
              cacheWrite: 0,
              requests: 4,
            },
            'deepseek-flash': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 },
          },
          days: { localToday: flashDay(1_000_000, 1_000_000, 100_000_000) },
        },
      },
    },
  },
]
// The day key is computed by the module against the local calendar.
const d = new Date(now)
const pad = (v) => String(v).padStart(2, '0')
const todayKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
ROWS[0].projections.values.expenses.days = { [todayKey]: flashDay(1_000_000, 1_000_000, 100_000_000) }

const remote = {
  session: {
    list: async () => ({ items: ROWS.map(({ sessionId, updatedAt, projections }) => ({ sessionId, updatedAt, projections })) }),
    projections: async () => ({ values: ROWS[0].projections.values }),
  },
}

let fetchMode = 'live'

// --- mini React with hooks and a render loop ------------------------------
let hookIndex = 0
let cells = []
let effects = []
let dirty = false
const REFS = []
const REACT = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(3) }),
  useState(initial) {
    const at = hookIndex++
    if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
    return [
      cells[at],
      (value) => {
        const next = typeof value === 'function' ? value(cells[at]) : value
        if (next !== cells[at]) {
          cells[at] = next
          dirty = true
        }
      },
    ]
  },
  useMemo(fn) {
    hookIndex++
    return fn()
  },
  useCallback(fn) {
    hookIndex++
    return fn
  },
  useEffect(fn) {
    const at = hookIndex++
    if (REFS[at] !== true) {
      REFS[at] = true
      effects.push(fn)
    }
  },
  useRef(initial) {
    const at = hookIndex++
    if (!(at in cells)) cells[at] = { current: initial }
    return cells[at]
  },
}

globalThis.fetch = async () => {
  if (fetchMode === 'down') return { ok: false, status: 503, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => CATALOGUE }
}

const module = factory((name) => {
  if (name !== 'react') throw new Error(`unexpected require: ${name}`)
  return REACT
})

const ctx = {
  remote,
  get: (name) => (name === 'remote' ? remote : undefined),
  effect: (fn) => fn(),
  slots: {
    injected: [],
    register(spec, component) {
      this.injected.push({ spec, component })
      return () => {}
    },
    inject(name, callback) {
      callback()
    },
  },
}

module.apply(ctx)
const panel = ctx.slots.injected.find((entry) => entry.spec.name === 'main')?.component
if (!panel) throw new Error('panel not registered')

function walk(node, out) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  walk(node.children, out)
  return out
}

async function renderUntilStable() {
  let tree = null
  for (let round = 0; round < 40; round += 1) {
    hookIndex = 0
    dirty = false
    tree = panel({})
    const pending = effects
    effects = []
    for (const fn of pending) fn()
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (!dirty) break
  }
  return tree
}

const parseRubles = (strings) =>
  strings
    .map((text) => /([\d\s\u00a0]+[.,]\d{2})\s*₽/.exec(text)?.[1]?.replace(/[\s\u00a0]/g, '').replace(',', '.'))
    .filter(Boolean)
    .map(Number)

const tree = await renderUntilStable()
const texts = walk(tree, [])

const flashCost = 8.65693786 + 12.8568384 + 83.33136
const aliasCost = 1
const total = flashCost + aliasCost

check('title rendered', texts.includes('Expenses'))
check('cache header present', texts.includes('Cache'))
check('cache metric label present', texts.includes('Cache read tokens'))
check('live tariff note', texts.some((text) => text.includes('live Polza catalogue')), texts.find((t) => t.includes('Polza')))
check('balance line', texts.some((text) => text.includes('Charged by Polza')), texts.find((t) => t.includes('Charged')))
check('session row rendered', texts.includes('Test session'))

const rubles = parseRubles(texts)
const hasTotal = rubles.some((value) => Math.abs(value - total) < 0.02)
const hasFlashAlone = rubles.some((value) => Math.abs(value - flashCost) < 0.02)
check('total cost includes cache', hasTotal, `expected ${total.toFixed(2)}, got ${rubles.join(', ')}`)
check('today card priced', hasFlashAlone, `expected ${flashCost.toFixed(2)}`)
check(
  'cache tokens in table',
  texts.some((text) => text.replace(/[\s\u00a0,]/g, '') === '100000000'),
  `cells: ${texts.slice(-14).join(' | ')}`,
)
check('tools column value', texts.includes('3'))

// --- fallback path -------------------------------------------------------
fetchMode = 'down'
cells = []
REFS.length = 0
effects = []
const fallbackTree = await renderUntilStable()
const fallbackTexts = walk(fallbackTree, [])
check(
  'fallback tariff note',
  fallbackTexts.some((text) => text.includes('built-in table, Polza API unavailable')),
  fallbackTexts.find((t) => t.includes('built-in table')),
)
const fallbackRubles = parseRubles(fallbackTexts)
check(
  'fallback still prices with cache',
  fallbackRubles.some((value) => Math.abs(value - flashCost) < 0.02) &&
    fallbackRubles.some((value) => value > 100),
  `got ${fallbackRubles.join(', ')}`,
)

console.log(failures.length === 0 ? '\nALL CLIENT CHECKS PASSED' : `\nFAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
