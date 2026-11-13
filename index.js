/**
 * Host half of `@local/dsh-expenses`.
 *
 * Registers one client-visible Session projection unit, `expenses`, that folds
 * the durable log of every Session into token totals per model (input, output,
 * cache read, cache write), tool-call and model-request counts, the latest
 * title, and per-local-day buckets. The Session projection seam carries the
 * value to the browser (session summaries, exact projection reads, and the
 * change feed).
 *
 * Cost is NOT computed here: the unit only reports tokens. Prices come from the
 * live Polza catalogue (`GET /api/v1/models`, which quotes cache reads and
 * writes separately) through the `GET /api-expenses/prices` route below, and the
 * browser half prices every bucket with them. The route also returns the account
 * balance so the page can show what the provider actually charged.
 *
 * Counting rules:
 * - one `assistant/message` = one model request; its `usage` contributes tokens
 *   to the model named by `message.source.model`;
 * - one `tool/call` = one tool invocation;
 * - `session/title` keeps the latest accepted title;
 * - day buckets use the Host's local calendar, which is the user's calendar on
 *   a desktop Host.
 *
 * stateVersion 3 adds cache tokens per model bucket. A stored checkpoint whose
 * `ver` no longer matches is refolded from the full log by the projection
 * registry, so older Sessions report their cache volume after the upgrade too.
 *
 * The projection registry validates state and view through `schema.parse`. The
 * unit declares a plain validating parser instead of a zod schema so the plugin
 * keeps zero runtime dependencies; the registry never calls anything else.
 *
 * @module @local/dsh-expenses
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name. */
export const name = 'expenses'

/** The projection registry is the whole purpose of the Host half. */
export const inject = ['sessionProjections']

/** Projection key shared with the browser half. */
const PROJECTION_KEY = 'expenses'

/** Route the browser half reads prices from. */
export const PRICES_PATH = '/api-expenses/prices'

/** Polza endpoints. `models` quotes per-million prices including cache reads. */
const POLZA_MODELS_URL = 'https://polza.ai/api/v1/models'
const POLZA_BALANCE_URL = 'https://polza.ai/api/v1/balance'

/** Credential ref holding the Polza API key. */
const API_KEY_REF = 'POLZA_AI_API_KEY'

/** How long a fetched catalogue stays fresh, in milliseconds. */
const CATALOG_TTL_MS = 30 * 60 * 1000

/** One local calendar day. */
function dayKey(time) {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return '1970-01-01'
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** A finite non-negative count, or zero. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** One model bucket with every metric reset. */
function emptyModelBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
}

/** One day bucket with every metric reset. */
function emptyDay() {
  return { toolCalls: 0, models: {} }
}

/** The model that served one assistant message, or a stable placeholder. */
function modelOf(event) {
  const model = event.data?.message?.source?.model
  return typeof model === 'string' && model.length > 0 ? model : 'unknown'
}

function readModelBucket(value) {
  const bucket = emptyModelBucket()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return bucket
  bucket.input = count(value.input)
  bucket.output = count(value.output)
  bucket.cacheRead = count(value.cacheRead)
  bucket.cacheWrite = count(value.cacheWrite)
  bucket.requests = count(value.requests)
  return bucket
}

function readModelMap(value) {
  const models = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return models
  for (const key of Object.keys(value)) {
    if (key.length === 0) continue
    models[key] = readModelBucket(value[key])
  }
  return models
}

function readDay(value) {
  const day = emptyDay()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return day
  day.toolCalls = count(value.toolCalls)
  day.models = readModelMap(value.models)
  return day
}

function readDays(value) {
  const days = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return days
  for (const key of Object.keys(value)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(key) === false) continue
    days[key] = readDay(value[key])
  }
  return days
}

function invalid(what) {
  throw new TypeError(`expenses projection: ${what}`)
}

/**
 * The unit's state and wire view are the same plain-JSON record, so one parser
 * serves as both `stateSchema` (checkpoint rows) and `viewSchema` (wire reads).
 */
const expensesSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('value must be an object')
    return {
      createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : 0,
      title: typeof value.title === 'string' && value.title.length > 0 ? value.title : null,
      toolCalls: count(value.toolCalls),
      models: readModelMap(value.models),
      days: readDays(value.days),
    }
  },
}

/** Fold one assistant message's usage into a model bucket. */
function addUsage(bucket, usage) {
  return {
    input: bucket.input + count(usage?.inputTokens),
    output: bucket.output + count(usage?.outputTokens),
    cacheRead: bucket.cacheRead + count(usage?.cacheReadTokens),
    cacheWrite: bucket.cacheWrite + count(usage?.cacheWriteTokens),
    requests: bucket.requests + 1,
  }
}

/** The `expenses` projection unit (exported for its unit spec). */
export const expensesUnit = {
  key: PROJECTION_KEY,
  stateVersion: 3,
  stateSchema: expensesSchema,
  init: (header) => ({
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : 0,
    title: null,
    toolCalls: 0,
    models: {},
    days: {},
  }),
  apply: (state, event) => {
    switch (event.type) {
      case 'assistant/message': {
        const model = modelOf(event)
        const day = dayKey(event.time)
        const previous = Object.hasOwn(state.models, model) ? state.models[model] : emptyModelBucket()
        const dayBucket = Object.hasOwn(state.days, day) ? state.days[day] : emptyDay()
        const dayPrevious = Object.hasOwn(dayBucket.models, model) ? dayBucket.models[model] : emptyModelBucket()
        return {
          ...state,
          models: { ...state.models, [model]: addUsage(previous, event.data?.usage) },
          days: {
            ...state.days,
            [day]: {
              toolCalls: dayBucket.toolCalls,
              models: { ...dayBucket.models, [model]: addUsage(dayPrevious, event.data?.usage) },
            },
          },
        }
      }
      case 'tool/call': {
        const day = dayKey(event.time)
        const dayBucket = Object.hasOwn(state.days, day) ? state.days[day] : emptyDay()
        return {
          ...state,
          toolCalls: state.toolCalls + 1,
          days: { ...state.days, [day]: { ...dayBucket, toolCalls: dayBucket.toolCalls + 1 } },
        }
      }
      case 'session/title': {
        const title = event.data?.title
        if (typeof title !== 'string' || title.length === 0 || title === state.title) return state
        return { ...state, title }
      }
      default:
        return state
    }
  },
  wire: {
    viewSchema: expensesSchema,
    view: (state) => state,
    summary: true,
  },
}

// ---------------------------------------------------------------------------
// Live prices: Polza catalogue, cached in the Host process and served to the
// browser half. The page never prices a model from a hard-coded table when the
// catalogue is reachable, because the provider's tariff — cache reads above
// all — is what the bill actually uses.
// ---------------------------------------------------------------------------

/** `~/.dsh`, or DSH_HOME when the Host was started with one. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/**
 * Read one `refs:` entry from `~/.dsh/.credentials.yaml`.
 * This is the fallback for a Host build without a `credentials` service; the
 * service itself is preferred because it also resolves keychain-backed refs.
 * @param ref - credential ref name, for example `POLZA_AI_API_KEY`.
 */
function readCredentialRef(ref) {
  try {
    const raw = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
    let inRefs = false
    for (const line of raw.split('\n')) {
      if (line === 'refs:') {
        inRefs = true
        continue
      }
      if (!inRefs) continue
      if (line.startsWith('  ') === false) {
        inRefs = false
        continue
      }
      const at = line.indexOf(':', 2)
      if (at === -1) continue
      if (line.slice(2, at).trim() !== ref) continue
      let value = line.slice(at + 1).trim()
      if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
        value = value.slice(1, -1)
      }
      return value.length > 0 ? value : ''
    }
  } catch {
    /* no credential store on this Host */
  }
  return ''
}

/** Resolve the Polza API key: environment, credentials service, credential file. */
async function resolveApiKey(ctx) {
  const fromEnv = process.env[API_KEY_REF]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(API_KEY_REF)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    } catch {
      /* fall through to the credential file */
    }
  }
  return readCredentialRef(API_KEY_REF)
}

/** A finite price, or null when the provider did not quote one. */
function priceValue(raw) {
  const value = typeof raw === 'string' ? Number(raw) : raw
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** One catalogue entry from a `/models` row, or null when it carries no price. */
function catalogueEntry(row) {
  const pricing = row?.top_provider?.pricing
  if (pricing === null || typeof pricing !== 'object') return null
  const input = priceValue(pricing.prompt_per_million)
  const output = priceValue(pricing.completion_per_million)
  if (input === null || output === null) return null
  return {
    input,
    output,
    cacheRead: priceValue(pricing.input_cache_read_per_million) ?? 0,
    cacheWrite: priceValue(pricing.input_cache_write_per_million) ?? 0,
    label: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id,
  }
}

/** Normalize one balance payload into rubles, or null. */
function balanceSnapshot(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const spent = priceValue(raw.spentAmount)
  const available = priceValue(raw.available)
  if (spent === null && available === null) return null
  return {
    spent,
    available,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  }
}

/** Fetch the catalogue and balance once. Throws on an unusable response. */
async function fetchCatalogue(ctx) {
  const key = await resolveApiKey(ctx)
  if (key.length === 0) throw new Error(`no ${API_KEY_REF} on this Host`)
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  const modelResponse = await fetch(POLZA_MODELS_URL, { headers })
  if (modelResponse.ok === false) throw new Error(`models: HTTP ${modelResponse.status}`)
  const payload = await modelResponse.json()
  const prices = {}
  for (const row of Array.isArray(payload?.data) ? payload.data : []) {
    const entry = catalogueEntry(row)
    if (entry === null || typeof row?.id !== 'string' || row.id.length === 0) continue
    prices[row.id] = entry
  }
  if (Object.keys(prices).length === 0) throw new Error('models: empty catalogue')
  let balance = null
  try {
    const balanceResponse = await fetch(POLZA_BALANCE_URL, { headers })
    if (balanceResponse.ok) balance = balanceSnapshot(await balanceResponse.json())
  } catch {
    /* the balance line is a nicety, not a requirement */
  }
  const currency = typeof payload?.data?.[0]?.top_provider?.pricing?.currency === 'string'
    ? payload.data[0].top_provider.pricing.currency
    : 'RUB'
  return { currency, prices, balance }
}

/**
 * Register the unit and the price route. The unit registration is an effect on
 * this plugin's fiber, so unloading the plugin removes the key from every read
 * face; the route is registered on the web server's fiber for the same reason.
 * @param ctx - registrant context carrying the projection registry.
 */
export async function apply(ctx) {
  await ctx.sessionProjections.register(expensesUnit)

  /** Catalogue cache: served stale while a refresh runs, refetched on demand. */
  const cache = { data: null, fetchedAt: 0, error: null, inflight: null }

  function refresh() {
    if (cache.inflight !== null) return cache.inflight
    cache.inflight = fetchCatalogue(ctx)
      .then((data) => {
        cache.data = data
        cache.fetchedAt = Date.now()
        cache.error = null
        return data
      })
      .catch((failure) => {
        cache.error = failure instanceof Error ? failure.message : String(failure)
        throw failure
      })
      .finally(() => {
        cache.inflight = null
      })
    return cache.inflight
  }

  ctx.inject(['webServer'], (webCtx) => {
    // The connection gate keeps this route behind the same cookie and origin
    // check as the Host's own pages; a browser on another origin must not be
    // able to read the account balance through it.
    let connection = null
    ctx.inject(['connection'], (connectionCtx) => {
      connection = connectionCtx.connection
      return () => {
        connection = null
      }
    })

    function reject(req, res) {
      const gate = connection
      // A Host without the connection service predates web authentication, so
      // there is nothing to enforce and the page must still get its prices.
      if (gate === null || gate === undefined) return false
      if (typeof gate.requestRejection !== 'function') return false
      let rejection
      try {
        rejection = gate.requestRejection(req)
      } catch {
        rejection = 503
      }
      if (rejection === undefined) return false
      res.writeHead(rejection, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(rejection === 401 ? 'dsh web authentication required; reopen the URL printed by dsh web.\n' : 'forbidden\n')
      return true
    }

    function sendJson(res, status, body) {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'Content-Length': Buffer.byteLength(text),
      })
      res.end(text)
    }

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: PRICES_PATH,
          async handler(req, res) {
            if (reject(req, res)) return
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { Allow: 'GET, HEAD' })
              res.end()
              return
            }
            const age = Date.now() - cache.fetchedAt
            if (cache.data === null) {
              try {
                await refresh()
              } catch {
                /* reported below as an empty catalogue */
              }
            } else if (age > CATALOG_TTL_MS) {
              refresh().catch(() => {})
            }
            if (req.method === 'HEAD') {
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end()
              return
            }
            if (cache.data === null) {
              sendJson(res, 200, { ok: false, error: cache.error ?? 'price catalogue unavailable' })
              return
            }
            sendJson(res, 200, {
              ok: true,
              ...cache.data,
              fetchedAt: cache.fetchedAt,
              stale: Date.now() - cache.fetchedAt > CATALOG_TTL_MS,
            })
          },
        }),
      'dsh-expenses: prices route',
    )
  })
}
