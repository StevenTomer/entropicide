# The Android app

Optional. The site already installs from any browser (*Install* / *Add to Home Screen*); the
Android app adds:

- **Share to Entropicide** from other apps (pages, text, photos, files become Inbox tasks);
- an **Add task notification** you reply to in place, and an **Add task** Quick Settings tile, so
  tasks can be added without leaving the app you're in (they wait on the phone when offline);
- a home-screen icon that opens straight into the site, full screen.

It's a [Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity):
a small app that shows your site in Chrome's engine, so it never needs updating for changes to
the site. You build it for your own site, with your own package name and signing key; the
site then offers it for download at `/install`, and offers updates when you build new versions.

## Building it

Needs Node.js, the Android SDK (`ANDROID_HOME`, default `~/Android/Sdk`, with build-tools and
platform 36) and a JDK 17+ (`JAVA_HOME`).

1. In `deploy/site.conf` (copied from `site.conf.example`), set `SITE_HOST`, `SITE_PATH`,
   `ANDROID_PACKAGE` (yours, e.g. `com.example.entropicide`), `ANDROID_KEY_DIR` and
   `ANDROID_KEY_ALIAS`.
2. Make a signing key, once, outside the project:

   ```sh
   mkdir -p ~/.config/entropicide-android && cd ~/.config/entropicide-android
   openssl rand -base64 24 > password && chmod 600 password
   keytool -genkeypair -keystore release.keystore -alias entropicide -keyalg RSA -keysize 2048 \
       -validity 10000 -storepass "$(cat password)" -dname "CN=Entropicide"
   ```

   **Back it up.** Phones only install updates signed with the same key, and the package name
   can never change either.
3. Build:

   ```sh
   cd android && npm install && node build.mjs
   ```

   This writes `apk/entropicide.apk`, `apk/version.json` (each build takes the next version in
   `android/version.txt`: 1.0.1, 1.0.2, …) and `apk/assetlinks.json`.
4. Serve them: with `install.sh` they're deployed with the app. With Docker, copy the `apk`
   folder into the data folder and set `ENTROPICIDE_APK_DIR: /data/apk` and
   `ENTROPICIDE_ANDROID_PACKAGE`; your web server must also send
   `/.well-known/assetlinks.json` to the app's `/assetlinks.json` (under its path, if it has
   one). Without that file, the app shows an address bar at the top.

The icons come from the SVGs in `static/brand/`; after changing them, run
`./static/brand/make-icons.sh` (needs inkscape and ImageMagick). Note that the name and logo
are trademarks (see `TRADEMARKS.md`): a modified app you distribute needs its own.
