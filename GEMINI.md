# Jellio Workspace Rules

## Release and Changelog Guidelines
- Do not cut or publish a new release after every addition or fix. Wait until explicitly instructed by the user to cut a release.
- Always update What's New changelog entries whenever new features, major enhancements, or big releases are added across Jellio Web (`src/Jellio/Frontend/runtime/changelog.js`), Jellio TV (`app/src/main/java/com/jellio/tv/ui/changelog/Changelog.kt`), and Jellio macOS.
- What's New notifications or popup dialogs are strictly restricted to big releases (`X.Y.0` where patch is 0, e.g. `1.80.0`, `0.43.0`). Small bugfix patch releases (e.g. `1.80.1`, `0.43.1`) must never trigger toast or modal notifications.
- In Settings > About, "What's New" must always display the latest release notes, with past versions cleanly collapsed in expandable sections.
- When new big releases arrive, always clear previous notifications, toasts, and dismiss state for older changelogs so stale alerts do not persist or duplicate.

## Formatting & Git Guidelines
- Strictly NO em dashes anywhere in prose, commit messages, comments, or code. Use hyphens, colons, or parentheses instead.
- All file links in responses must be clickable markdown links formatted with `file:///` and forward slashes (e.g. `[filename](file:///path/to/file)`).
- Git commits must use the author: `NoahSKipp <kippnoahsamuel@gmail.com>`.
