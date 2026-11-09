"""Groups: making one, inviting people, roles, leaving; and who may see and change a shared document."""
import pytest
from flask import g

from conftest import H, entropicide, rows


@pytest.fixture
def family(user_client):
    """Ann's group, Family, with Bob in it as an editor and Cat as a viewer; Dan is outside it."""
    ann, bob, cat, dan = (user_client(n) for n in ("ann", "bob", "cat", "dan"))
    gid = ann.post("/api/groups", json={"name": "Family"}, headers=H).get_json()["groups"][0]["id"]
    for who, role in (("bob", "editor"), ("cat", "viewer")):
        ann.post(f"/api/groups/{gid}/invites", json={"username": who, "role": role}, headers=H)
    for client in (bob, cat):
        invite = client.get("/api/groups").get_json()["invites"][0]
        client.post(f"/api/invites/{invite['id']}/accept", headers=H)
    return gid, ann, bob, cat, dan


def test_making_a_group_and_inviting(app, user_client, monkeypatch):
    sent = []
    monkeypatch.setattr(entropicide, "notify", lambda uid, message: sent.append(message["title"]) or 1)
    ann, bob = user_client("ann"), user_client("bob")
    gid = ann.post("/api/groups", json={"name": "Family"}, headers=H).get_json()["groups"][0]["id"]
    assert ann.post("/api/groups", json={"name": " "}, headers=H).status_code == 400
    assert ann.post(f"/api/groups/{gid}/invites", json={"username": "nobody"}, headers=H).status_code == 400
    assert ann.post(f"/api/groups/{gid}/invites", json={"username": "ann"}, headers=H).status_code == 400
    r = ann.post(f"/api/groups/{gid}/invites", json={"username": "BOB"}, headers=H).get_json()
    assert [i["username"] for i in r["groups"][0]["invites"]] == ["bob"]
    assert sent == ["Ann invited you to Family"]
    # Bob sees the invitation (with who sent it), and the group only once he's accepted.
    mine = bob.get("/api/groups").get_json()
    assert mine["groups"] == [] and (mine["invites"][0]["group_name"], mine["invites"][0]["from"], mine["invites"][0]["role"]) == \
        ("Family", "Ann", "editor")
    groups = bob.post(f"/api/invites/{mine['invites'][0]['id']}/accept", headers=H).get_json()
    assert (groups["groups"][0]["my_role"], groups["invites"]) == ("editor", [])
    assert [(m["username"], m["role"]) for m in groups["groups"][0]["members"]] == [("ann", "owner"), ("bob", "editor")]
    assert groups["groups"][0]["invites"] == []  # (only owners see invitations out)
    # Declining.
    user_client("cat")
    ann.post(f"/api/groups/{gid}/invites", json={"username": "cat", "role": "viewer"}, headers=H)
    cat = app.test_client()
    from conftest import sign_in
    sign_in(cat, "cat")
    invite = cat.get("/api/groups").get_json()["invites"][0]
    assert cat.post(f"/api/invites/{invite['id']}/decline", headers=H).get_json()["groups"] == []
    assert bob.post(f"/api/invites/{invite['id']}/accept", headers=H).status_code == 404  # (not Bob's)


def test_only_owners_manage_a_group(family):
    gid, ann, bob, cat, dan = family
    assert bob.patch(f"/api/groups/{gid}", json={"name": "Ours"}, headers=H).status_code == 403
    assert bob.post(f"/api/groups/{gid}/invites", json={"username": "dan"}, headers=H).status_code == 403
    assert dan.patch(f"/api/groups/{gid}", json={"name": "Mine"}, headers=H).status_code == 404
    assert dan.delete(f"/api/groups/{gid}/members/{2}", headers=H).status_code == 404
    r = ann.patch(f"/api/groups/{gid}", json={"name": "The Family", "default_role": "viewer", "viewers_complete": False},
                  headers=H).get_json()["groups"][0]
    assert (r["name"], r["default_role"], r["viewers_complete"]) == ("The Family", "viewer", False)
    assert ann.patch(f"/api/groups/{gid}", json={"default_role": "owner"}, headers=H).status_code == 400
    # An invitation without a role takes the group's default.
    r = ann.post(f"/api/groups/{gid}/invites", json={"username": "dan"}, headers=H).get_json()["groups"][0]
    assert r["invites"][0]["role"] == "viewer"


def test_roles_leaving_and_the_last_owner(app, family):
    gid, ann, bob, cat, dan = family
    ids = {m["username"]: m["user_id"] for m in ann.get("/api/groups").get_json()["groups"][0]["members"]}
    # The only owner can't stop being one, or leave, until someone else is.
    assert ann.patch(f"/api/groups/{gid}/members/{ids['ann']}", json={"role": "editor"}, headers=H).status_code == 400
    assert ann.delete(f"/api/groups/{gid}/members/{ids['ann']}", headers=H).status_code == 400
    ann.patch(f"/api/groups/{gid}/members/{ids['bob']}", json={"role": "owner"}, headers=H)
    assert ann.delete(f"/api/groups/{gid}/members/{ids['ann']}", headers=H).get_json()["groups"] == []
    # Bob (an owner now) takes Cat out; Cat can't come back without a new invitation.
    bob.delete(f"/api/groups/{gid}/members/{ids['cat']}", headers=H)
    assert cat.get("/api/groups").get_json()["groups"] == []
    # The last one out ends the group.
    bob.delete(f"/api/groups/{gid}/members/{ids['bob']}", headers=H)
    assert rows(app, "SELECT COUNT(*) AS n FROM user_groups") == [{"n": 0}]


def test_deleting_a_user_keeps_their_groups_owned(app, user_client, family):
    gid, ann, bob, cat, dan = family
    admin = user_client("root", admin=True)
    ann_id = rows(app, "SELECT id FROM users WHERE username = 'ann'")[0]["id"]
    assert admin.delete(f"/api/admin/users/{ann_id}", headers=H).status_code == 204
    assert [(m["username"], m["role"]) for m in bob.get("/api/groups").get_json()["groups"][0]["members"]] == \
        [("bob", "owner"), ("cat", "viewer")]


def test_who_may_see_and_change_a_shared_document(app, family):
    """The helpers the sharing to come is built on: a document given to the group is seen by
    its members (and only them), changed by owners and editors, and only looked at by viewers."""
    gid, ann, bob, cat, dan = family
    task = ann.post("/api/tasks", json={"title": "Buy milk", "state": "next"}, headers=H).get_json()["id"]
    people = {r["username"]: r["id"] for r in rows(app, "SELECT id, username FROM users")}

    def check(who, shared):
        with app.test_request_context():
            g.user = {"id": people[who]}
            entropicide.db.get_db().execute("UPDATE documents SET group_id = ? WHERE id = ?", (gid if shared else None, task))
            try:
                row = entropicide.can_see("tasks", task)
            except Exception as e:
                return getattr(e, "code", e)
            return "changes" if entropicide.may_change(row) else "sees"
    assert [check(w, False) for w in ("ann", "bob", "cat", "dan")] == ["changes", 404, 404, 404]
    assert [check(w, True) for w in ("ann", "bob", "cat", "dan")] == ["changes", "changes", "sees", 404]
