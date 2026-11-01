"""Web Push: sending notifications (reminders) to the browsers people turned them on in.

The server signs its messages with a VAPID key pair, made on first use and kept in the data
folder (vapid_private.pem). Browsers are given the public half when they subscribe; if the
key is lost, every device has to turn notifications on again.
"""
import base64
import json
import os
import threading

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

_lock = threading.Lock()
_keys = {}


class Gone(Exception):
    """The subscription no longer exists (the browser unsubscribed or was reset)."""


def vapid(data_dir):
    with _lock:
        if data_dir not in _keys:
            path = os.path.join(data_dir, "vapid_private.pem")
            if not os.path.exists(path):
                v = Vapid()
                v.generate_keys()
                v.save_key(path)
                os.chmod(path, 0o600)
            _keys[data_dir] = Vapid.from_file(path)
        return _keys[data_dir]


def public_key(data_dir):
    """The application server key browsers subscribe with (base64url, as they expect)."""
    raw = vapid(data_dir).public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def send(data_dir, sub, message, contact, ttl=6 * 3600):
    """Send message (a dict, read by static/sw.js) to one subscription row."""
    try:
        webpush({"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                data=json.dumps(message), vapid_private_key=vapid(data_dir),
                vapid_claims={"sub": contact}, ttl=ttl, timeout=10)
    except WebPushException as e:
        if e.response is not None and e.response.status_code in (404, 410):
            raise Gone() from e
        raise
