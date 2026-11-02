// Builds the Android app: a Trusted Web Activity (Chrome, full screen) that opens
// Entropicide at https://SITE_HOST/SITE_PATH/ (deploy/site.conf). Writes
// ../apk/entropicide.apk, version.json and assetlinks.json, which the server publishes at
// SITE_PATH/install and /.well-known/assetlinks.json.
//
//   cd android && npm install && node build.mjs      (then deploy)
//
// Needs the Android SDK (ANDROID_HOME, default ~/Android/Sdk) and a JDK 17+ (JAVA_HOME,
// default /usr/lib/jvm/java-21-openjdk). The signing key lives outside the project, in
// site.conf's ANDROID_KEY_DIR (release.keystore + password; made by keytool, see the README).
// Keep a backup of it: Android only installs updates signed with the same key.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AndroidSdkTools, Config, ConsoleLog, DigitalAssetLinks, GradleWrapper, JdkHelper,
  TwaGenerator, TwaManifest,
} from "@bubblewrap/core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "build");
const OUT = path.join(HERE, "..", "apk");
const ICONS = path.join(HERE, "..", "static", "icons");
// Where the site is, and the app's package and key (deploy/site.conf, KEY=value lines).
const SITE = Object.fromEntries(fs.readFileSync(path.join(HERE, "..", "deploy", "site.conf"), "utf8")
  .split("\n").map((line) => line.match(/^\s*([A-Z_]+)=(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
for (const key of ["SITE_HOST", "SITE_PATH", "ANDROID_PACKAGE", "ANDROID_KEY_DIR", "ANDROID_KEY_ALIAS"]) {
  if (!SITE[key]) throw new Error(`deploy/site.conf needs ${key} (see site.conf.example)`);
}
const KEY_DIR = SITE.ANDROID_KEY_DIR.replace(/^~(?=\/|$)/, os.homedir());
const KEYSTORE = path.join(KEY_DIR, "release.keystore");
const ALIAS = SITE.ANDROID_KEY_ALIAS;
const PACKAGE = SITE.ANDROID_PACKAGE;
const NAME = "Entropicide";
const ORIGIN = SITE.SITE_HOST;
const trimmed = SITE.SITE_PATH.replace(/^\/+|\/+$/g, "");
const BASE_PATH = trimmed ? "/" + trimmed : "";  // "/todo", or "" for the whole site

const password = fs.readFileSync(path.join(KEY_DIR, "password"), "utf8").trim();
const log = new ConsoleLog("build");

// Bubblewrap downloads the icons from a URL: serve ours locally while it does.
const iconServer = http.createServer((req, res) => {
  const file = path.join(ICONS, path.basename(req.url));
  if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": "image/png" }).end(fs.readFileSync(file));
});
await new Promise((ok) => iconServer.listen(0, "127.0.0.1", ok));
const iconBase = `http://127.0.0.1:${iconServer.address().port}/`;

// Version: each build takes the next number in version.txt (1.0.1, 1.0.2, …), saved once the
// build succeeds. Android's version code is 1.0.7 → 1000007, so it always goes up (and stays
// above the earlier builds, whose codes were minutes since 2026).
const VERSION_FILE = path.join(HERE, "version.txt");
const [major, minor, patch] = fs.readFileSync(VERSION_FILE, "utf8").trim().split(".").map(Number);
const versionName = `${major}.${minor}.${patch + 1}`;
const versionCode = major * 1_000_000 + minor * 1000 + patch + 1;

const manifest = new TwaManifest({
  packageId: PACKAGE,
  host: ORIGIN,
  name: NAME,
  launcherName: NAME,
  display: "standalone",
  themeColor: "#0866a8",
  navigationColor: "#ffffff",
  navigationColorDark: "#17191d",
  backgroundColor: "#ffffff",
  // Lets the site's notifications (reminders) show as the app's, with the app's icon.
  enableNotifications: true,
  // Appear in Android's Share menu; shares go to the site's SITE_PATH/share (see app.py).
  // The full URL: Chrome checks it against the verified origin, and with a relative one it
  // just opens the start page, dropping what was shared.
  shareTarget: {
    action: `https://${ORIGIN}${BASE_PATH}/share`,
    method: "POST",
    enctype: "multipart/form-data",
    params: { title: "title", text: "text", url: "url", files: [{ name: "files", accept: ["*/*"] }] },
  },
  // The version tells the site which build is running, so it can offer updates (app.js).
  startUrl: `${BASE_PATH}/?app=${versionCode}`,
  fullScopeUrl: `https://${ORIGIN}${BASE_PATH}/`,
  minSdkVersion: 24,  // Android 7; what android-browser-helper needs
  iconUrl: iconBase + "icon-512.png",
  maskableIconUrl: iconBase + "maskable-512.png",
  monochromeIconUrl: iconBase + "monochrome-512.png",  // the status bar's notification icon
  splashScreenFadeOutDuration: 300,
  signingKey: { path: KEYSTORE, alias: ALIAS },
  appVersionCode: versionCode,
  appVersion: versionName,
  fallbackType: "customtabs",
  orientation: "default",
  generatorApp: "entropicide/android/build.mjs",
});
const problem = manifest.validate();
if (problem) throw new Error(problem);

const generator = new TwaGenerator();
await generator.removeTwaProject(PROJECT);
fs.mkdirSync(PROJECT, { recursive: true });
await generator.createTwaProject(PROJECT, manifest, log);
iconServer.close();

// Adding tasks without leaving the app you're in: an "Add task" notification you reply to in
// place (like a text message), and an "Add task" Quick Settings tile that asks in a small box
// over the current app. Both post to SITE_PATH/api/app/add with the phone's own key, which
// Settings → Add from the phone hands over through an entropicide://pair link (app.js,
// fillDevices). Bubblewrap has no options for any of this, so it's added to the generated
// project here: the Java classes, the tile's icon, and their manifest entries.
const SRC = path.join(PROJECT, "app", "src", "main");
const javaDir = path.join(SRC, "java", ...PACKAGE.split("."));
const java = (name, body) => fs.writeFileSync(path.join(javaDir, `${name}.java`), `package ${PACKAGE};\n\n${body}`);
const openUrl = (query) => `https://${ORIGIN}${BASE_PATH}/?app=${versionCode}${query}`;

java("QuickAdd", `import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The phone's key, the Add task notification, and sending tasks to the server. A task typed
 * with no connection waits in a queue (with when it was typed, for its dates) and QueueJob
 * sends it once there's a network.
 */
final class QuickAdd {
    static final String TEXT = "text";
    private static final String ADD_URL = "https://${ORIGIN}${BASE_PATH}/api/app/add";
    private static final String CHANNEL = "quick-add";
    private static final int ID = 7001;
    private static final int JOB = 7002;
    private static final Object LOCK = new Object();

    private QuickAdd() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("quick-add", Context.MODE_PRIVATE);
    }

    static String key(Context c) {
        return prefs(c).getString("key", null);
    }

    /** Opens the app at a page of the site (the start page with ?app=, plus query). */
    static Intent open(Context c, String url) {
        return new Intent(c, LauncherActivity.class).setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    /** Shows (or updates) the notification once the phone is connected; status is the line under its title. */
    static void show(Context c, String status) {
        show(c, status, true);
    }

    // (QueueJob's own sending doesn't schedule another job: that would stop the one running.)
    private static void show(Context c, String status, boolean schedule) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (key(c) == null) {
            nm.cancel(ID);
            return;
        }
        int waiting = queue(c).length();
        if (waiting > 0) {
            if (schedule) scheduleSend(c);
            String line = waiting == 1 ? "1 task waiting for a connection" : waiting + " tasks waiting for a connection";
            status = status == null ? line : status;
        }
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Add task",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Add a task to your Inbox from the notification panel");
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }
        // A reply needs a mutable PendingIntent: Android fills in what was typed.
        int mutable = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        PendingIntent reply = PendingIntent.getBroadcast(c, 1, new Intent(c, ReplyReceiver.class),
                PendingIntent.FLAG_UPDATE_CURRENT | mutable);
        Notification.Action add = new Notification.Action.Builder(
                Icon.createWithResource(c, R.drawable.ic_tile_add), "Add task", reply)
                .addRemoteInput(new RemoteInput.Builder(TEXT).setLabel("New task").build())
                .build();
        PendingIntent tap = PendingIntent.getActivity(c, 2, open(c, "${openUrl("")}"),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        @SuppressWarnings("deprecation")
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL)
                : new Notification.Builder(c).setPriority(Notification.PRIORITY_LOW);
        b.setSmallIcon(R.drawable.ic_notification_icon)
                .setColor(0xFF2F6FDE)
                .setContentTitle("Add a task")
                .setContentText(status != null ? status : "Tap Add task to type one")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(tap)
                .addAction(add);
        nm.notify(ID, b.build());
    }

    /** Sends a task, or queues it if there's no connection (off the main thread); returns what to tell the user. */
    static String submit(Context c, String text) {
        String now = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.US).format(new Date());
        Result r = send(c, text, now);
        if (r.retry) {
            synchronized (LOCK) {
                JSONArray q = queue(c);
                try {
                    q.put(new JSONObject().put("text", text).put("now", now));
                } catch (org.json.JSONException e) {
                    return r.message;
                }
                prefs(c).edit().putString("queue", q.toString()).commit();
            }
            scheduleSend(c);
            return "No connection: it'll be added when you're back online";
        }
        return r.message;
    }

    /** Sends what's waiting; false if some still has to wait (no connection yet). */
    static boolean sendQueue(Context c) {
        synchronized (LOCK) {
            JSONArray q = queue(c);
            JSONArray left = new JSONArray();
            String last = null;
            boolean blocked = false;
            for (int i = 0; i < q.length(); i++) {
                JSONObject item = q.optJSONObject(i);
                if (item == null) continue;
                if (blocked) {
                    left.put(item);
                    continue;
                }
                Result r = send(c, item.optString("text"), item.optString("now"));
                if (r.retry) {
                    blocked = true;
                    left.put(item);
                } else {
                    last = r.message;
                }
            }
            prefs(c).edit().putString("queue", left.toString()).commit();
            show(c, last != null && left.length() == 0 && q.length() == 1 ? last
                    : last != null && left.length() == 0 ? "Sent the " + q.length() + " tasks that were waiting" : null,
                    false);
            return !blocked;
        }
    }

    static JSONArray queue(Context c) {
        try {
            return new JSONArray(prefs(c).getString("queue", "[]"));
        } catch (org.json.JSONException e) {
            return new JSONArray();
        }
    }

    private static void scheduleSend(Context c) {
        JobScheduler jobs = c.getSystemService(JobScheduler.class);
        if (jobs.getPendingJob(JOB) != null) return;
        jobs.schedule(new JobInfo.Builder(JOB, new ComponentName(c, QueueJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build());
    }

    private static final class Result {
        final String message;
        final boolean retry;  // no connection, or the server is down: try again later

        Result(String message, boolean retry) {
            this.message = message;
            this.retry = retry;
        }
    }

    private static Result send(Context c, String text, String typedAt) {
        String key = key(c);
        if (key == null) return new Result("Not connected: in ${NAME}, open Settings → Add from the phone", false);
        HttpURLConnection con = null;
        try {
            con = (HttpURLConnection) new URL(ADD_URL + "?now=" + typedAt).openConnection();
            con.setConnectTimeout(10000);
            con.setReadTimeout(10000);
            con.setRequestMethod("POST");
            con.setDoOutput(true);
            con.setRequestProperty("Content-Type", "application/json");
            con.setRequestProperty("X-Requested-With", "entropicide");
            con.setRequestProperty("Authorization", "Bearer " + key);
            JSONObject body = new JSONObject().put("text", text)
                    .put("lang", Locale.getDefault().toLanguageTag());
            try (OutputStream out = con.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = con.getResponseCode();
            if (code >= 500) return new Result("The server isn't answering", true);
            String reply = read(code < 400 ? con.getInputStream() : con.getErrorStream());
            JSONObject res = new JSONObject();
            try {
                res = new JSONObject(reply);
            } catch (org.json.JSONException ignored) {
                // (not JSON: a proxy's error page)
            }
            if (code == 201) return new Result("Added: " + res.optString("summary", text), false);
            // Disconnected in Settings: forget the key, which also takes the notification away.
            if (code == 401) prefs(c).edit().remove("key").remove("queue").commit();
            return new Result(res.optString("error", "Not added (the server said " + code + "): " + text), false);
        } catch (java.io.IOException | org.json.JSONException e) {
            return new Result("No connection", true);
        } finally {
            if (con != null) con.disconnect();
        }
    }

    private static String read(InputStream in) throws java.io.IOException {
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }
}
`);

java("ReplyReceiver", `import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/** What was typed into the notification's Add task reply. */
public class ReplyReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence typed = results == null ? null : results.getCharSequence(QuickAdd.TEXT);
        String text = typed == null ? "" : typed.toString().trim();
        Context app = context.getApplicationContext();
        if (text.isEmpty()) {
            QuickAdd.show(app, null);  // (ends the reply's spinner)
            return;
        }
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                QuickAdd.show(app, QuickAdd.submit(app, text));
            } finally {
                pending.finish();
            }
        }).start();
    }
}
`);

java("QueueJob", `import android.app.job.JobParameters;
import android.app.job.JobService;

/** Sends tasks typed while offline, once there's a network (scheduled by QuickAdd). */
public class QueueJob extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> jobFinished(params, !QuickAdd.sendQueue(getApplicationContext()))).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;  // try again later
    }
}
`);

java("BootReceiver", `import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Puts the notification back after the phone restarts or the app is updated. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        QuickAdd.show(context, null);
    }
}
`);

java("PairActivity", `import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.widget.Toast;

/**
 * entropicide://pair?key=…&user=…, from Settings → Add from the phone: after asking (any app
 * can send such a link, and tasks typed here would go to that account), keeps the key and
 * shows the notification.
 */
public class PairActivity extends Activity {
    private static final String NOTIFY = "android.permission.POST_NOTIFICATIONS";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Uri data = getIntent().getData();
        String key = data == null ? null : data.getQueryParameter("key");
        String user = data == null ? null : data.getQueryParameter("user");
        if (key == null || key.isEmpty()) {
            finish();
            return;
        }
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Connect this phone?")
                .setMessage("Tasks you add from the notification or the Add task tile will go to "
                        + (user == null || user.isEmpty() ? "the account that sent this link" : user)
                        + " at ${ORIGIN}.")
                .setPositiveButton("Connect", (d, which) -> connect(key))
                .setNegativeButton("Cancel", (d, which) -> finish())
                .setOnCancelListener((d) -> finish())
                .show();
    }

    private void connect(String key) {
        QuickAdd.prefs(this).edit().putString("key", key).apply();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(NOTIFY) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {NOTIFY}, 1);
        } else {
            done();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        done();
    }

    private void done() {
        QuickAdd.show(this, "Connected. Tap Add task to type one");
        Toast.makeText(this, "Connected: add tasks from the notification, or the Add task tile",
                Toast.LENGTH_LONG).show();
        finish();
    }
}
`);

java("QuickAddTile", `import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import android.text.InputType;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

/** The Add task tile: a small box over whatever's on screen (or, before connecting, Settings). */
public class QuickAddTile extends TileService {
    @Override
    public void onStartListening() {
        Tile tile = getQsTile();
        if (tile == null) return;
        tile.setState(Tile.STATE_INACTIVE);
        tile.updateTile();
    }

    @Override
    public void onClick() {
        if (isLocked()) unlockAndRun(this::ask);
        else ask();
    }

    private void ask() {
        if (QuickAdd.key(this) == null) {
            openApp("${openUrl("&connect=1")}");
            return;
        }
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        int pad = Math.round(20 * getResources().getDisplayMetrics().density);
        AlertDialog.Builder builder = new AlertDialog.Builder(this, night
                ? android.R.style.Theme_DeviceDefault_Dialog_Alert
                : android.R.style.Theme_DeviceDefault_Light_Dialog_Alert);
        // Made from the dialog's context, so the text takes its theme (light on dark at night),
        // not the tile service's (black).
        EditText field = new EditText(builder.getContext());
        field.setHint("New task");
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        field.setImeOptions(EditorInfo.IME_ACTION_DONE);
        FrameLayout box = new FrameLayout(builder.getContext());
        box.setPadding(pad, pad / 2, pad, 0);
        box.addView(field);
        AlertDialog dialog = builder
                .setTitle("Add a task")
                .setView(box)
                .setPositiveButton("Add", (d, which) -> send(field.getText().toString()))
                .setNegativeButton("Cancel", null)
                .create();
        field.setOnEditorActionListener((v, action, event) -> {
            send(field.getText().toString());
            dialog.dismiss();
            return true;
        });
        dialog.getWindow().setSoftInputMode(
                android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        showDialog(dialog);
        field.requestFocus();
    }

    private void send(String typed) {
        String text = typed.trim();
        if (text.isEmpty()) return;
        Context app = getApplicationContext();
        Handler main = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            String result = QuickAdd.submit(app, text);
            QuickAdd.show(app, result);
            main.post(() -> Toast.makeText(app, result, Toast.LENGTH_SHORT).show());
        }).start();
    }

    @SuppressWarnings("deprecation")
    private void openApp(String url) {
        Intent intent = QuickAdd.open(this, url);
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        } else {
            startActivityAndCollapse(intent);
        }
    }
}
`);

// Opening the app puts the notification back, if it was swiped away.
const launcher = path.join(javaDir, "LauncherActivity.java");
const launcherSrc = fs.readFileSync(launcher, "utf8");
if (!launcherSrc.includes("super.onCreate(savedInstanceState);")) throw new Error("LauncherActivity changed");
fs.writeFileSync(launcher, launcherSrc.replace("super.onCreate(savedInstanceState);",
  "super.onCreate(savedInstanceState);\n        QuickAdd.show(this, null);"));

fs.mkdirSync(path.join(SRC, "res", "drawable"), { recursive: true });
fs.writeFileSync(path.join(SRC, "res", "drawable", "ic_tile_add.xml"),
  `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp"
    android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFFFF" android:pathData="M19,13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
</vector>
`);
const manifestFile = path.join(SRC, "AndroidManifest.xml");
const manifestSrc = fs.readFileSync(manifestFile, "utf8");
if (!manifestSrc.includes("</application>")) throw new Error("AndroidManifest.xml changed");
fs.writeFileSync(manifestFile, manifestSrc
  .replace("<application", `<uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>

    <application`)
  .replace("</application>", `
        <service android:name=".QuickAddTile"
            android:label="Add task"
            android:icon="@drawable/ic_tile_add"
            android:exported="true"
            android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
            <intent-filter>
                <action android:name="android.service.quicksettings.action.QS_TILE"/>
            </intent-filter>
        </service>
        <receiver android:name=".ReplyReceiver" android:exported="false"/>
        <service android:name=".QueueJob"
            android:permission="android.permission.BIND_JOB_SERVICE"
            android:exported="false"/>
        <receiver android:name=".BootReceiver" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED"/>
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED"/>
            </intent-filter>
        </receiver>
        <activity android:name=".PairActivity"
            android:exported="true"
            android:excludeFromRecents="true"
            android:theme="@android:style/Theme.Translucent.NoTitleBar">
            <intent-filter>
                <action android:name="android.intent.action.VIEW"/>
                <category android:name="android.intent.category.DEFAULT"/>
                <category android:name="android.intent.category.BROWSABLE"/>
                <data android:scheme="entropicide" android:host="pair"/>
            </intent-filter>
        </activity>
    </application>`));

const config = new Config(
  process.env.JAVA_HOME || "/usr/lib/jvm/java-21-openjdk",
  process.env.ANDROID_HOME || path.join(os.homedir(), "Android", "Sdk"));
const jdk = new JdkHelper(process, config);
// (Not AndroidSdkTools.create, which rejects the current SDK folder layout.)
const sdk = new AndroidSdkTools(process, config, jdk, log);
// No lingering Gradle daemon, so the build (and this script) ends when it's done.
fs.appendFileSync(path.join(PROJECT, "gradle.properties"), "\norg.gradle.daemon=false\n");
await new GradleWrapper(process, sdk, PROJECT).assembleRelease();

const built = path.join(PROJECT, "app", "build", "outputs", "apk", "release");
fs.mkdirSync(OUT, { recursive: true });
const aligned = path.join(built, "app-release-aligned.apk");
await sdk.zipalign(path.join(built, "app-release-unsigned.apk"), aligned);
await sdk.apksigner(KEYSTORE, password, ALIAS, password, aligned, path.join(OUT, "entropicide.apk"));
fs.rmSync(path.join(OUT, "entropicide.apk.idsig"), { force: true });  // only for adb streaming installs
fs.rmSync(path.join(OUT, "todo.apk"), { force: true });  // (its name before Entropicide)

// The key's fingerprint, for assetlinks.json.
const list = execFileSync("keytool", ["-list", "-v", "-keystore", KEYSTORE, "-alias", ALIAS,
  "-storepass", password], { encoding: "utf8" });
const sha256 = list.match(/SHA256:\s*([0-9A-F:]+)/)[1];
fs.writeFileSync(path.join(OUT, "assetlinks.json"),
  DigitalAssetLinks.generateAssetLinks(PACKAGE, sha256) + "\n");

// What the site offers as the latest build (SITE_PATH/install/version).
fs.writeFileSync(path.join(OUT, "version.json"),
  JSON.stringify({ code: versionCode, name: versionName }) + "\n");
fs.writeFileSync(VERSION_FILE, versionName + "\n");

console.log(`Built ${path.join(OUT, "entropicide.apk")}, version ${versionName} (${versionCode}).`);
