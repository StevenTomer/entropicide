# Google Calendar sync

Each user can put their dated tasks on a Google calendar (a shared one like *Family*, or a
new *Entropicide* calendar), kept in step both ways every minute, and see their calendars'
events in Focus and the Calendar view. It needs a Google OAuth client, made once by whoever
runs the site, in the [Google Cloud console](https://console.cloud.google.com/):

1. Create a project, then **APIs & Services → Library → Google Calendar API → Enable**.
2. **Google Auth Platform → Branding / Audience**: user type *External*; add the scopes
   `openid`, `.../auth/userinfo.email` and `.../auth/calendar`. Then **publish** the app
   ("In production"): left in *Testing*, Google expires its access every 7 days. Unverified,
   people see a "Google hasn't verified this app" warning when connecting (*Advanced →
   continue*), which is fine for up to 100 people.
3. **Clients → Create client**, type *Web application*, with the authorized redirect URI
   `https://YOUR-SITE/google/callback` (with your path, if it has one: `…/tasks/google/callback`).
4. Give the app the client ID and secret: `ENTROPICIDE_GOOGLE_CLIENT_ID` and
   `ENTROPICIDE_GOOGLE_CLIENT_SECRET` (in `docker-compose.yml`; with `install.sh`, run
   `sudo ./deploy/google-setup.sh`), and restart it.

Then each user connects from **Settings → Google Calendar** and picks the calendar their tasks
go on. Google's tokens are kept in the app's database, so keep the data folder private. The
privacy page (`/privacy`) describes what the app does with Google data; Google asks for it
when the app is published.
