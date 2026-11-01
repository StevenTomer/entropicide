"""The pages load, with the right name, address and settings."""
from conftest import entropicide


def test_sign_in_page(app):
    page = app.test_client().get("/login").get_data(as_text=True)
    assert "<title>Sign in · Entropicide</title>" in page
    assert "icons/logo.svg" in page


def test_signed_out_app_goes_to_login(app):
    r = app.test_client().get("/")
    assert r.status_code == 302 and "/login" in r.location


def test_app_page(user_client):
    page = user_client("ann").get("/").get_data(as_text=True)
    assert "icons/logo-name.svg" in page and "window.ENTROPICIDE_BASE" in page


def test_manifest(app):
    m = app.test_client().get("/manifest.webmanifest").get_json()
    assert m["name"] == "Entropicide" and m["share_target"]["method"] == "POST"


def test_privacy_page_names_the_operator(app, monkeypatch):
    client = app.test_client()
    assert "ask the person who invited you" in client.get("/privacy").get_data(as_text=True)
    monkeypatch.setenv("ENTROPICIDE_OPERATOR", "Pat Example")
    monkeypatch.setenv("ENTROPICIDE_CONTACT", "pat@example.com")
    page = client.get("/privacy").get_data(as_text=True)
    assert "run by Pat Example" in page and 'href="mailto:pat@example.com"' in page


def test_settings_come_from_the_environment_first(monkeypatch):
    monkeypatch.setitem(entropicide.SITE, "OPERATOR", "From site.conf")
    assert entropicide.setting("OPERATOR") == "From site.conf"
    monkeypatch.setenv("ENTROPICIDE_OPERATOR", "From the environment")
    assert entropicide.setting("OPERATOR") == "From the environment"


def test_secret_key_is_kept(tmp_path, monkeypatch):
    monkeypatch.delenv("ENTROPICIDE_SECRET_KEY")
    db_path = str(tmp_path / "x.db")
    first = entropicide.secret_key(db_path)
    assert len(first) == 64 and entropicide.secret_key(db_path) == first
    assert (tmp_path / "secret_key").stat().st_mode & 0o777 == 0o600
