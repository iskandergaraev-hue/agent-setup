# Context handoff: отчёт исполнителя

Реализована версия 1 для Node 26 без npm-зависимостей и без установки на машину.
Источник требований: утверждённый план
`~/.claude/coordinator/plans/2026-10-11-handoff-hook-plan.md`, с поправками брифа:
ESM, четыре события, без PreToolUse для handoff и без раннего порога.

## Изменения и гарантия поведения

| Файлы | Результат |
|---|---|
| `hooks/context-handoff.mjs` | Ограниченный stdin, один JSON либо пустой stdout, exit 0, безопасная диагностика |
| `hooks/context-handoff-core.mjs` | Последний usage основной parentUuid-цепочки, bounded snapshot, кэш, атомарные состояния и индекс, сигналы/Stop, ready/hash/claim, TTL/cooldown, compact |
| `templates/handoff.md` | Полные метаданные и обязательные разделы; пустые категории заполняются явно |
| `tests/context-handoff.test.mjs`, `tests/fixtures/transcript.mjs` | Unit/integration/entrypoint регрессии, синтетические данные |
| `tests/verify-context-handoff.mjs` | Прогоны stdin и wall-clock benchmark |
| `local/snippets/claude-settings-hooks.json` | UserPromptSubmit, Stop, PreCompact, SessionStart; прежний guard сохранён |
| `local/claude/CLAUDE.md` | Правило передачи; санитизированная копия установленного baseline, включая обновлённую политику local git |
| `README.md` | Установка, параметры, проверки, живой smoke, ограничения и откат |

На TRANSFER координатор завершает ready и заканчивает ответ. Stop проверяет файл
и фиксирует pending-маркер до выдачи CLEAR_READY; только тогда Claude вызывает
self clear. Node не вызывает MCP. Stop даёт максимум одну подготовку и одно
завершение; черновик исключает лишнюю подготовку, исчерпанный лимит даёт fallback.
Все операции записи ограничены checkout; runtime-файлы `~/.claude` не изменялись.

## TDD evidence

Первый валидный RED: `node --test local/claude/coordinator/tests/` — **23 failed,
0 passed**, из-за отсутствующих production exports/entrypoint. До этого был
исправлен неверный относительный путь тестового sandbox; ошибка setup не засчитана RED.
Первый GREEN — **23 passed, 0 failed**. Последующие регрессии сначала выявили
потерю committed output, исчезновение PREPARE на PreCompact, повторное поколение,
reserved-key, cleanup, requestId-only duplicates и слишком большой сигнал;
после исправлений — **38 passed, 0 failed**. Тест ошибочного `/CLEAR_READY/`
исправлен до точного маркера: пояснительный текст TRANSFER не является допуском clear.

| Группа acceptance | Доказательство в `context-handoff.test.mjs` | Тип |
|---|---|---|
| 179999/180000/199999/200000/240000, однократность | `threshold … emits … once`, hard latch | integration |
| Формула и некорректные счётчики | `usage formula …` | unit |
| Дубли по message.id/requestId, tool-use, sidechain, чужая session, ветка, unknown latest | `latest response …`, `latest answer …`, `requestId …`, `unknown parent …` | unit + файл |
| BOM/CRLF/Unicode/длинная строка/битый и незаконченный JSON/лимиты/рост файла | `bounded reading …`, `snapshot length …` | файл |
| Payload/config, off/enabled=0, I/O, повреждённое состояние, блокировки | `invalid payload …`, `sessions independent …`, `entry is disabled …` | integration + CLI |
| Ready/владелец/cwd/generation/path/размер/hash/TTL | `ready validation …`, `clear supports changed ID …` | integration |
| Claim race, два кандидата/чата, повтор, emitted/consumed | `multiple active chats …`, `two candidates …`, `clear restores once …`, `handoff emits …` | integration |
| Compact до/между/после порогов и первое обнаружение 180k на compact | `compact preserves …`, `PreCompact observing …` | integration |
| Stop/clear без циклов, cooldown | `hard latch …`, `cooldown …`, `a prepared draft …` | integration |
| Один JSON/диагностика/ограничение вывода | `entry emits …`, `oversized signal …` | CLI + integration |
| Сбой session commit/cleanup не подавляет committed output | `post-claim …`, `lock cleanup …`, `successful rename …` | fault injection |

Команды финальной проверки на Node **v26.11.1**:

- `node --test local/claude/coordinator/tests/`: **38/38**, exit 0.
  Три последовательных прогона: **38/38**, **38/38**, **38/38**; pass@1 = 1,
  pass@3 = 1, наблюдаемая pass^3 = 1 для этого набора (не оценка будущей вероятности).
- `node --test --experimental-test-coverage --test-coverage-include="**/context-handoff-core.mjs" --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 local/claude/coordinator/tests/`:
  **38/38**, exit 0; core **100% lines, 93.23% branches, 100% functions**.
- `Get-ChildItem local -Recurse -Filter *.mjs | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE) { throw 'Syntax check failed' } }`:
  синтаксис всех `.mjs` успешен. Сборки, TypeScript и отдельного lint-runner здесь нет.
- `git diff --check`: exit 0, только штатные предупреждения преобразования LF→CRLF.
- JSON snippet разобран через `JSON.parse`: четыре регистрации handoff, guard сохранён.
  Санитизация local: **0** совпадений личного имени/пути. Baseline CLAUDE.md после
  нормализации пути и EOL **равен** установленному; новый раздел добавлен только в checkout.
- `node local/claude/coordinator/tests/verify-context-handoff.mjs --smoke`: exit 0;
  UserPromptSubmit → JSON PREPARE; Stop → JSON block/TRANSFER; готовый файл →
  JSON block/CLEAR_READY; PreCompact → пустой stdout; SessionStart(clear) → JSON
  additionalContext с полной синтетической передачей; повтор → пустой stdout.
- `node local/claude/coordinator/tests/verify-context-handoff.mjs --benchmark`: exit 0,
  по 20 вызовов без кэша, включая запуск Node; каждый подтверждает usage **179999**:

| Transcript | p50 | p95 | max |
|---|---:|---:|---:|
| 327 байт | 106.66 мс | 121.97 мс | 130.26 мс |
| 16777216 байт | 266.24 мс | 300.26 мс | 308.23 мс |

ECC code-reviewer, typescript-reviewer и security-reviewer провели read-only review.
Найденные HIGH в доставке после commit/cleanup исправлены и покрыты fault-тестами;
повторное code/JS-review — без CRITICAL/HIGH.

## Git и установка координатором

Исходный HEAD **eb78f48**, фактическая ветка **main**. Попытка создать
`feat/coordinator-context-handoff` до обновления инструкции завершилась
`cannot lock ref`: `.git` read-only. После обновлённого AGENTS Git-записи не
выполнялись. Коммитов нет, изменения оставлены uncommitted; push/PR не выполнялись.
Координатору перенести рабочее дерево на `feat/coordinator-context-handoff` и после проверки:

1. `feat: implement coordinator context handoff with regression tests` — оба hooks,
   template, тест, synthetic fixture, verification-скрипт.
2. `docs: document coordinator handoff installation and validation` — README,
   local CLAUDE.md, settings snippet, этот TDD-отчёт.

Точные файлы установки и порядок merge приведены в README, раздел
«Передача контекста локального координатора». Установить только два hooks и
template; в settings добавить четыре массива из snippet, не заменяя ECC/guard;
подставить абсолютный профиль и путь Node. В runtime CLAUDE.md добавить весь
одноимённый раздел. Tests/TDD.md не устанавливать. Desktop smoke — отдельный
процесс, prepare **1000**, clear **2000**, изолированные STATE_DIR/DIR; проверить
ready→CLEAR_READY→self clear→SessionStart(clear)→подтверждение, отказ карточки,
отсутствие MCP, Remote Control, compact и два чата; вернуть **180000/200000**.

## Открытые ограничения

Живой Desktop/MCP lifecycle не проверялся: установка запрещена брифом.
Последний usage может отставать; порог не является математическим потолком.
Без предшествующего session ID, при одинаковом cwd используется консервативный
fallback; чат неактивный дольше TTL может быть невидим. Повторный настоящий
ручной clear с прежним ID без нового маркера неотличим от повторного SessionStart.
Усечение transcript может оставить unknown до появления данных за сохранённой
границей. Сбой процесса между emitted и stdout требует ручного восстановления.
Stale locks снимаются вручную только после остановки hook-процессов, как описано
в README; private handoff/index сохраняются. Эти ограничения не скрываются
утверждением о проверке живой установки.
