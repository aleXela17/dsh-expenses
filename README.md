# dsh-expenses

Token usage and approximate cost panel for DeepSeek Harness sessions.
Панель расхода токенов и примерной стоимости по сессиям DeepSeek Harness.

## Что показывает

Плагин читает журнал сессий DSH и сводит его в таблицу: токены на входе и выходе,
кэш, число запросов к модели и вызовов инструментов, примерная стоимость по
тарифам выбранного провайдера.

## Установка

Плагин ставится как бандл профиля DeepSeek Harness:

1. добавьте зависимость в `package.json` профиля:

   ```json
   "@local/dsh-expenses": "github:aleXela17/dsh-expenses#<commit>"
   ```

2. добавьте `@local/dsh-expenses` в список `dsh.profile.bundles` того же файла;
3. перезапустите DSH.

## Provenance

Код плагина сгенерирован агентом DeepSeek Harness по промпту владельца
репозитория; репозиторий ведётся и поддерживается владельцем.

## Лицензия

MIT — см. [LICENSE](LICENSE).