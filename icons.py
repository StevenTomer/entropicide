"""Area icons: cleaning user-supplied SVG, and fetching it safely from a URL.

Icons are only ever displayed through <img>, where browsers don't run scripts,
and served with a CSP that forbids them too. Cleaning here is the third layer.
"""
import ipaddress
import re
import socket
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlsplit

MAX_BYTES = 200_000
SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
ET.register_namespace("", SVG_NS)
ET.register_namespace("xlink", XLINK_NS)

ALLOWED_ELEMENTS = {
    "svg", "g", "defs", "symbol", "use", "title", "desc", "style", "switch",
    "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "marker",
    "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern",
    "text", "tspan", "textPath",
    # filters (not feImage, which can load files)
    "filter", "feGaussianBlur", "feOffset", "feBlend", "feColorMatrix", "feComposite",
    "feFlood", "feMerge", "feMergeNode", "feMorphology", "feComponentTransfer",
    "feFuncR", "feFuncG", "feFuncB", "feFuncA", "feDropShadow",
}
HREF_ATTRS = {"href", f"{{{XLINK_NS}}}href"}
SERVE_HEADERS = {
    "Content-Type": "image/svg+xml",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
}


class IconError(ValueError):
    pass


DOCTYPE_RE = re.compile(r"<!DOCTYPE\b[^\[>]*(?:\[(?P<subset>.*?)\])?\s*>", re.DOTALL | re.IGNORECASE)
# Only plain-text entities: no references inside (so no nested "billion laughs"),
# no parameter (%) or external (SYSTEM/PUBLIC) entities.
SIMPLE_ENTITY_RE = re.compile(r"""<!ENTITY\s+([A-Za-z_][\w.-]*)\s+(["'])([^"'&%<]{0,200})\2\s*>""")


def _drop_doctype(text):
    """Remove a DOCTYPE, substituting its simple entities (as Illustrator writes)."""
    m = DOCTYPE_RE.search(text)
    if not m:
        if re.search(r"<!ENTITY", text, re.IGNORECASE):
            raise IconError("This SVG has entity declarations that aren't allowed.")
        return text
    entities = {}
    leftover = SIMPLE_ENTITY_RE.sub(lambda e: entities.setdefault(e.group(1), e.group(3)) and "", m.group("subset") or "")
    if re.sub(r"<!--.*?-->", "", leftover, flags=re.DOTALL).strip():
        raise IconError("This SVG's DOCTYPE has declarations that aren't allowed.")
    text = text[:m.start()] + text[m.end():]
    for name, value in entities.items():
        text = text.replace(f"&{name};", value)
    if len(text) > 4 * MAX_BYTES:
        raise IconError("That SVG is too big once expanded.")
    return text


def _local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def clean_svg(text):
    """Return a safe copy of an SVG document, or raise IconError."""
    if len(text.encode()) > MAX_BYTES:
        raise IconError("That SVG is too big (200 KB at most).")
    text = _drop_doctype(text)
    try:
        root = ET.fromstring(text.strip())
    except ET.ParseError:
        raise IconError("That isn't a valid SVG file.")
    if root.tag != f"{{{SVG_NS}}}svg":
        raise IconError("That isn't an SVG image.")

    for parent in list(root.iter()):  # snapshot: removing while walking would skip elements
        for child in list(parent):
            if (not isinstance(child.tag, str) or not child.tag.startswith(f"{{{SVG_NS}}}")
                    or _local(child.tag) not in ALLOWED_ELEMENTS):
                parent.remove(child)
    for el in root.iter():
        for name, value in list(el.attrib.items()):
            local = _local(name).lower()
            if (local.startswith("on")
                    or "javascript:" in value.lower().replace(" ", "")
                    or (name in HREF_ATTRS and not value.startswith("#"))
                    or re.search(r"url\(\s*['\"]?(?!#)", value)):
                del el.attrib[name]
        if _local(el.tag) == "style" and el.text:
            # Styles may only point inside the icon itself.
            el.text = re.sub(r"@import[^;]*;?", "", el.text)
            el.text = re.sub(r"url\(\s*['\"]?(?!#)[^)]*\)", "none", el.text)
    return ET.tostring(root, encoding="unicode")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # surface 3xx as HTTPError so each hop's address is checked


def _check_public(host, port):
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise IconError(f"Couldn't find {host}.")
    for *_, sockaddr in infos:
        if not ipaddress.ip_address(sockaddr[0]).is_global:
            # Keeps the server from being pointed at the router, other home machines, or itself.
            raise IconError("Icons can only be downloaded from the public internet.")


def fetch_svg(url):
    """Download an SVG over http(s) from a public address; returns its text."""
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(4):
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise IconError("Give a web address starting with http:// or https://.")
        _check_public(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
        request = urllib.request.Request(url, headers={"User-Agent": "entropicide-icon-fetch/1"})
        try:
            with opener.open(request, timeout=10) as response:
                data = response.read(MAX_BYTES + 1)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                url = urljoin(url, e.headers["Location"])
                continue
            raise IconError(f"The download failed ({e.code}).")
        except (urllib.error.URLError, OSError) as e:
            raise IconError(f"The download failed ({getattr(e, 'reason', e)}).")
        if len(data) > MAX_BYTES:
            raise IconError("That SVG is too big (200 KB at most).")
        return data.decode("utf-8", errors="replace")
    raise IconError("Too many redirects.")
