"""The Share menu target, and the App log of shares and Android app launches (/debug)."""
import io
import json
import os

from conftest import entropicide, rows, sign_in


def log(app):
    return [r | {"detail": json.loads(r["detail"])} for r in rows(app, "SELECT * FROM app_log ORDER BY id")]


def test_signed_out_share_is_logged(app):
    r = app.test_client().post(
        "/share", data={"text": "hi", "files": (io.BytesIO(b"x" * 10), "a.jpg", "image/jpeg")},
        content_type="multipart/form-data",
        headers={"Referer": "android-app://com.example.app/", "User-Agent": "Mozilla/5.0 (Linux; Android 14)"})
    assert r.status_code == 302 and "/login" in r.location
    entry = log(app)[-1]
    assert entry["kind"] == "share" and entry["detail"]["signed_in"] is False
    assert "Not signed in" in entry["detail"]["result"]
    assert entry["detail"]["files"] == [{"field": "files", "name": "a.jpg", "type": "image/jpeg", "size": 10}]
    assert "Android 14" in entry["detail"]["agent"]


def test_nameless_photo_is_named_after_its_type(app, user_client):
    client = user_client("ann")
    r = client.post("/share", data={"files": (io.BytesIO(b"\xff\xd8photo"), "", "image/jpeg")},
                    content_type="multipart/form-data")
    assert "shared=" in r.location
    task_id = int(r.location.split("shared=")[1])
    task = next(t for t in client.get("/api/data").get_json()["tasks"] if t["id"] == task_id)
    assert task["title"].startswith("shared-1") and task["attachments"][0]["name"].startswith("shared-1.jp")
    assert "1 file" in log(app)[-1]["detail"]["result"]


def test_shared_text_and_link(app, user_client):
    client = user_client("ann")
    client.post("/share", data={"text": "Look at this https://example.com/x"}, content_type="multipart/form-data")
    task = client.get("/api/data").get_json()["tasks"][-1]
    assert task["title"] == "Look at this" and "https://example.com/x" in task["notes"]


def test_too_large_share(app, user_client, monkeypatch):
    client = user_client("ann")
    monkeypatch.setitem(app.config, "MAX_CONTENT_LENGTH", 1000)
    r = client.post("/share", data={"files": (io.BytesIO(b"x" * 5000), "big.jpg", "image/jpeg")},
                    content_type="multipart/form-data")
    assert r.status_code == 413 and "Too large" in log(app)[-1]["detail"]["result"]


def test_launches_are_logged(app, user_client):
    client = user_client("ann")
    client.get("/")
    assert log(app) == []  # an ordinary page load isn't
    client.get("/?app=437970")
    assert log(app)[-1]["detail"]["app_version"] == "an early build (437970)"
    client.get("/?app=1000003")
    assert log(app)[-1]["detail"]["app_version"] == "1.0.3"
    app.test_client().get("/", headers={"Referer": "android-app://com.example.app/"})
    assert log(app)[-1]["kind"] == "launch" and log(app)[-1]["detail"]["signed_in"] is False


def test_app_log_page(app, user_client, tmp_path):
    with open(os.path.join(entropicide.APK_DIR, "version.json"), "w") as f:
        json.dump({"code": 1000005, "name": "1.0.5"}, f)
    admin = user_client("boss", admin=True)
    app.test_client().post("/share", data={"text": "anonymous"}, content_type="multipart/form-data")
    page = admin.get("/debug").get_data(as_text=True)
    assert "Not signed in" in page and "Latest Android app: 1.0.5" in page and "Send test share" in page
    other = user_client("kid")
    other.post("/share", data={"text": "from kid"}, content_type="multipart/form-data")
    page = other.get("/debug").get_data(as_text=True)
    assert "from kid" in page and "Not signed in" not in page  # only their own
    assert app.test_client().get("/debug").status_code == 302
    version = app.test_client().get("/install/version")
    assert version.get_json() == {"code": 1000005, "name": "1.0.5"}
    assert "no-cache" in version.headers["Cache-Control"]


def test_app_log_is_trimmed(app, user_client):
    client = user_client("ann")
    with app.app_context():
        conn = entropicide.db.get_db()
        conn.executemany("INSERT INTO app_log (kind) VALUES ('x')", [()] * 400)
        conn.commit()
    client.get("/?app=1")
    assert len(log(app)) <= entropicide.APP_LOG_KEEP + 1


def test_sign_in_throttled(app, make_user):
    make_user("ann")
    client = app.test_client()
    for _ in range(entropicide.MAX_FAILURES):
        sign_in(client, "ann", "wrong")
    r = sign_in(client, "ann")  # the right password, too late
    assert r.status_code != 302


def test_many_usernames_from_one_address_are_throttled(app, make_user):
    make_user("ann")
    client = app.test_client()
    for i in range(entropicide.MAX_FAILURES_PER_IP):
        sign_in(client, f"guess{i}", "wrong")
    assert sign_in(client, "ann").status_code != 302


def test_security_headers(app):
    r = app.test_client().get("/login")
    assert r.headers["X-Frame-Options"] == "DENY" and r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["Referrer-Policy"] == "same-origin"


def test_admins_dont_see_what_others_shared(app, user_client):
    kid = user_client("kid")
    kid.post("/share", data={"text": "secret plans", "files": (io.BytesIO(b"x"), "diary.txt", "text/plain")},
             content_type="multipart/form-data")
    admin_page = user_client("boss", admin=True).get("/debug").get_data(as_text=True)
    assert "secret plans" not in admin_page and "diary.txt" not in admin_page
    assert "Added task" in admin_page  # but what happened is there
    assert "secret plans" in kid.get("/debug").get_data(as_text=True)
