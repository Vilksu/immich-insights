# Contributing

Thanks for helping improve Immich Insights. The project is licensed under the [MIT License](LICENSE). Contributions are submitted under the same license.

## Development workflow

Use the local setup and checks in [README.md](README.md#development). Keep changes focused and add backend tests for counting, account isolation, API compatibility, or cache behavior. Run `python -m unittest discover -s tests`, `npm run check:i18n`, and `npm run build` before submitting a change.

The frontend uses English UI copy as translation keys. For new visible text, write `t('English source text')` in a component and add that exact key to both `frontend/src/de.ts` and `frontend/src/es.ts`. Keep placeholders such as `{year}` identical in every language. The English text itself is the fallback, so there is no separate English message file.

The translation check discovers registered packs and checks missing keys and placeholder mismatches. Backend messages and generated reports use English. Compatibility adapters normalize labels from existing snapshots; new strings must not rely on those adapters. Localize visible data-derived labels at the UI boundary without translating real device names or users' metadata.

Write code comments and contributor documentation in English.

## Privacy and compatibility

Never commit `.env`, database files, encryption keys, Immich API keys, exports, or private asset metadata. Use synthetic fixtures in tests and synthetic or approved demo data in screenshots. Check image rights before publishing screenshots. Treat exported SQLite files as sensitive even though they exclude credentials.

Keep the bundled Docker Compose installation compatible with NAS interfaces that build local Dockerfiles. Avoid assumptions about a user's Immich hostname or Docker network. Preserve existing cached data and encryption keys when changing storage or database configuration; document any required migration before release.

If you discover a security issue, do not post credentials, private library data, or an exploit in a public issue. Contact the maintainer privately before disclosure.
