"""Inventories: items used up (counted, restocked) or kept (lent); barcodes; locations; sharing."""
import pytest

from conftest import H, rows


@pytest.fixture
def pantry(user_client):
    ann = user_client("ann")
    inv = ann.post("/api/inventories", json={"name": "Pantry"}, headers=H).get_json()
    return ann, inv["id"]


def count(client, inv, **c):
    return client.post("/api/items/count", json={"inventory_id": inv, **c}, headers=H)


def items(client):
    return {i["name"]: i for i in client.get("/api/data").get_json()["items"]}


def test_type_twelve_scan_done(pantry):
    """Adding 12 cans of soup: the count, then the barcode; a new barcode asks its name once."""
    ann, inv = pantry
    assert count(ann, inv, code="0051000012616", delta=12).get_json() == {"unknown": "0051000012616"}
    r = count(ann, inv, code="0051000012616", delta=12, name="Tomato soup", unit="cans").get_json()
    assert r["made"] and (r["item"]["quantity"], r["item"]["codes"], r["item"]["used_up"]) == (12, ["0051000012616"], True)
    r = count(ann, inv, code="0051000012616", delta=12).get_json()
    assert (r["before"], r["after"]) == (12, 24)
    # Using some; never below none.
    assert count(ann, inv, code="0051000012616", delta=-30).get_json()["after"] == 0
    # By name, and by id with a second barcode (another brand).
    sid = items(ann)["Tomato soup"]["id"]
    assert count(ann, inv, name="tomato SOUP", delta=2).get_json()["after"] == 2
    count(ann, inv, item_id=sid, code="0011110038364", delta=1)
    assert items(ann)["Tomato soup"]["codes"] == ["0011110038364", "0051000012616"]
    assert count(ann, inv, code="0011110038364", delta=1).get_json()["after"] == 4


def test_a_barcode_means_one_product(pantry):
    """A barcode is one product in your catalog, for all your inventories."""
    ann, inv = pantry
    count(ann, inv, code="111", delta=1, name="Rice")
    beans = ann.post("/api/items", json={"name": "Beans", "inventory_id": inv}, headers=H).get_json()["id"]
    assert ann.patch(f"/api/items/{beans}", json={"codes": ["111"]}, headers=H).status_code == 400
    # In another inventory, it's the same product, brought in.
    other = ann.post("/api/inventories", json={"name": "Cabin"}, headers=H).get_json()["id"]
    r = count(ann, other, code="111", delta=3)
    assert r.status_code == 201 and (r.get_json()["item"]["name"], r.get_json()["item"]["quantity"]) == ("Rice", 3)
    d = ann.get("/api/data").get_json()
    assert [p["name"] for p in d["products"]] == ["Beans", "Rice"]
    assert len({i["product_id"] for i in d["items"] if i["name"] == "Rice"}) == 1
    # Once in an inventory: counting it again counts that one.
    assert count(ann, other, code="111", delta=1).get_json()["after"] == 4
    rice = next(p for p in d["products"] if p["name"] == "Rice")["id"]
    assert ann.post("/api/items", json={"product_id": rice, "inventory_id": other}, headers=H).status_code == 400


def test_low_stock_makes_one_task_and_restocking_ends_it(app, pantry):
    ann, inv = pantry
    rice = ann.post("/api/items", json={"name": "Rice", "inventory_id": inv, "quantity": 3, "unit": "bags",
                                        "keep_at_least": 2, "restock_to": 6}, headers=H).get_json()["id"]
    open_tasks = lambda: [t["title"] for t in ann.get("/api/data").get_json()["tasks"]]  # noqa: E731
    assert open_tasks() == []
    count(ann, inv, item_id=rice, delta=-2)
    assert open_tasks() == ["Buy Rice (5 bags)"]
    count(ann, inv, item_id=rice, delta=-1)
    assert open_tasks() == ["Buy Rice (6 bags)"]  # (one task, saying how many now)
    projects = [p["name"] for p in ann.get("/api/data").get_json()["projects"]]
    assert projects == ["Shopping: Pantry"]
    count(ann, inv, item_id=rice, delta=6)
    assert open_tasks() == []
    # Kept things are never bought again, nor used up.
    shears = ann.post("/api/items", json={"name": "Shears", "inventory_id": inv, "used_up": False}, headers=H).get_json()
    assert shears["quantity"] == 1
    assert count(ann, inv, item_id=shears["id"], delta=-1).get_json()["kept"]
    assert items(ann)["Shears"]["quantity"] == 1


def test_lending(app, pantry):
    ann, inv = pantry
    home = ann.post("/api/inventories", json={"name": "House", "kind": "home"}, headers=H).get_json()["id"]
    ladder = ann.post("/api/items", json={"name": "Ladder", "inventory_id": home}, headers=H).get_json()
    assert (ladder["used_up"], ladder["quantity"]) == (False, 1)  # (a home inventory's things are kept)
    ann.patch(f"/api/items/{ladder['id']}", json={"lent_to": "Bob"}, headers=H)
    it = items(ann)["Ladder"]
    task = [t for t in ann.get("/api/data").get_json()["tasks"] if t["title"] == "Get Ladder back from Bob"][0]
    assert it["lent_to"] == "Bob" and it["lent_on"] and (task["state"], task["waiting_for"]) == ("waiting", "Bob")
    # Ticking off the task: it's back.
    ann.patch(f"/api/tasks/{task['id']}", json={"completed": True}, headers=H)
    assert items(ann)["Ladder"]["lent_to"] is None


def test_locations(pantry):
    ann, inv = pantry
    loc = lambda **x: ann.post("/api/locations", json={"inventory_id": inv, **x}, headers=H).get_json()  # noqa: E731
    basement = loc(name="Basement")["id"]
    shelf = loc(name="Shelf 2", parent_id=basement)["id"]
    bin_ = loc(name="Blue bin", parent_id=shelf)["id"]
    assert ann.patch(f"/api/locations/{basement}", json={"parent_id": bin_}, headers=H).status_code == 400
    item = ann.post("/api/items", json={"name": "Candles", "inventory_id": inv, "location_id": bin_}, headers=H).get_json()
    assert item["location_id"] == bin_
    other = ann.post("/api/inventories", json={"name": "Cabin"}, headers=H).get_json()["id"]
    assert ann.post("/api/items", json={"name": "X", "inventory_id": other, "location_id": bin_}, headers=H).status_code == 400
    # A place going leaves what was in it, with no place.
    ann.delete(f"/api/locations/{shelf}", headers=H)
    assert items(ann)["Candles"]["location_id"] is None
    assert [x["name"] for x in ann.get("/api/data").get_json()["locations"]] == ["Basement"]


def test_a_shared_inventory(app, user_client):
    ann, bob, cat, dan = (user_client(n) for n in ("ann", "bob", "cat", "dan"))
    gid = ann.post("/api/groups", json={"name": "Family"}, headers=H).get_json()["groups"][0]["id"]
    for who, role in (("bob", "editor"), ("cat", "viewer")):
        ann.post(f"/api/groups/{gid}/invites", json={"username": who, "role": role}, headers=H)
    for c in (bob, cat):
        c.post(f"/api/invites/{c.get('/api/groups').get_json()['invites'][0]['id']}/accept", headers=H)
    inv = ann.post("/api/inventories", json={"name": "Pantry"}, headers=H).get_json()["id"]
    count(ann, inv, code="222", delta=4, name="Beans")
    ann.patch(f"/api/inventories/{inv}", json={"group_id": gid}, headers=H)
    # Bob counts (and adds new things, which are shared too); Cat looks; Dan can't reach it.
    assert count(bob, inv, code="222", delta=-1).get_json()["after"] == 3
    count(bob, inv, code="333", delta=2, name="Corn")
    assert items(ann)["Corn"]["group_id"] == gid
    assert set(items(cat)) == {"Beans", "Corn"}
    assert count(cat, inv, code="222", delta=-1).status_code == 403
    assert count(dan, inv, code="222", delta=-1).status_code == 404
    assert items(dan) == {}
    # The shopping list is shared too: Bob sees the task when Beans run low.
    bob.patch(f"/api/items/{items(bob)['Beans']['id']}", json={"keep_at_least": 5}, headers=H)
    assert any(t["title"].startswith("Buy Beans") and t["group_id"] == gid for t in bob.get("/api/data").get_json()["tasks"])
    # Deleting the inventory takes what's in it (only whoever made it can).
    assert bob.delete(f"/api/inventories/{inv}", headers=H).status_code == 403
    ann.delete(f"/api/inventories/{inv}", headers=H)
    assert rows(app, "SELECT COUNT(*) AS n FROM documents WHERE kind = 'item'") == [{"n": 0}]


def test_brand_category_store_and_link(pantry):
    ann, inv = pantry
    r = count(ann, inv, code="0051000012616", delta=12, name="Tomato soup", brand="Campbell's", category="Canned goods")
    sid = r.get_json()["item"]["id"]
    it = ann.patch(f"/api/items/{sid}", json={"store": "Walmart", "url": "walmart.com/ip/10308169"}, headers=H).get_json()
    assert (it["brand"], it["category"], it["store"], it["url"]) == ("Campbell's", "Canned goods", "Walmart", "https://walmart.com/ip/10308169")
    assert ann.patch(f"/api/items/{sid}", json={"url": "javascript:alert(1)"}, headers=H).status_code == 400


def test_products_are_what_items_are(app, pantry):
    """A product says what a thing is; its items (one an inventory) say how many, and where."""
    ann, inv = pantry
    p = ann.post("/api/products", json={"name": "Tomato soup", "brand": "Campbell's", "unit": "cans",
                                        "codes": ["0051000012616"]}, headers=H).get_json()
    assert (p["used_up"], p["codes"], p["image"]) == (True, ["0051000012616"], None)
    cabin = ann.post("/api/inventories", json={"name": "Cabin"}, headers=H).get_json()["id"]
    for where in (inv, cabin):
        count(ann, where, product_id=p["id"], delta=6)
    # Renaming the product renames its items, and their "Buy …" task.
    soup = items(ann)["Tomato soup"]["id"]
    ann.patch(f"/api/items/{soup}", json={"keep_at_least": 10}, headers=H)
    ann.patch(f"/api/products/{p['id']}", json={"name": "Tomato bisque", "unit": "tins"}, headers=H)
    d = ann.get("/api/data").get_json()
    assert sorted((i["name"], i["unit"]) for i in d["items"]) == [("Tomato bisque", "tins")] * 2
    assert any(t["title"] == "Buy Tomato bisque (4 tins)" for t in d["tasks"])
    # A picture, of its own (not an attachment of any item).
    import io
    r = ann.post(f"/api/products/{p['id']}/image", data={"file": (io.BytesIO(b"\x89PNG fake"), "soup.png")},
                 headers=H, content_type="multipart/form-data")
    assert r.status_code == 200 and r.get_json()["image"].startswith("/api/products/")
    assert ann.get(r.get_json()["image"]).get_data() == b"\x89PNG fake"
    assert ann.post(f"/api/products/{p['id']}/image", data={"file": (io.BytesIO(b"<svg/>"), "x.svg")},
                    headers=H, content_type="multipart/form-data").status_code == 400
    # Not deleted while something's of it; its picture's bytes go with it.
    assert ann.delete(f"/api/products/{p['id']}", headers=H).status_code == 400
    for i in d["items"]:
        ann.patch(f"/api/items/{i['id']}", json={"deleted": True}, headers=H)
    with app.app_context():
        conn = __import__("conftest").entropicide.db.get_db()
        conn.execute("DELETE FROM documents WHERE kind = 'item'")
        conn.commit()
    assert ann.delete(f"/api/products/{p['id']}", headers=H).status_code == 200
    assert rows(app, "SELECT COUNT(*) AS n FROM blobs") == [{"n": 0}]


def test_others_see_products_through_a_shared_inventory(app, user_client):
    ann, bob = user_client("ann"), user_client("bob")
    gid = ann.post("/api/groups", json={"name": "Family"}, headers=H).get_json()["groups"][0]["id"]
    ann.post(f"/api/groups/{gid}/invites", json={"username": "bob", "role": "editor"}, headers=H)
    bob.post(f"/api/invites/{bob.get('/api/groups').get_json()['invites'][0]['id']}/accept", headers=H)
    inv = ann.post("/api/inventories", json={"name": "Pantry"}, headers=H).get_json()["id"]
    lone = ann.post("/api/products", json={"name": "Not in there"}, headers=H).get_json()["id"]
    count(ann, inv, code="222", delta=4, name="Beans")
    assert bob.get("/api/data").get_json()["products"] == []
    ann.patch(f"/api/inventories/{inv}", json={"group_id": gid}, headers=H)
    assert [p["name"] for p in bob.get("/api/data").get_json()["products"]] == ["Beans"]
    assert bob.patch(f"/api/products/{lone}", json={"name": "Mine now"}, headers=H).status_code == 404
    beans = bob.get("/api/data").get_json()["products"][0]["id"]
    assert bob.patch(f"/api/products/{beans}", json={"brand": "Bush's"}, headers=H).status_code == 200
    # Bob's scan of Ann's barcode, in the shared pantry, counts Ann's beans.
    assert count(bob, inv, code="222", delta=1).get_json()["after"] == 5


def fake_web(monkeypatch, pages):
    """fetch_url answering from pages: {url start: (body, content type)}; the URLs asked for."""
    from conftest import entropicide
    asked = []

    def fetch(url, data=None, headers=None, limit=0, timeout=0):
        asked.append(url)
        for start, (body, kind) in pages.items():
            if url.startswith(start):
                return (body if isinstance(body, bytes) else body.encode()), kind, url
        raise OSError("no such page")
    monkeypatch.setattr(entropicide, "fetch_url", fetch)
    return asked


WALMART_PAGE = """<html><head><meta property="og:title" content="REYNOLDS KITCHENS SLOW COOKER LINERS, Regular Size, 6 Count - Walmart.com">
<meta property="og:url" content="https://www.walmart.com/ip/Reynolds-Slow-Cooker-Liners/10294030">
<meta property="og:image" content="https://i5.walmartimages.com/seo/liners.jpeg"></head>
<script>{"brand":"REYNOLDS KITCHENS","upc":"010900577779"}</script></html>"""


def test_looking_up_finds_the_walmart_page(app, pantry, monkeypatch):
    ann, inv = pantry
    asked = fake_web(monkeypatch, {
        "https://google.serper.dev/search": (json_text({"organic": [{"link": "https://www.target.com/p/x"},
                                                                    {"link": "https://www.walmart.com/ip/Reynolds/10294030"}]}), "application/json"),
        "https://www.walmart.com/ip/": (WALMART_PAGE, "text/html"),
        "https://i5.walmartimages.com/": (b"\xff\xd8jpeg", "image/jpeg"),
    })
    # Without a key: no searching, and so a search of Walmart's pages, for the person to open.
    r = ann.get("/api/codes/010900577779").get_json()
    assert r["name"] is None and r["find_url"] == "https://www.google.com/search?q=site%3Awalmart.com%20010900577779"
    ann.patch("/api/me/settings", json={"serper_key": " abc123 "}, headers=H)
    assert ann.get("/api/data").get_json()["user"]["settings"]["serper_key_set"] is True
    assert "abc123" not in ann.get("/api/data").get_data(as_text=True)
    r = ann.get("/api/codes/010900577779").get_json()
    assert (r["name"], r["brand"], r["size"], r["url"]) == (
        "Slow cooker liners", "Reynolds Kitchens", "6 Count", "https://www.walmart.com/ip/Reynolds-Slow-Cooker-Liners/10294030")
    assert r["found_by"][0] == "Walmart" and r["warning"] is None and r["image"]
    # Saving it with the lookup's picture: fetched then, and kept as the product's.
    p = ann.post("/api/products", json={"name": r["name"], "codes": ["010900577779"], "image_lookup": r["image"]},
                 headers=H).get_json()
    assert ann.get(p["image"]).get_data() == b"\xff\xd8jpeg"
    assert asked.count("https://i5.walmartimages.com/seo/liners.jpeg") == 1
    # A token that isn't one is ignored (the browser can't name a picture to fetch).
    q = ann.post("/api/products", json={"name": "Other", "image_lookup": "https://evil.example/x"}, headers=H).get_json()
    assert q["image"] is None
    # Another barcode's page: said so.
    assert ann.get("/api/codes/012345678905").get_json()["warning"]


def test_a_pasted_link(pantry, monkeypatch):
    ann, inv = pantry
    asked = fake_web(monkeypatch, {"https://www.walmart.com/ip/": (WALMART_PAGE, "text/html")})
    r = ann.post("/api/codes/from-link", json={"url": "https://www.walmart.com/ip/Reynolds/10294030?from=share",
                                               "code": "010900577779"}, headers=H).get_json()
    assert r["name"] == "Slow cooker liners" and asked[0] == "https://www.walmart.com/ip/Reynolds/10294030"
    # Other shops' links are kept as the link, not read.
    r = ann.post("/api/codes/from-link", json={"url": "https://www.target.com/p/liners/-/A-1"}, headers=H).get_json()
    assert r["url"] == "https://www.target.com/p/liners/-/A-1" and len(asked) == 1
    # Walmart turning it away is "not found", not an error.
    fake_web(monkeypatch, {"https://www.walmart.com/ip/": ("<title>Robot or human?</title>", "text/html")})
    assert ann.post("/api/codes/from-link", json={"url": "https://www.walmart.com/ip/x/1"}, headers=H).get_json()["name"] is None


def test_looking_up_in_the_free_databases(pantry, monkeypatch):
    """Open Food Facts first; UPCitemdb (ALL CAPS, as it often is) for what's missing."""
    ann, inv = pantry
    fake_web(monkeypatch, {
        "https://world.openfoodfacts.org/": (json_text({"product": {"brands": "CAMPBELL'S, Campbell Soup Co",
                                                                    "quantity": "10.75 oz"}}), "application/json"),
        "https://api.upcitemdb.com/": (json_text({"items": [{"title": "CAMPBELL'S SOUP CREAM MUSHROOM", "brand": "Campbell's",
                                                              "images": ["http://x/1.jpg", "https://a.com/2.jpg",
                                                                         "https://i5.walmartimages.com/3.jpg"]}]}), "application/json"),
    })
    r = ann.get("/api/codes/0051000012616").get_json()
    assert (r["name"], r["brand"], r["size"], r["picture"]) == (
        "Soup cream mushroom", "Campbell's", "10.75 oz", "https://i5.walmartimages.com/3.jpg")
    assert r["found_by"] == ["Open Food Facts", "UPCitemdb"]
    ann.patch("/api/me/settings", json={"look_up_codes": False}, headers=H)
    assert ann.get("/api/codes/0051000012616").get_json()["name"] is None


def test_tidying_names():
    from conftest import entropicide as e
    assert e.sentence_case("CAMPBELL'S SOUP CREAM MUSHROOM") == "Campbell's soup cream mushroom"
    assert e.sentence_case("Cream of Mushroom Soup") == "Cream of Mushroom Soup"
    assert e.brand_case("CAMPBELL'S") == "Campbell's" and e.brand_case("iPhone") == "iPhone"
    assert e.split_title("Benadryl Itch Stick, Rashes, .47 ounces HSA/FSA Eligible - Walmart.com", "Benadryl") == (
        "Itch Stick", ".47 ounces")
    # The brand comes out of the name wherever it is, however it's written.
    for name, brand, left in [("Campbells Tomato Soup", "Campbell's", "Tomato Soup"),
                              ("Tomato Soup by Campbell's", "Campbell's", "Tomato Soup"),
                              ("Kraft® Macaroni & Cheese", "Kraft", "Macaroni & Cheese"),
                              ("Stuffing Mix - Stove Top", "Stove Top", "Stuffing Mix"),
                              ("Krusteaz Wild Blueberry Muffin Mix", "KRUSTEAZ", "Wild Blueberry Muffin Mix"),
                              ("Krafty Glue", "Kraft", "Krafty Glue"),  # (only the brand as a word)
                              ("Kraft", "Kraft", "Kraft")]:                # (nothing else to call it)
        assert e.without_brand(name, brand) == left


def test_old_items_become_products(tmp_path):
    """A database from before products: each item gets one, with its barcodes and picture."""
    import sqlite3
    import db
    path = str(tmp_path / "old.db")
    db.init_db(path)
    conn = sqlite3.connect(path)
    conn.executescript("""
        INSERT INTO users (id, username, password_hash) VALUES (1, 'ann', 'x');
        INSERT INTO inventories (id, user_id, name) VALUES (1, 1, 'Pantry'), (2, 1, 'Cabin');
        INSERT INTO documents (id, user_id, kind, title) VALUES (10, 1, 'item', 'Rice'), (11, 1, 'item', 'Rice'),
            (12, 1, 'item', 'Beans');
        INSERT INTO item_data (id, inventory_id, unit, brand, quantity) VALUES (10, 1, 'bags', 'Uncle Ben''s', 3),
            (11, 2, 'bags', '', 1), (12, 2, '', '', 2);
        CREATE TABLE item_codes (inventory_id INTEGER, code TEXT, item_id INTEGER, PRIMARY KEY (inventory_id, code));
        INSERT INTO item_codes VALUES (1, '111', 10), (2, '111', 11), (2, '222', 12), (1, '333', 10);
        INSERT INTO blobs (id, sha256, size, data) VALUES (5, 'abc', 3, x'616263');
        INSERT INTO attachments (user_id, document_id, name, mime, size, blob_id) VALUES (1, 10, 'rice.jpg', 'image/jpeg', 3, 5);
    """)
    conn.commit()
    conn.close()
    db.init_db(path)
    conn = sqlite3.connect(path)
    assert conn.execute("SELECT name, brand, unit, image_blob_id FROM products ORDER BY id").fetchall() == [
        ("Rice", "Uncle Ben's", "bags", 5), ("Beans", "", "", None)]
    assert conn.execute("SELECT id, product_id FROM item_data ORDER BY id").fetchall() == [(10, 1), (11, 1), (12, 2)]
    assert conn.execute("SELECT code, product_id FROM product_codes ORDER BY code").fetchall() == [
        ("111", 1), ("222", 2), ("333", 1)]
    assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'item_codes'").fetchone()
    # The picture's bytes stay while the product has them, though the attachment goes.
    conn.execute("DELETE FROM attachments")
    assert conn.execute("SELECT COUNT(*) FROM blobs").fetchone()[0] == 1


def json_text(x):
    import json
    return json.dumps(x)


def test_testing_a_serper_key(pantry, monkeypatch):
    """Settings' Test the key: one search, and a plain answer."""
    import urllib.error
    from conftest import entropicide
    ann, _ = pantry
    assert ann.post("/api/me/serper-test", headers=H).get_json()["ok"] is False  # (none saved)
    ann.patch("/api/me/settings", json={"serper_key": "good"}, headers=H)
    answers = {"good": (json_text({"organic": [{"link": "https://www.walmart.com/ip/Soup/123"}]}).encode(), "application/json", "")}

    def fetch(url, data=None, headers=None, **_):
        if headers["X-API-KEY"] not in answers:
            raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)
        return answers[headers["X-API-KEY"]]
    monkeypatch.setattr(entropicide, "fetch_url", fetch)
    r = ann.post("/api/me/serper-test", headers=H).get_json()
    assert r["ok"] and "It works" in r["message"]
    ann.patch("/api/me/settings", json={"serper_key": "bad"}, headers=H)
    r = ann.post("/api/me/serper-test", headers=H).get_json()
    assert not r["ok"] and "didn't accept" in r["message"]


def test_a_brand_you_have_is_found_in_a_name(pantry, monkeypatch):
    """A lookup with no brand: one of your products' brands, in its name, is taken as its brand."""
    ann, _ = pantry
    ann.post("/api/products", json={"name": "Turkey Stuffing", "brand": "Stove Top"}, headers=H)
    fake_web(monkeypatch, {"https://world.openfoodfacts.org/": (json_text({"product": {"product_name": "STOVE TOP CHICKEN STUFFING"}}),
                                                                "application/json")})
    r = ann.get("/api/codes/0043000287091").get_json()
    assert (r["name"], r["brand"]) == ("Chicken stuffing", "Stove Top")


def test_a_product_needs_no_link(pantry):
    """Leaving a product's link blank is fine (and clearing one)."""
    ann, inv = pantry
    r = ann.post("/api/products", json={"name": "Home-canned peaches", "url": "", "category": "Fruit"}, headers=H)
    assert r.status_code == 201 and r.get_json()["url"] is None
    pid = r.get_json()["id"]
    assert ann.patch(f"/api/products/{pid}", json={"url": "walmart.com/ip/1"}, headers=H).get_json()["url"] == "https://walmart.com/ip/1"
    assert ann.patch(f"/api/products/{pid}", json={"url": ""}, headers=H).get_json()["url"] is None
    assert ann.patch(f"/api/products/{pid}", json={"url": "not a link"}, headers=H).status_code == 400


def test_other_kinds_of_barcode(pantry):
    """Not only UPCs: a Code 39 part number, or a long QR code's text, is a barcode too."""
    ann, inv = pantry
    qr = "https://example.com/manual/drill-model-DCD771C2-serial-" + "0123456789" * 8
    for code, name in (("TOOL-0042", "Shovel, round"), (qr, "Drill")):
        r = count(ann, inv, code=code, delta=1, name=name).get_json()
        assert r["made"] and r["item"]["codes"] == [code]
        assert count(ann, inv, code=code, delta=1).get_json()["after"] == 2


def test_moving_and_trashing_several(app, pantry):
    """The Inventory page's chosen things, moved or put in the trash together (all or none)."""
    ann, inv = pantry
    shelf = ann.post("/api/locations", json={"inventory_id": inv, "name": "Shelf 1"}, headers=H).get_json()["id"]
    ids = [ann.post("/api/items", json={"name": n, "inventory_id": inv}, headers=H).get_json()["id"] for n in ("Rice", "Beans", "Oats")]
    bulk = lambda changes, which=ids[:2]: ann.post("/api/items/bulk", json={"ids": which, "changes": changes}, headers=H)  # noqa: E731
    assert bulk({"location_id": shelf}).status_code == 200
    assert {n: i["location_id"] for n, i in items(ann).items()} == {"Rice": shelf, "Beans": shelf, "Oats": None}
    # Another inventory's place: nothing moves.
    cabin = ann.post("/api/inventories", json={"name": "Cabin"}, headers=H).get_json()["id"]
    porch = ann.post("/api/locations", json={"inventory_id": cabin, "name": "Porch"}, headers=H).get_json()["id"]
    assert bulk({"location_id": porch}, ids).status_code == 400
    assert items(ann)["Oats"]["location_id"] is None
    assert bulk({"deleted": True}).status_code == 200 and set(items(ann)) == {"Oats"}
    assert bulk({"deleted": False}).status_code == 200 and set(items(ann)) == {"Rice", "Beans", "Oats"}
    assert bulk({"quantity": 5}).status_code == 400  # (only moving and the trash)
