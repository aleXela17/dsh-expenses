/**
 * Host half of `@local/dsh-expenses`.
 *
 * Registers one client-visible Session projection unit, `expenses`, that folds
 * the durable log of every Session into token totals per model, tool-call and
 * model-request counts, the latest title, and per-local-day buckets. The Session
 * projection seam carries the value to the browser (session summaries, exact
 * projection reads, and the change feed), so no custom Remote namespace is needed.
 *
 * Counting rules:
 * - one `assistant/message` = one model request; its `usage` contributes tokens
 *   to the model named by `message.source.model`;
 * - one `tool/call` = one tool invocation;
 * - `session/title` keeps the latest accepted title;
 * - day buckets use the Host's local calendar, which is the user's calendar on
 *   a desktop Host.
 *
 * Per-model buckets exist so the browser half can price each model with its own
 * tariff instead of a single blended rate.
 *
 * The projection registry validates state and view through `schema.parse`. The
 * unit declares a plain validating parser instead of a zod schema so the plugin
 * keeps zero runtime dependencies; the registry never calls anything else.
 *
 * @module @local/dsh-expenses
 */

/** Cordis plugin name. */
export const name = 'expenses'

/** The projection registry is the whole purpose of the Host half. */
export const inject = ['sessionProjections']

/** Projection key shared with the browser half. */
const PROJECTION_KEY = 'expenses'

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
  return { input: 0, output: 0, requests: 0 }
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

/** The `expenses` projection unit (exported for its unit spec). */
export const expensesUnit = {
  key: PROJECTION_KEY,
  stateVersion: 2,
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
        const usage = event.data?.usage
        const input = count(usage?.inputTokens)
        const output = count(usage?.outputTokens)
        const model = modelOf(event)
        const day = dayKey(event.time)
        const previous = Object.hasOwn(state.models, model) ? state.models[model] : emptyModelBucket()
        const dayBucket = Object.hasOwn(state.days, day) ? state.days[day] : emptyDay()
        const dayPrevious = Object.hasOwn(dayBucket.models, model) ? dayBucket.models[model] : emptyModelBucket()
        return {
          ...state,
          models: {
            ...state.models,
            [model]: {
              input: previous.input + input,
              output: previous.output + output,
              requests: previous.requests + 1,
            },
          },
          days: {
            ...state.days,
            [day]: {
              toolCalls: dayBucket.toolCalls,
              models: {
                ...dayBucket.models,
                [model]: {
                  input: dayPrevious.input + input,
                  output: dayPrevious.output + output,
                  requests: dayPrevious.requests + 1,
                },
              },
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

/**
 * Register the unit; the registration is an effect on this plugin's fiber, so
 * unloading the plugin removes the key from every read face.
 * @param ctx - registrant context carrying the projection registry.
 */
export async function apply(ctx) {
  await ctx.sessionProjections.register(expensesUnit)
}
