# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for a feature

Open an issue. For a bug, say what you did, what you expected and what happened instead, and
which browser (or the Android app, and its version from Settings → Troubleshooting). Settings →
Troubleshooting → *App log* helps with problems sharing to the app or adding from the phone.

Security problems: please don't open a public issue; see [SECURITY.md](SECURITY.md).

## Making a change

1. Set up as in the README's *Developing* section, and run the tests (`venv/bin/python -m pytest`).
2. Keep to how the code is already written:
   - Server: Flask and the standard library, SQLite through `db.py`; schema changes go in
     `db.py`'s `SCHEMA` (new tables) or `migrate()` (changes to existing ones), so existing
     databases are upgraded in place.
   - Browser: plain JavaScript in `static/app.js` (quick add's parser in `static/quickadd.js`,
     which the server also runs for phone adds), no build step and no framework. Changes to
     tasks should keep working offline (see the outbox in `app.js`).
   - Comments say *why*, in plain sentences; names are spelled out.
   - Anything a user can see should read as plain, friendly English, and be in the Help page
     (`templates/help.html`) if it's a feature.
3. Add or update tests in `tests/` for server behaviour you change.
4. Open a pull request describing the change and how you checked it (and a screenshot, for
   anything visible).

By contributing, you agree that your contributions are licensed under the project's license,
the [AGPL-3.0](LICENSE).
