# agent-setup

Настройка ECC и сохранённая конфигурация связки Claude Code + Codex. Репозиторий предназначен для публичной публикации как `iskandergaraev-hue/agent-setup`. Он не содержит секретов; личный путь Windows заменён на `%USERPROFILE%`.

## Два режима

- **Локально:** Claude Code обсуждает задачу, пишет brief и проверяет результат; Codex выполняет работу. `delegate.mjs` ограничивает модели до `gpt-6.1-sol` и `gpt-6-luna`, а `guard.ps1` контролирует инструменты редактирования и вызовы ECC-агентов в Claude.
- **В облаке:** Claude Code выполняет работу сам с ECC. Codex там отсутствует. Плагины в облачных сессиях не загружаются; setup script устанавливает правила, навыки, агентов, команды и hooks непосредственно в `~/.claude`.

## Подключение облачного окружения

После публикации файлов в GitHub:

1. Откройте `claude.ai/code` → настройки окружения (environment settings).
2. В поле **Setup script** вставьте полное содержимое [`cloud/environment-setup-script.sh`](cloud/environment-setup-script.sh).
3. Выберите сетевой доступ **Trusted** и запустите новую сессию.

Скрипт запускается от root на Ubuntu 24.04 до старта Claude; нужны предустановленные Node 22, npm, git и curl. Он получает ECC 2.2.3 на закреплённом коммите `4eb71d92a39cab44ad40ac9d8a6a5ccb4029d6c2` в `/opt/ecc`, устанавливает зависимости без lifecycle scripts и применяет профиль с hooks. Затем записывает облачные инструкции в `$HOME/.claude/CLAUDE.md`.

Каждый этап отмечается `[agent-setup]`. В конце выводятся закреплённый коммит, профиль, статусы и количество установленных skills/agents/commands. Ошибки выводятся как предупреждения; скрипт всегда завершает работу с кодом 0, поэтому проверяйте итоговый статус. Ожидаемое время — до примерно пяти минут при нормальной работе сети; жёсткого общего тайм-аута нет.

Необязательные переменные окружения:

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `ECC_PROFILE` | Профиль установщика ECC | `developer` |
| `AGENT_SETUP_REF` | Ветка, тег или SHA для загрузки `cloud/CLAUDE.md` | `main` |
| `ECC_SRC` | Локальный checkout ECC вместо загрузки, для offline-проверок | не задана |
| `AGENT_SETUP_LOCAL` | Локальный checkout agent-setup для копирования облачных инструкций | не задана |

`AGENT_SETUP_REF` меняет источник инструкций; вставляемый snippet всегда получает сам `setup.sh` из `main`. При `ECC_SRC` соответствие исходников закреплённому коммиту не проверяется. Даже с локальными исходниками `npm install` может требовать доступ к registry.

## Локальная конфигурация Windows

Это копии существующей настройки с заменой личного пути, а не автоматический установщик. Установите Claude Code, Codex desktop app, Node.js, ECC в Claude Code и Codex и плагин `codex@openai-codex` для Claude Code. Перед объединением настроек сохраните свою текущую конфигурацию.

| Файл в репозитории | Куда установить / назначение |
|---|---|
| `local/claude/CLAUDE.md` | `%USERPROFILE%/.claude/CLAUDE.md`: правила координатора |
| `local/claude/coordinator/bin/delegate.mjs` | `%USERPROFILE%/.claude/coordinator/bin/delegate.mjs`: передача brief в Codex |
| `local/claude/coordinator/hooks/guard.ps1` | `%USERPROFILE%/.claude/coordinator/hooks/guard.ps1`: PreToolUse guard |
| `local/codex/AGENTS.md` | `%USERPROFILE%/.codex/AGENTS.md`: правила исполнителя |
| `local/codex/ecc-adapter/generate-roles.mjs` | `%USERPROFILE%/.codex/ecc-adapter/generate-roles.mjs`: генератор ECC-ролей |
| `local/bin/codex.cmd` | `%APPDATA%/npm/codex.cmd`: shim для Windows shell |
| `local/bin/codex` | `%APPDATA%/npm/codex`: shim для Git Bash / sh |
| `local/snippets/claude-settings-hooks.json` | Объединить блок `hooks` с `%USERPROFILE%/.claude/settings.json` |
| `local/snippets/codex-config.toml` | Объединить с `%USERPROFILE%/.codex/config.toml` |

В команде hook замените `%USERPROFILE%` абсолютным путём своего профиля перед установкой; `_note` — пояснение к snippet. Сохраните остальные hooks и настройки. Каталог `%APPDATA%/npm` должен быть в `PATH`; sh shim использует Git Bash и `cygpath`.

После копирования генератора выполните в PowerShell:

```powershell
node "$env:USERPROFILE/.codex/ecc-adapter/generate-roles.mjs"
```

Он создаст роли в `~/.codex/agents`, `roles.json` и таблицу `ecc-roles.md`, а также обновит генерируемый блок `[[skills.config]]` в существующем Codex config. Эти файлы с машинными путями не хранятся в репозитории.

## Обновление ECC

Для облака измените `ECC_COMMIT` в `cloud/setup.sh` на проверенный коммит новой версии и повторите проверки. После согласованной публикации запустите новое облачное окружение.

Локально обновите ECC в Claude Code и Codex и снова выполните `generate-roles.mjs`. Обновляйте сохранённые копии с той же заменой личных путей и проверкой отсутствия секретов.

## Проверки

```bash
bash -n cloud/setup.sh
git ls-files --eol cloud/setup.sh
```

Offline dry-run установщика выполняйте с `HOME` и `USERPROFILE`, направленными во временный каталог, и флагами `--target claude --profile developer --enable-hooks --dry-run`. Он показывает план без установки. Реальную облачную установку следует отдельно проверить в Ubuntu после публикации.

## Передача контекста локального координатора

Версия 1: последний записанный вход модели ≥180000 вызывает PREPARE,
≥200000 фиксирует TRANSFER. Метрика — `input_tokens + cache_read_input_tokens +
cache_creation_input_tokens` последнего ответа основной цепочки; output и дубли
не суммируются. Чтение блоками по 64 KiB, максимум 16 MiB за 2 с; кэш по
пути/поколению/размеру/mtime. Один JSON или пустой stdout, exit 0; только код
ошибки в stderr. Контракты сверены с [status line](https://code.claude.com/docs/en/statusline#context-window-fields)
и [hooks](https://code.claude.com/docs/en/hooks). Transcript — внутренний формат.

Установка координатором (**Node 26**, без npm-зависимостей):

1. Сохранить резервные копии `~/.claude/settings.json` и `~/.claude/CLAUDE.md`.
2. Скопировать оба `local/claude/coordinator/hooks/context-handoff.mjs` и
   `context-handoff-core.mjs` в `%USERPROFILE%/.claude/coordinator/hooks/`;
   `local/claude/coordinator/templates/handoff.md` — в
   `%USERPROFILE%/.claude/coordinator/templates/handoff.md`.
3. Из `local/snippets/claude-settings-hooks.json` **добавить** элементы массивов
   UserPromptSubmit, Stop, PreCompact, SessionStart в соответствующие массивы
   `hooks` установленного settings. ECC и guard сохранить; guard не дублировать.
   `%USERPROFILE%` в каждой команде заменить абсолютным профилем. Node запускается
   как `"C:/Program Files/nodejs/node.exe"`; если установлен иначе, указать его
   абсолютный путь. Command синхронный, timeout 5; async и блокировку ошибок не включать.
4. Добавить целиком раздел **«Передача контекста координатора»** из
   `local/claude/CLAUDE.md` в установленный CLAUDE.md. Копия также синхронизирует
   правило Maintenance об источнике agent-setup. Собственные дополнительные правила сохранить.
5. Выполнить Desktop smoke ниже. Реальные handoff и runtime-state не добавлять в Git;
   тесты/verification-скрипт устанавливать не нужно.

Claude пишет черновик на PREPARE и завершает ready на TRANSFER, заканчивая
текущий ответ. **Stop проверяет ready, владельца, путь, структуру, размер и hash**,
записывает маркер ожидаемой очистки и выдаёт CLEAR_READY. Только затем Claude
один раз вызывает `mcp__ccd_session_mgmt__clear_session` с `{"session_id":"self"}`.
Node-хук не вызывает MCP и не обходит разрешения Desktop. При скачке выше 200k
Stop может сначала продолжить ход для подготовки, затем один раз для clear.
Максимум одно продолжение подготовки и одно завершения на поколение. Если
подготовка уже запрашивалась, а ready так и нет, используется ручной fallback.
Наличие черновика исключает избыточный мягкий Stop. На 200k новая работа
останавливается сигналом и CLAUDE.md; инструментального запрета в v1 нет.

`SessionStart(clear)` принимает pending-маркер того же нормализованного cwd и
проекта, не старше 10 минут. При сохранённом ID выбирается свой кандидат;
при изменённом — единственный кандидат без других активных чатов того же cwd.
Claim под блокировкой предотвращает повторную инъекцию. `emitted` означает
подготовленный к выводу контекст, `consumed` — Stop после первого ответа,
подтверждающего приём с полным путём файла. stdout не доказывает принятия хостом.
`startup/resume` ничего не подхватывают. Compact сохраняет незавершённую передачу
и hard latch, сбрасывая измерение до нового ответа.

Переменные в окружении **процесса Claude Code**:

| Переменная | По умолчанию / назначение |
|---|---|
| `CLAUDE_COORDINATOR_MODE` | `off` отключает coordinator hooks |
| `CLAUDE_COORDINATOR_HANDOFF_ENABLED` | `1`; `0` отключает этот хук |
| `CLAUDE_COORDINATOR_HANDOFF_PREPARE_TOKENS` | `180000` |
| `CLAUDE_COORDINATOR_HANDOFF_CLEAR_TOKENS` | `200000`; строго больше prepare |
| `CLAUDE_COORDINATOR_HANDOFF_MAX_TAIL_BYTES` | `16777216`; можно уменьшить |
| `CLAUDE_COORDINATOR_HANDOFF_PENDING_TTL_SECONDS` | `600` |
| `CLAUDE_COORDINATOR_HANDOFF_CLEAR_COOLDOWN_SECONDS` | `600`; одна автоочистка для cwd/проекта |
| `CLAUDE_COORDINATOR_HANDOFF_MAX_CHARS` | `8500`; можно уменьшить |
| `CLAUDE_COORDINATOR_HANDOFF_STATE_DIR` | `~/.claude/coordinator/state/context-handoff/` |
| `CLAUDE_COORDINATOR_HANDOFF_DIR` | `~/.claude/coordinator/handoffs/` |

Числа — положительные целые. Некорректные настройки дают fail-open с
диагностикой, без неожиданной замены порогов. Сигнала 150k нет. MAX_TAIL_BYTES
и MAX_CHARS нельзя поднять выше штатных лимитов. Пути state/handoff можно
переопределить для тестов; шаблон в сигнале — соседний `templates/` coordinator root.
Полный additionalContext ограничен 10000 символами.

Проверки из корня репозитория:

```powershell
node --test local/claude/coordinator/tests/
node --test --experimental-test-coverage --test-coverage-include="**/context-handoff-core.mjs" --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 local/claude/coordinator/tests/
Get-ChildItem local -Recurse -Filter *.mjs | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE) { throw "Syntax check failed" } }
node local/claude/coordinator/tests/verify-context-handoff.mjs --smoke
node local/claude/coordinator/tests/verify-context-handoff.mjs --benchmark
```

Используются только синтетические transcript/handoff и временные каталоги
`.handoff-tests/` внутри workspace, удаляемые после прогона. Benchmark делает
20 вызовов для обычного хвоста и 20 для 16 MiB; удаление синтетического
session-state между вызовами исключает кэш. Замер включает запуск Node,
чтение и запись состояния, подтверждает известный usage 179999 на каждом прогоне.

Smoke установленного Desktop:

1. В отдельном процессе Claude задать prepare `1000`, clear `2000` и отдельные
   STATE_DIR/DIR вне публичного checkout. Открыть один чат с известным cwd.
2. Получить PREPARE, проверить заполненный черновик и отсутствие повторных сигналов.
   Пересечь clear, проверить прекращение новой работы и новых dispatch.
3. Проверить ready → конец ответа → Stop/CLEAR_READY → один self clear → короткий
   ответ «очистка запрошена» → SessionStart с source `clear`.
4. Следующим сообщением проверить цель, решения, job-id и следующий шаг;
   подтвердить приём с путём, проверить emitted → consumed в index.json.
5. Повторить с отказом карточки, отсутствующим MCP и Remote Control: путь и ручной
   промпт должны выдаваться без повторного clear.
6. Проверить `/compact` между порогами и после TRANSFER: старый usage не применяется,
   hard latch сохраняется. Два чата одного cwd при смене ID должны давать MANUAL
   при неоднозначности. Проверить совместную работу ECC и GateGuard.
7. Вернуть 180000/200000 и штатные каталоги; открыть новый процесс.

Ограничения: usage отстаёт, 200k не является математическим потолком. Контракт
Desktop clear и доставка additionalContext требуют живого smoke. Без ID
предшественника нельзя доказать принадлежность для нескольких чатов одного cwd;
неактивный более TTL чат может быть невидим. Повторный SessionStart одного source
без нового pending-маркера игнорируется: второй ручной `/clear` с прежним ID
после первого clear неотличим от повтора; использовать новый чат или явный файл.
После усечения transcript сохранённая граница может давать unknown — fail-open.
Аварийный выход между фиксацией emitted и stdout возможен; читать handoff явно.

Аварийное завершение может оставить `.lock` в STATE_DIR. При повторяющемся EEXIST
закрыть Claude и убедиться в отсутствии активных hook-процессов, затем вручную
убрать только оставшиеся lock-файлы в этом каталоге. Handoff, index и session-state сохранить.

Откат: запустить Claude с `CLAUDE_COORDINATOR_HANDOFF_ENABLED=0`, убрать только
четыре регистрации с context-handoff.mjs и вернуть прежний раздел CLAUDE.md.
ECC/guard оставить; handoff и состояние сохранить для восстановления.
