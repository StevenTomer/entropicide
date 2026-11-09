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


def test_a_barcode_means_one_thing(pantry):
    ann, inv = pantry
    count(ann, inv, code="111", delta=1, name="Rice")
    beans = ann.post("/api/items", json={"name": "Beans", "inventory_id": inv}, headers=H).get_json()["id"]
    assert ann.patch(f"/api/items/{beans}", json={"codes": ["111"]}, headers=H).status_code == 400
    # In another inventory, it can mean something else.
    other = ann.post("/api/inventories", json={"name": "Cabin"}, headers=H).get_json()["id"]
    assert count(ann, other, code="111", delta=1, name="Cabin rice").status_code == 201


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
