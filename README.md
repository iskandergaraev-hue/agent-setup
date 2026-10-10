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
