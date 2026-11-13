/**
 * Browser half of `@local/dsh-expenses`.
 *
 * Adds the "Expenses" entry to the sidebar panel list and its page to the main
 * panel. The page reads the Host `expenses` projection per Session through the
 * existing session Remote namespace, then shows per-Session token usage and the
 * cost in rubles.
 *
 * Prices come from `GET /api-expenses/prices`, the Host-side proxy over Polza's
 * live catalogue. That catalogue quotes input, output, cache read and cache
 * write separately, and cache reads are what dominate a long agent session: on
 * this Host they were 77% of five days of spend. The built-in table below is
 * only a fallback for an unreachable catalogue, so the page still shows a
 * number instead of a dash.
 *
 * @module @local/dsh-expenses/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-expenses',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'expenses'
    const PROJECTION_KEY = 'expenses'
    const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

    /** Host route serving Polza's live catalogue (see `index.js`). */
    const PRICES_PATH = '/api-expenses/prices'

    /**
     * Fallback tariffs in rubles per 1M tokens, used only when the Host route
     * cannot reach Polza. Values are copied from `GET /api/v1/models`
     * (`top_provider.pricing`) on 2026-11-13, cache rates included — a tariff
     * without its cache rate understates a long session by an order of
     * magnitude.
     */
    const FALLBACK_TARIFFS = [
      {
        id: 'deepseek/deepseek-v4.1-flash-1017',
        match: (model) => model.includes('flash'),
        label: 'DeepSeek V4.1 Flash',
        input: 8.65693786,
        output: 12.8568384,
        cacheRead: 0.8333136,
        cacheWrite: 0,
      },
      {
        id: 'deepseek/deepseek-v4-pro',
        match: (model) => model.includes('pro'),
        label: 'DeepSeek V4 Pro',
        input: 107.14032,
        output: 178.5672,
        cacheRead: 29.7612,
        cacheWrite: 0,
      },
      {
        id: 'anthropic/claude-sonnet-5.5',
        match: (model) => model.includes('sonnet'),
        label: 'Claude Sonnet 5.5',
        input: 243.0498,
        output: 1215.249,
        cacheRead: 12.15249,
        cacheWrite: 303.81225,
      },
    ]

    const DICTIONARIES = {
      en: {
        'panel.label': 'Expenses',
        'page.title': 'Expenses',
        'page.subtitle': 'Token usage and estimated cost across all sessions.',
        'summary.today': 'Today',
        'summary.all': 'All time',
        'stat.input': 'Input tokens',
        'stat.cache': 'Cache read tokens',
        'stat.output': 'Output tokens',
        'stat.requests': 'Model requests',
        'stat.tools': 'Tool calls',
        'tariff.title': 'Tariff, ₽ per 1M tokens:',
        'tariff.none': 'no tariff',
        'tariff.missing': 'Cost is incomplete: some models have no tariff.',
        'tariff.live': 'live Polza catalogue, updated',
        'tariff.fallback': 'built-in table, Polza API unavailable',
        'balance.spent': 'Charged by Polza',
        'balance.available': 'Balance left',
        'action.refresh': 'Refresh',
        'action.reloading': 'Refreshing…',
        'table.session': 'Session',
        'table.date': 'Date',
        'table.input': 'Input',
        'table.cache': 'Cache',
        'table.output': 'Output',
        'table.requests': 'Requests',
        'table.tools': 'Tool calls',
        'table.cost': 'Cost',
        'table.total': 'Total',
        'session.untitled': 'Untitled session',
        'state.loading': 'Reading sessions',
        'state.empty': 'No sessions yet.',
        'state.unreadable': 'Unreadable sessions',
        'state.unavailable': 'Session data is not available in this window.',
        'state.failed': 'Could not read sessions.',
      },
      ru: {
        'panel.label': 'Расходы',
        'page.title': 'Расходы',
        'page.subtitle': 'Расход токенов и оценка стоимости по всем сессиям.',
        'summary.today': 'Сегодня',
        'summary.all': 'За всё время',
        'stat.input': 'Входные токены',
        'stat.cache': 'Токены из кэша',
        'stat.output': 'Выходные токены',
        'stat.requests': 'Запросы к модели',
        'stat.tools': 'Вызовы инструментов',
        'tariff.title': 'Тариф, ₽ за 1 млн токенов:',
        'tariff.none': 'тарифа нет',
        'tariff.missing': 'Стоимость неполная: для части моделей нет тарифа.',
        'tariff.live': 'каталог Polza, обновлено',
        'tariff.fallback': 'встроенная таблица, API Polza недоступен',
        'balance.spent': 'Списано на Polza',
        'balance.available': 'Остаток',
        'action.refresh': 'Обновить',
        'action.reloading': 'Обновление…',
        'table.session': 'Сессия',
        'table.date': 'Дата',
        'table.input': 'Вход',
        'table.cache': 'Кэш',
        'table.output': 'Выход',
        'table.requests': 'Запросы',
        'table.tools': 'Инструменты',
        'table.cost': 'Стоимость',
        'table.total': 'Итого',
        'session.untitled': 'Без названия',
        'state.loading': 'Читаю сессии',
        'state.empty': 'Сессий пока нет.',
        'state.unreadable': 'Не удалось прочитать',
        'state.unavailable': 'Данные сессий недоступны в этом окне.',
        'state.failed': 'Не удалось прочитать сессии.',
      },
    }

    const STYLES = `
      .dsh-expenses {
        height: 100%;
        overflow: auto;
        box-sizing: border-box;
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        font-size: 13px;
        line-height: 1.45;
      }
      .dsh-expenses-inner {
        max-width: 1080px;
        margin: 0 auto;
        padding: calc(var(--dsh-frame-top-clearance, 40px) + 10px) 32px 48px;
        box-sizing: border-box;
      }
      .dsh-expenses-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }
      .dsh-expenses-title {
        margin: 0;
        font-size: 20px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      .dsh-expenses-subtitle {
        margin: 6px 0 0;
        font-size: 13px;
        color: var(--dsw-alias-label-secondary);
      }
      .dsh-expenses-button {
        flex: none;
        height: 30px;
        padding: 0 12px;
        border-radius: var(--dsw-radius-sm, 8px);
        border: 1px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l1));
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 12.5px;
        cursor: pointer;
        transition: background-color 0.12s, border-color 0.12s;
      }
      .dsh-expenses-button:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
        border-color: var(--dsw-alias-border-l4, var(--dsw-alias-border-l2));
      }
      .dsh-expenses-button:disabled {
        cursor: default;
        opacity: 0.6;
      }
      .dsh-expenses-cards {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .dsh-expenses-card {
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l1));
        border-radius: var(--dsw-radius-lg, 12px);
        padding: 14px 16px 16px;
      }
      .dsh-expenses-card-top {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
      }
      .dsh-expenses-card-label {
        font-size: 12.5px;
        color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary));
      }
      .dsh-expenses-card-cost {
        font-size: 20px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .dsh-expenses-metrics {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
        margin: 12px 0 0;
      }
      .dsh-expenses-metric-label {
        margin: 0 0 3px;
        font-size: 11.5px;
        color: var(--dsw-alias-label-secondary);
      }
      .dsh-expenses-metric-value {
        margin: 0;
        font-size: 14px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
      }
      .dsh-expenses-tariff {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 6px 14px;
        margin: 16px 0 0;
        font-size: 12.5px;
        color: var(--dsw-alias-label-secondary);
      }
      .dsh-expenses-tariff-title {
        color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary));
      }
      .dsh-expenses-tariff-item {
        color: var(--dsw-alias-label-primary);
      }
      .dsh-expenses-tariff-missing {
        color: var(--dsw-alias-state-warn-primary);
      }
      .dsh-expenses-tariff-source {
        color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary));
      }
      .dsh-expenses-balance {
        margin: 8px 0 0;
        font-size: 12.5px;
        color: var(--dsw-alias-label-secondary);
        font-variant-numeric: tabular-nums;
      }
      .dsh-expenses-status {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        min-height: 18px;
        margin: 14px 0 10px;
        font-size: 12.5px;
        color: var(--dsw-alias-label-secondary);
      }
      .dsh-expenses-status-count {
        font-variant-numeric: tabular-nums;
      }
      .dsh-expenses-warning {
        margin: 14px 0 0;
        padding: 10px 14px;
        border-radius: 10px;
        border: 1px solid var(--dsw-alias-border-l1);
        color: var(--dsw-alias-state-warn-primary);
        background: var(--dsw-alias-bg-layer-1);
        font-size: 12.5px;
      }
      .dsh-expenses-table-wrap {
        border: 1px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l1));
        border-radius: var(--dsw-radius-lg, 12px);
        overflow: hidden;
        background: var(--dsw-alias-bg-layer-1);
      }
      .dsh-expenses-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .dsh-expenses-table th {
        padding: 10px 14px;
        font-size: 12px;
        font-weight: 500;
        text-align: left;
        white-space: nowrap;
        color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary));
        background: var(--dsw-alias-bg-layer-2);
        border-bottom: 1px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l1));
      }
      .dsh-expenses-table td {
        padding: 11px 14px;
        border-bottom: 1px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l1));
        vertical-align: middle;
      }
      .dsh-expenses-table tbody tr:last-child td {
        border-bottom: none;
      }
      .dsh-expenses-cell-num {
        text-align: right;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .dsh-expenses-cell-session {
        max-width: 0;
        width: 46%;
      }
      .dsh-expenses-session-title {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsh-expenses-cell-date {
        white-space: nowrap;
        color: var(--dsw-alias-label-secondary);
        font-variant-numeric: tabular-nums;
      }
      .dsh-expenses-cell-cost {
        font-weight: 500;
      }
      .dsh-expenses-row-pending td {
        color: var(--dsw-alias-label-secondary);
      }
      .dsh-expenses-table tfoot td {
        border-top: 1px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
        border-bottom: none;
        font-weight: 600;
        background: var(--dsw-alias-bg-layer-2);
      }
      .dsh-expenses-empty {
        padding: 28px;
        border: 1px dashed var(--dsw-alias-border-l4, var(--dsw-alias-border-l1));
        border-radius: var(--dsw-radius-lg, 12px);
        text-align: center;
        color: var(--dsw-alias-label-secondary);
        font-size: 13px;
      }
      @media (max-width: 760px) {
        .dsh-expenses-inner { padding-left: 18px; padding-right: 18px; }
        .dsh-expenses-cards { grid-template-columns: 1fr; }
        .dsh-expenses-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    `

    function pad2(value) {
      return value < 10 ? `0${value}` : String(value)
    }

    /** Local calendar day key, matching the Host fold. */
    function localDayKey(time) {
      const date = new Date(time)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    }

    function formatInteger(value) {
      return new Intl.NumberFormat(undefined).format(Math.round(value))
    }

    function formatRub(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const digits = value > 0 && value < 0.01 ? 4 : value > 0 && value < 1 ? 3 : 2
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'RUB',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value)
    }

    function formatTariffRate(value) {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'RUB',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)
    }

    function formatDate(time) {
      if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return '—'
      return new Date(time).toLocaleDateString(undefined, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
    }

    function numberOrZero(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    }

    function normalizeDays(raw) {
      const days = {}
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return days
      for (const key of Object.keys(raw)) {
        if (!DAY_PATTERN.test(key)) continue
        const day = raw[key]
        if (!day || typeof day !== 'object') continue
        days[key] = {
          toolCalls: numberOrZero(day.toolCalls),
          models: day.models && typeof day.models === 'object' ? day.models : {},
        }
      }
      return days
    }

    function normalizeUsage(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      return {
        createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
        title: typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : null,
        toolCalls: numberOrZero(raw.toolCalls),
        models: raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models) ? raw.models : {},
        days: normalizeDays(raw.days),
      }
    }

    /**
     * The tariff for one model id, or null when nothing prices it.
     * The live catalogue wins. Ids that arrive without a provider prefix
     * (`deepseek-flash` is written that way in older journals) are matched by
     * their last path segment.
     */
    function tariffFor(modelId, catalog) {
      if (typeof modelId !== 'string' || modelId.length === 0) return null
      const prices = catalog && catalog.prices
      if (prices && typeof prices === 'object') {
        const exact = prices[modelId]
        if (exact) return { ...exact, label: labelOf(exact, modelId) }
        for (const id of Object.keys(prices)) {
          if (id.endsWith(`/${modelId}`)) return { ...prices[id], label: labelOf(prices[id], id) }
        }
      }
      const exactFallback = FALLBACK_TARIFFS.find((tariff) => tariff.id === modelId)
      if (exactFallback) return exactFallback
      const lower = modelId.toLowerCase()
      return FALLBACK_TARIFFS.find((tariff) => tariff.match(lower)) || null
    }

    /** A catalogue entry's own name, or the model id when it has none. */
    function labelOf(price, modelId) {
      return price && typeof price.label === 'string' && price.label.length > 0 ? price.label : modelId
    }

    function emptyTotals() {
      return {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        requests: 0,
        toolCalls: 0,
        cost: 0,
        priced: false,
        unpriced: [],
      }
    }

    /** Rubles for one model bucket under one tariff. */
    function bucketCost(bucket, tariff) {
      return (
        (bucket.input / 1e6) * tariff.input +
        (bucket.output / 1e6) * tariff.output +
        (bucket.cacheRead / 1e6) * (tariff.cacheRead || 0) +
        (bucket.cacheWrite / 1e6) * (tariff.cacheWrite || 0)
      )
    }

    /** Token totals and cost for one model map. */
    function summarizeModels(models, catalog) {
      const totals = emptyTotals()
      if (!models || typeof models !== 'object') return totals
      for (const id of Object.keys(models)) {
        const raw = models[id]
        if (!raw || typeof raw !== 'object') continue
        const bucket = {
          input: numberOrZero(raw.input),
          output: numberOrZero(raw.output),
          cacheRead: numberOrZero(raw.cacheRead),
          cacheWrite: numberOrZero(raw.cacheWrite),
        }
        totals.input += bucket.input
        totals.cacheRead += bucket.cacheRead
        totals.cacheWrite += bucket.cacheWrite
        totals.output += bucket.output
        totals.requests += numberOrZero(raw.requests)
        const tariff = tariffFor(id, catalog)
        if (tariff === null) {
          if ((bucket.input > 0 || bucket.output > 0 || bucket.cacheRead > 0) && totals.unpriced.includes(id) === false) {
            totals.unpriced.push(id)
          }
          continue
        }
        totals.cost += bucketCost(bucket, tariff)
        totals.priced = true
      }
      return totals
    }

    function addTotals(target, source, toolCalls) {
      target.input += source.input
      target.cacheRead += source.cacheRead
      target.cacheWrite += source.cacheWrite
      target.output += source.output
      target.requests += source.requests
      target.toolCalls += toolCalls
      target.cost += source.cost
      if (source.priced) target.priced = true
      for (const id of source.unpriced) {
        if (target.unpriced.includes(id) === false) target.unpriced.push(id)
      }
    }

    function rowTotals(usage, catalog) {
      const totals = summarizeModels(usage.models, catalog)
      totals.toolCalls = usage.toolCalls
      return totals
    }

    function computeTotals(rows, catalog) {
      const all = emptyTotals()
      const today = emptyTotals()
      const todayKey = localDayKey(Date.now())
      for (const row of rows) {
        const usage = row.usage
        if (!usage) continue
        addTotals(all, summarizeModels(usage.models, catalog), usage.toolCalls)
        const day = Object.hasOwn(usage.days, todayKey) ? usage.days[todayKey] : null
        if (day) addTotals(today, summarizeModels(day.models, catalog), day.toolCalls)
      }
      return { all, today }
    }

    /** Every model id that appears in the loaded rows, in first-seen order. */
    function usedModels(rows) {
      const seen = []
      for (const row of rows) {
        const usage = row.usage
        if (!usage) continue
        for (const id of Object.keys(usage.models)) {
          if (seen.includes(id) === false) seen.push(id)
        }
      }
      return seen
    }

    function sortRows(rows) {
      return rows.slice().sort((left, right) => {
        const leftTime = (left.usage && left.usage.createdAt) || left.updatedAt
        const rightTime = (right.usage && right.usage.createdAt) || right.updatedAt
        return rightTime - leftTime
      })
    }

    function costText(totals) {
      return totals.priced ? formatRub(totals.cost) : '—'
    }

    function messageOf(failure) {
      if (failure && typeof failure.message === 'string' && failure.message.length > 0) return failure.message
      if (failure && typeof failure.code === 'string' && failure.code.length > 0) return failure.code
      return String(failure)
    }

    /** Register dictionaries through the Client locale service and bind them. */
    function createTranslate(ctx) {
      const locale = ctx.get('locale')
      if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        for (const id of Object.keys(DICTIONARIES)) {
          ctx.effect(() => locale.register('expenses', id, DICTIONARIES[id]), `dsh-expenses: locale ${id}`)
        }
        const bound = locale.bind('expenses')
        return (key) => {
          const text = bound(key)
          return text === key ? DICTIONARIES.en[key] || key : text
        }
      }
      return (key) => DICTIONARIES.en[key] || key
    }

    function ExpensesIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          role: 'img',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', color: 'currentColor' },
        },
        h('path', {
          d: 'M6 3.5h12v17l-3-1.9-3 1.9-3-1.9-3 1.9z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M9 8.5h6M9 12h6M9 15.5h3.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    function createPanel(ctx, t) {
      function getRemote() {
        try {
          if (ctx.remote) return ctx.remote
        } catch {
          /* fall through to the optional getter */
        }
        return ctx.get('remote')
      }

      async function callRemote(namespace, method, request) {
        const client = getRemote()
        const space = client && client[namespace]
        const fn = space && space[method]
        if (typeof fn !== 'function') throw new Error(t('state.unavailable'))
        const out = await fn.call(space, request)
        if (out && typeof out === 'object' && typeof out.ok === 'boolean') {
          if (!out.ok) throw new Error(messageOf(out.error))
          return out.value
        }
        return out
      }

      async function fetchUsage(sessionId) {
        const value = await callRemote('session', 'projections', { sessionId })
        if (!value || value.kind === 'migration-required') return null
        const values = value.values
        return normalizeUsage(values && values[PROJECTION_KEY])
      }

      function metric(label, value) {
        return h(
          'div',
          { className: 'dsh-expenses-metric' },
          h('dt', { className: 'dsh-expenses-metric-label' }, label),
          h('dd', { className: 'dsh-expenses-metric-value' }, value),
        )
      }

      function summaryCard(key, label, totals) {
        return h(
          'section',
          { className: 'dsh-expenses-card', key },
          h(
            'div',
            { className: 'dsh-expenses-card-top' },
            h('span', { className: 'dsh-expenses-card-label' }, label),
            h('span', { className: 'dsh-expenses-card-cost' }, costText(totals)),
          ),
          h(
            'dl',
            { className: 'dsh-expenses-metrics' },
            metric(t('stat.input'), formatInteger(totals.input)),
            metric(t('stat.cache'), formatInteger(totals.cacheRead + totals.cacheWrite)),
            metric(t('stat.output'), formatInteger(totals.output)),
            metric(t('stat.requests'), formatInteger(totals.requests)),
            metric(t('stat.tools'), formatInteger(totals.toolCalls)),
          ),
        )
      }

      function headerCell(label, className) {
        return h('th', { key: label, className, scope: 'col' }, label)
      }

      function formatClock(time) {
        if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return ''
        return new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      }

      function tariffLine(rows, catalog, info) {
        const ids = usedModels(rows)
        const items = []
        let missing = false
        for (const id of ids) {
          const tariff = tariffFor(id, catalog)
          if (tariff === null) {
            missing = true
            items.push(
              h('span', { key: id, className: 'dsh-expenses-tariff-item' }, `${id} — ${t('tariff.none')}`),
            )
            continue
          }
          items.push(
            h(
              'span',
              { key: id, className: 'dsh-expenses-tariff-item' },
              `${labelOf(tariff, id)} — ${t('table.input')} ${formatTariffRate(tariff.input)} · ` +
                `${t('table.cache')} ${formatTariffRate(tariff.cacheRead || 0)} · ` +
                `${t('table.output')} ${formatTariffRate(tariff.output)}`,
            ),
          )
        }
        const live = Boolean(info && info.live)
        const stamp = live ? formatClock(info.fetchedAt) : ''
        const source = `${live ? t('tariff.live') : t('tariff.fallback')}${stamp === '' ? '' : ` ${stamp}`}`
        return [
          h('span', { key: 'title', className: 'dsh-expenses-tariff-title' }, t('tariff.title')),
          ...items,
          missing
            ? h('span', { key: 'missing', className: 'dsh-expenses-tariff-missing' }, t('tariff.missing'))
            : null,
          h('span', { key: 'source', className: 'dsh-expenses-tariff-source' }, `· ${source}`),
        ]
      }

      /** What Polza actually charged, so the page can be checked against billing. */
      function balanceLine(balance) {
        if (!balance || typeof balance !== 'object') return null
        const parts = []
        if (typeof balance.spent === 'number') parts.push(`${t('balance.spent')} ${formatRub(balance.spent)}`)
        if (typeof balance.available === 'number') {
          parts.push(`${t('balance.available')} ${formatRub(balance.available)}`)
        }
        if (parts.length === 0) return null
        return h('div', { className: 'dsh-expenses-balance' }, parts.join(' · '))
      }

      return function ExpensesPanel() {
        const [phase, setPhase] = React.useState('loading')
        const [rows, setRows] = React.useState([])
        const [progress, setProgress] = React.useState({ done: 0, total: 0 })
        const [unreadable, setUnreadable] = React.useState(0)
        const [error, setError] = React.useState(null)
        const [catalog, setCatalog] = React.useState(null)
        const [catalogInfo, setCatalogInfo] = React.useState({ live: false, fetchedAt: 0, balance: null })
        const generationRef = React.useRef(0)

        /**
         * Prices first: a page that renders cost before the catalogue arrives
         * would flash the fallback tariff, which is exactly the number this
         * panel exists to correct.
         */
        const loadPrices = React.useCallback(async () => {
          try {
            const response = await fetch(PRICES_PATH, { headers: { Accept: 'application/json' } })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (!body || body.ok !== true || !body.prices) throw new Error('price catalogue unavailable')
            setCatalog({ prices: body.prices, currency: body.currency })
            setCatalogInfo({
              live: true,
              fetchedAt: typeof body.fetchedAt === 'number' ? body.fetchedAt : 0,
              balance: body.balance && typeof body.balance === 'object' ? body.balance : null,
            })
          } catch {
            setCatalog(null)
            setCatalogInfo({ live: false, fetchedAt: 0, balance: null })
          }
        }, [])

        const load = React.useCallback(async () => {
          const generation = generationRef.current + 1
          generationRef.current = generation
          const alive = () => generationRef.current === generation
          setPhase('loading')
          setRows([])
          setProgress({ done: 0, total: 0 })
          setUnreadable(0)
          setError(null)

          let list
          try {
            list = await callRemote('session', 'list', {})
          } catch (failure) {
            if (!alive()) return
            setError(messageOf(failure))
            setPhase('error')
            return
          }
          if (!alive()) return

          const items = list && Array.isArray(list.items) ? list.items : []
          const initial = []
          for (const item of items) {
            if (!item || typeof item.sessionId !== 'string') continue
            const values = item.projections && item.projections.values
            initial.push({
              id: item.sessionId,
              updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
              usage: normalizeUsage(values && values[PROJECTION_KEY]),
            })
          }

          if (initial.length === 0) {
            setRows([])
            setPhase('ready')
            return
          }

          const known = initial.filter((row) => row.usage).length
          setRows(initial.slice())
          setProgress({ done: known, total: initial.length })
          if (known === initial.length) {
            setRows(sortRows(initial))
            setPhase('ready')
            return
          }

          const missing = initial.filter((row) => !row.usage)
          let done = known
          let failures = 0
          let cursor = 0
          const worker = async () => {
            while (cursor < missing.length) {
              const row = missing[cursor]
              cursor += 1
              let usage = null
              try {
                usage = await fetchUsage(row.id)
              } catch {
                usage = null
              }
              if (!alive()) return
              done += 1
              if (usage) row.usage = usage
              else {
                failures += 1
                row.failed = true
              }
              setRows(initial.slice())
              setProgress({ done, total: initial.length })
              setUnreadable(failures)
            }
          }

          await Promise.all([worker(), worker(), worker()])
          if (!alive()) return
          setRows(sortRows(initial))
          setPhase('ready')
        }, [])

        React.useEffect(() => {
          loadPrices()
          load()
          return () => {
            generationRef.current += 1
          }
        }, [load, loadPrices])

        const refreshAll = React.useCallback(() => {
          loadPrices()
          load()
        }, [load, loadPrices])

        const totals = React.useMemo(() => computeTotals(rows, catalog), [rows, catalog])
        const tariffItems = React.useMemo(() => tariffLine(rows, catalog, catalogInfo), [rows, catalog, catalogInfo])
        const isLoading = phase === 'loading'
        const showTable = rows.length > 0

        return h(
          'div',
          { className: 'dsh-expenses' },
          h('style', null, STYLES),
          h(
            'div',
            { className: 'dsh-expenses-inner' },
            h(
              'header',
              { className: 'dsh-expenses-head' },
              h(
                'div',
                null,
                h('h1', { className: 'dsh-expenses-title' }, t('page.title')),
                h('p', { className: 'dsh-expenses-subtitle' }, t('page.subtitle')),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-expenses-button',
                  onClick: refreshAll,
                  disabled: isLoading,
                },
                isLoading ? t('action.reloading') : t('action.refresh'),
              ),
            ),
            h(
              'div',
              { className: 'dsh-expenses-cards' },
              summaryCard('today', t('summary.today'), totals.today),
              summaryCard('all', t('summary.all'), totals.all),
            ),
            h('div', { className: 'dsh-expenses-tariff' }, ...tariffItems),
            balanceLine(catalogInfo.balance),
            isLoading
              ? h(
                  'div',
                  { className: 'dsh-expenses-status' },
                  h('span', null, t('state.loading')),
                  h(
                    'span',
                    { className: 'dsh-expenses-status-count' },
                    `${progress.done} / ${progress.total}`,
                  ),
                )
              : unreadable > 0
                ? h(
                    'div',
                    { className: 'dsh-expenses-status' },
                    h('span', null, t('state.unreadable')),
                    h('span', { className: 'dsh-expenses-status-count' }, String(unreadable)),
                  )
                : h('div', { className: 'dsh-expenses-status' }),
            error
              ? h(
                  'div',
                  { className: 'dsh-expenses-warning' },
                  h('div', null, t('state.failed')),
                  h('div', null, error),
                )
              : null,
            showTable
              ? h(
                  'div',
                  { className: 'dsh-expenses-table-wrap' },
                  h(
                    'table',
                    { className: 'dsh-expenses-table' },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        headerCell(t('table.session')),
                        headerCell(t('table.date')),
                        headerCell(t('table.input'), 'dsh-expenses-cell-num'),
                        headerCell(t('table.cache'), 'dsh-expenses-cell-num'),
                        headerCell(t('table.output'), 'dsh-expenses-cell-num'),
                        headerCell(t('table.requests'), 'dsh-expenses-cell-num'),
                        headerCell(t('table.tools'), 'dsh-expenses-cell-num'),
                        headerCell(t('table.cost'), 'dsh-expenses-cell-num'),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      rows.map((row) => {
                        const usage = row.usage
                        const summary = usage ? rowTotals(usage, catalog) : null
                        const placeholder = row.failed ? '—' : '…'
                        const title = usage ? usage.title || t('session.untitled') : placeholder
                        return h(
                          'tr',
                          { key: row.id, className: usage ? undefined : 'dsh-expenses-row-pending' },
                          h(
                            'td',
                            { className: 'dsh-expenses-cell-session' },
                            h('span', { className: 'dsh-expenses-session-title', title }, title),
                          ),
                          h(
                            'td',
                            { className: 'dsh-expenses-cell-date' },
                            usage ? formatDate(usage.createdAt) : placeholder,
                          ),
                          h(
                            'td',
                            { className: 'dsh-expenses-cell-num' },
                            summary ? formatInteger(summary.input) : placeholder,
                          ),
                          h(
                            'td',
                            { className: 'dsh-expenses-cell-num' },
                            summary ? formatInteger(summary.cacheRead + summary.cacheWrite) : placeholder,
                          ),
                          h(
                            'td',
                            { className: 'dsh-expenses-cell-num' },
                            summary ? formatInteger(summary.output) : placeholder,
                          ),
                          h(
                            'td',
                            { className: 'dsh-expenses-cell-num' },
                            summary ? formatInteger(summary.requests) : placeholder,
                          ),
                          h(
                            'td',
                            { className: 'dsh-expenses-cell-num' },
                            summary ? formatInteger(summary.toolCalls) : placeholder,
                          ),
                          h(
                            'td',
                            { className: 'dsh-expenses-cell-num dsh-expenses-cell-cost' },
                            summary ? costText(summary) : placeholder,
                          ),
                        )
                      }),
                    ),
                    h(
                      'tfoot',
                      null,
                      h(
                        'tr',
                        null,
                        h('td', { className: 'dsh-expenses-cell-session' }, t('table.total')),
                        h('td', { className: 'dsh-expenses-cell-date' }, ''),
                        h('td', { className: 'dsh-expenses-cell-num' }, formatInteger(totals.all.input)),
                        h(
                          'td',
                          { className: 'dsh-expenses-cell-num' },
                          formatInteger(totals.all.cacheRead + totals.all.cacheWrite),
                        ),
                        h('td', { className: 'dsh-expenses-cell-num' }, formatInteger(totals.all.output)),
                        h('td', { className: 'dsh-expenses-cell-num' }, formatInteger(totals.all.requests)),
                        h('td', { className: 'dsh-expenses-cell-num' }, formatInteger(totals.all.toolCalls)),
                        h(
                          'td',
                          { className: 'dsh-expenses-cell-num dsh-expenses-cell-cost' },
                          costText(totals.all),
                        ),
                      ),
                    ),
                  ),
                )
              : phase === 'ready' && !error
                ? h('div', { className: 'dsh-expenses-empty' }, t('state.empty'))
                : null,
          ),
        )
      }
    }

    return {
      // A restricted client context only exposes Remote namespaces declared here.
      inject: ['slots', 'remote', 'remote.session', 'locale'],
      apply(ctx) {
        const t = createTranslate(ctx)
        const Panel = createPanel(ctx, t)

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => t('panel.label'),
              locale: 'expenses',
            },
            ExpensesIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: 'expenses' }, Panel),
        )
      },
    }
  },
})
