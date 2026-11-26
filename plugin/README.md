# Mac desktop control · dsh-mac-computer-use

A DeepSeek Harness (DSH) plugin that lets the model see the screen, click buttons and type, driving the apps on your Mac directly. It provides 11 `desktop_*` tools: window list, screenshot, find by text (OCR), numbered elements, click, type, keys, scroll, drag and app launch.

Clicks and typing go straight to the target app; your real mouse never moves, and nothing is brought to the front.

Requires macOS 11 or later, runs on Apple silicon and Intel. The package ships prebuilt binaries, so no compiling is needed.

## Install

On DSH's "Plugins" page, click "Add plugin", enter `dsh-mac-computer-use`, then restart DSH. When DSH cannot reach npm it automatically falls back to a China mirror.

On first use, grant DeepSeek Harness the "Screen Recording" and "Accessibility" permissions in System Settings. The plugin's settings page has direct buttons for both.

## Update

From DSH 0.2.2 on, open the plugin on the "Plugins" page and click "Update to …"; on older DSH, uninstall it and add it again. DSH installs plugins with pnpm, and pnpm skips brand-new versions by default, so a new release becomes installable about a day after it is published.

## English

A DSH plugin that lets the model see the screen and control the Mac through 11 `desktop_*` tools:

- window list, screenshots, OCR text search and numbered elements
- click, type, keys, scroll, drag and app launch

Clicks and typing go straight to the target app. Your real pointer never moves, and the app is not brought to the front.

It needs macOS 11 or later and runs on Apple silicon and Intel. The package ships prebuilt binaries.

**Install:** in DSH, open the Plugins page, click Add plugin and enter `dsh-mac-computer-use`, then restart DSH. On first use, grant DeepSeek Harness the Screen Recording and Accessibility permissions.

**Update:** on DSH 0.2.2 or later, open the plugin on the Plugins page and click "Update to …". On older DSH, uninstall it and add it again. A new version can be installed about a day after it is released, because the pnpm that DSH uses skips brand-new versions by default.

Full docs: https://github.com/OrderG-X/dsh-mac-computer-use
