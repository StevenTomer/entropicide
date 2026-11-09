"""Formatted note text: the small set of HTML a note may hold, and nothing else.

A note's body comes from the browser's editor (a contenteditable box: bold, italic,
underline, struck, a font, headings, lists, quotes, links and the note's own pictures),
so it's HTML. Everything outside that set is dropped before it's stored: other tags (their
text is kept, except for scripts and styles), every attribute but the few below, and any
link that isn't to a web page or an email address. static/notes.js cleans the same way
before it saves; this is the copy that counts.
"""
import html
import re
from html.parser import HTMLParser

# Typefaces a note (or a stretch of one) can be in: <font face="serif">, styled in app.css.
FONTS = ("sans", "serif", "mono", "hand", "round", "narrow")
# Sizes words can be (<font size="5">, as the browser's editor writes them; app.css sizes them
# against the text around): small, large, larger, huge. 3, the normal size, isn't kept.
SIZES = ("2", "4", "5", "6")
# How wide a picture placed in a note shows: small, medium, or the width of the note.
IMAGE_SIZES = ("s", "m", "l")
CROP_RE = re.compile(r"^\d{1,4}(,\d{1,4}){3}$")


def image_attrs(get):
    """A placed picture's attributes, from get(name), as they're kept: its file, size, and how
    it was edited. A cropped or turned picture is a copy (data-file) made in the browser from
    the original (data-orig), with the crop (thousandths off the left, top, right and bottom)
    and turn kept so it can be edited again; opacity (a percent) and being behind the text are
    only how it shows."""
    out = f'data-file="{int(get("data-file"))}"'
    if (size := get("data-size")) in IMAGE_SIZES:
        out += f' data-size="{size}"'
    if str(orig := get("data-orig") or "").isdigit():
        out += f' data-orig="{int(orig)}"'
        crop = str(get("data-crop") or "")
        if CROP_RE.match(crop) and all(int(x) <= 1000 for x in crop.split(",")):
            out += f' data-crop="{",".join(str(int(x)) for x in crop.split(","))}"'
        if (turn := get("data-rotate")) in ("90", "180", "270"):
            out += f' data-rotate="{turn}"'
    if str(opacity := get("data-opacity") or "").isdigit() and 5 <= int(opacity) < 100:
        out += f' data-opacity="{int(opacity)}"'
    if get("data-behind") == "1":
        out += ' data-behind="1"'
    return out

BLOCKS = {"p", "div", "h1", "h2", "h3", "blockquote", "ul", "ol", "li", "pre"}
INLINE = {"b", "strong", "i", "em", "u", "s", "strike", "del", "code", "span", "font", "a", "sub", "sup"}
EMPTY = {"br", "hr", "img"}
# Dropped along with everything inside them.
SKIP = {"script", "style", "template", "head", "title", "iframe", "object", "embed", "svg", "math",
        "noscript", "select", "textarea", "button"}
# What other editors (and pasted pages) use for the same thing.
RENAME = {"h4": "h3", "h5": "h3", "h6": "h3", "section": "div", "article": "div", "header": "div",
          "footer": "div", "main": "div", "figure": "div", "figcaption": "div", "dl": "div", "dt": "div",
          "dd": "div", "tr": "div", "td": "span", "th": "span", "table": "div", "tbody": "div",
          "thead": "div", "ins": "u", "mark": "span", "small": "span", "big": "span", "label": "span"}

URL_RE = re.compile(r"^(https?://|mailto:)[^\s\"'<>]+$", re.IGNORECASE)
MAX_LENGTH = 400_000


def _style_tags(style):
    """Bold, italic, underline, strike and a font, from an inline style (Chrome's editor and
    pasted pages sometimes use those instead of tags), as the tags to wrap in."""
    style = (style or "").lower()
    out = []
    if re.search(r"font-weight\s*:\s*(bold|[6-9]00)", style):
        out.append(("b", ""))
    if re.search(r"font-style\s*:\s*italic", style):
        out.append(("i", ""))
    if re.search(r"text-decoration[^;]*underline", style):
        out.append(("u", ""))
    if re.search(r"text-decoration[^;]*line-through", style):
        out.append(("s", ""))
    if (m := re.search(r"font-family\s*:\s*([^;]+)", style)) and (face := font_from_family(m[1])):
        out.append(("font", f' face="{face}"'))
    return out


def font_from_family(family):
    """One of FONTS for a CSS font-family list, if it's clearly one of them."""
    family = family.lower()
    if "monospace" in family or "courier" in family or "mono" in family:
        return "mono"
    if "cursive" in family or "comic" in family or "hand" in family or "script" in family:
        return "hand"
    if "narrow" in family or "condensed" in family:
        return "narrow"
    if "rounded" in family:
        return "round"
    if "serif" in family and "sans" not in family or "georgia" in family or "times" in family:
        return "serif"
    return None


class _Cleaner(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.stack = []  # the tags written for each open element (a list: styles may add several)
        self.skipping = 0

    def handle_starttag(self, tag, attrs):
        tag = RENAME.get(tag, tag)
        if tag in SKIP:
            self.skipping += 1
            return
        if self.skipping:
            return
        attrs = dict(attrs)
        if tag in EMPTY:
            if tag == "br":
                self.out.append("<br>")
            elif tag == "hr":
                self.out.append("<hr>")
            elif tag == "img":
                if str(attrs.get("data-file") or "").isdigit():
                    self.out.append(f"<img {image_attrs(attrs.get)}>")
            return
        written = []
        if tag == "ul" and "data-check" in attrs:
            written.append(("ul", " data-check"))  # a checklist
        elif tag == "li" and attrs.get("data-done") == "1":
            written.append(("li", ' data-done="1"'))  # a ticked checklist item
        elif tag in BLOCKS:
            written.append((tag, ""))
        elif tag == "a":
            href = (attrs.get("href") or "").strip()
            if URL_RE.match(href):
                written.append(("a", f' href="{html.escape(href)}" target="_blank" rel="noopener noreferrer"'))
        elif tag == "font":
            face = attrs.get("face", "")
            face = face if face in FONTS else font_from_family(face)
            size = attrs.get("size") if attrs.get("size") in SIZES else None
            if face or size:
                written.append(("font", (f' face="{face}"' if face else "") + (f' size="{size}"' if size else "")))
        elif tag in INLINE and tag != "span":
            written.append(({"strong": "b", "em": "i", "strike": "s", "del": "s"}.get(tag, tag), ""))
        written += _style_tags(attrs.get("style"))
        for name, extra in written:
            self.out.append(f"<{name}{extra}>")
        self.stack.append((tag, [name for name, _ in written]))

    def handle_startendtag(self, tag, attrs):
        tag = RENAME.get(tag, tag)
        if tag in EMPTY or tag in SKIP:
            if tag not in SKIP:
                self.handle_starttag(tag, attrs)
            return
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = RENAME.get(tag, tag)
        if tag in SKIP:
            self.skipping = max(0, self.skipping - 1)
            return
        if self.skipping or tag in EMPTY:
            return
        # Close back to the matching element (browsers' HTML isn't always tidy).
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                while len(self.stack) > i:
                    _, names = self.stack.pop()
                    self.out.extend(f"</{n}>" for n in reversed(names))
                return

    def handle_data(self, data):
        if not self.skipping:
            self.out.append(html.escape(data, quote=False))

    def result(self):
        while self.stack:
            _, names = self.stack.pop()
            self.out.extend(f"</{n}>" for n in reversed(names))
        return "".join(self.out)


def clean(value):
    """value (HTML from the editor, or anywhere) reduced to what a note may hold."""
    value = str(value or "")
    if len(value) > MAX_LENGTH * 2:
        raise ValueError("That note is too long.")
    parser = _Cleaner()
    parser.feed(value)
    parser.close()
    out = parser.result().replace("<p></p>", "")  # (left by the browser's editor; they show nothing)
    if len(out) > MAX_LENGTH:
        raise ValueError("That note is too long.")
    # An editor left empty still holds a <br> or two.
    return "" if not re.sub(r"<br>|<p>|</p>|<div>|</div>|\s|&nbsp;|\xa0", "", out) else out


CHECK_LINE_RE = re.compile(r"^\s*(?:[-*]\s*)?\[([ xX])\]\s?(.*)$")


def from_text(text):
    """Plain text (a task's notes, something shared) as note HTML: a paragraph per line, with
    web addresses as links, and lines like "[ ] milk" as a checklist."""
    lines = []
    for line in str(text or "").split("\n"):
        check = CHECK_LINE_RE.match(line)
        if check:
            line = check[2]
        parts, at = [], 0
        for m in re.finditer(r"https?://[^\s<>\"]+", line):
            url = m[0].rstrip(".,;:!?)")
            parts.append(html.escape(line[at:m.start()], quote=False))
            parts.append(f'<a href="{html.escape(url)}" target="_blank" rel="noopener noreferrer">'
                         f"{html.escape(url, quote=False)}</a>")
            at = m.start() + len(url)
        parts.append(html.escape(line[at:], quote=False))
        words = "".join(parts)
        if check:
            done = ' data-done="1"' if check[1] != " " else ""
            item = f"<li{done}>{words or '<br>'}</li>"
            if lines and lines[-1].startswith("<ul data-check>"):
                lines[-1] = lines[-1][:-5] + item + "</ul>"
            else:
                lines.append(f"<ul data-check>{item}</ul>")
        else:
            lines.append(f"<p>{words or '<br>'}</p>")
    while lines and lines[-1] == "<p><br></p>":
        lines.pop()
    return "".join(lines)


def image(file_id, size="l"):
    return f'<p><img data-file="{int(file_id)}" data-size="{size}"></p>'


def plain(value):
    """A note's text without its formatting (for the export's CSV, and spoken summaries), with
    checklist items as "[ ] ..." and "[x] ..." lines."""
    value = re.sub(r"<ul data-check>(.*?)</ul>", lambda m: re.sub(
        r"<li( data-done=\"1\")?>", lambda li: "[x] " if li[1] else "[ ] ", m[1]), str(value or ""), flags=re.S)
    value = re.sub(r"<br>|</p>|</div>|</li>|</h[1-3]>|</blockquote>|</pre>", "\n", value)
    return re.sub(r"\n{3,}", "\n\n", html.unescape(re.sub(r"<[^>]+>", "", value))).strip()


# --- task and project notes as they were typed, before they were formatted text ------------
# Until documents, a task's or project's notes were plain text with a little Markdown (the
# browser's notesHtml): **bold**, *italic*, ~~struck~~, `code`, links and [name](url); lines
# that were # headings, - and 1. lists, > quotes, --- rules, ``` code blocks and [ ] checklist
# items. from_markdown turns that into note HTML, once (db.py), and plain() back into text.

_LINK_RE = re.compile(r"\[([^\]\n]+)\]\((https?://[^\s)]+)\)|https?://[^\s<>\"']+|www\.[^\s<>\"']+", re.I)


def _emphasis(text):
    out = html.escape(text, quote=False)
    out = re.sub(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", r"<b>\1</b>", out)
    out = re.sub(r"(^|\W)__(?=\S)(.+?)(?<=\S)__(?!\w)", r"\1<b>\2</b>", out)
    out = re.sub(r"(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])", r"\1<i>\2</i>", out)
    out = re.sub(r"(^|\W)_(?=\S)(.+?)(?<=\S)_(?!\w)", r"\1<i>\2</i>", out)
    return re.sub(r"~~(?=\S)(.+?)(?<=\S)~~", r"<s>\1</s>", out)


def _inline(text):
    out, at = [], 0
    for part_at, part in enumerate(re.split(r"(`[^`\n]+`)", text)):
        if part_at % 2:
            out.append(f"<code>{html.escape(part[1:-1], quote=False)}</code>")
            continue
        at = 0
        for m in _LINK_RE.finditer(part):
            raw, label, url = m[0], m[1], m[2]
            if not url:
                raw = re.sub(r"[.,;:!?'*]+$", "", raw)
                if raw.endswith(")") and "(" not in raw:
                    raw = raw[:-1]
                label, url = raw, ("https://" + raw if raw.lower().startswith("www.") else raw)
            out.append(_emphasis(part[at:m.start()]))
            out.append(f'<a href="{html.escape(url)}" target="_blank" rel="noopener noreferrer">'
                       f"{html.escape(label, quote=False)}</a>")
            at = m.start() + len(raw)
        out.append(_emphasis(part[at:]))
    return "".join(out)


def from_markdown(text):
    """Notes typed with a little Markdown (see above) as note HTML."""
    blocks, code, lists = [], None, None  # lists: (tag, opening, items) being built

    def end_list():
        nonlocal lists
        if lists:
            blocks.append(f"{lists[1]}{''.join(lists[2])}</{lists[0]}>")
            lists = None

    def item(tag, opening, li):
        nonlocal lists
        if not lists or lists[1] != opening:
            end_list()
            lists = (tag, opening, [])
        lists[2].append(li)

    for line in str(text or "").rstrip().split("\n"):
        if re.match(r"^\s*```", line):
            if code is None:
                end_list()
                code = []
            else:
                blocks.append(f"<pre>{html.escape(chr(10).join(code), quote=False)}</pre>")
                code = None
            continue
        if code is not None:
            code.append(line)
            continue
        if m := CHECK_LINE_RE.match(line):
            done = ' data-done="1"' if m[1] != " " else ""
            item("ul", "<ul data-check>", f"<li{done}>{_inline(m[2]) or '<br>'}</li>")
        elif m := re.match(r"^\s*[-*+]\s+(.*)$", line):
            item("ul", "<ul>", f"<li>{_inline(m[1])}</li>")
        elif m := re.match(r"^\s*\d{1,3}[.)]\s+(.*)$", line):
            item("ol", "<ol>", f"<li>{_inline(m[1])}</li>")
        else:
            end_list()
            if m := re.match(r"^(#{1,3})\s+(.*)$", line):
                blocks.append(f"<h{len(m[1])}>{_inline(m[2])}</h{len(m[1])}>")
            elif re.match(r"^\s*([-*_])(\s*\1){2,}\s*$", line):
                blocks.append("<hr>")
            elif m := re.match(r"^>\s?(.*)$", line):
                blocks.append(f"<blockquote>{_inline(m[1]) or '<br>'}</blockquote>")
            else:
                blocks.append(f"<p>{_inline(line) or '<br>'}</p>")
    end_list()
    if code is not None:  # (never closed)
        blocks.append(f"<pre>{html.escape(chr(10).join(code), quote=False)}</pre>")
    return clean("".join(blocks))


def uncheck(value):
    """Formatted text with its checklist items unticked (a repeating task's next copy)."""
    return str(value or "").replace('<li data-done="1">', "<li>")


def take_checklists(value):
    """(the checklist items in formatted text, as [(text, ticked)], and the text without them)."""
    items = []
    def take(m):
        for li in re.finditer(r"<li( data-done=\"1\")?>(.*?)</li>", m[1], re.S):
            words = plain(li[2]).strip()
            if words:
                items.append((words, bool(li[1])))
        return ""
    rest = re.sub(r"<ul data-check>(.*?)</ul>", take, str(value or ""), flags=re.S)
    return items, rest
