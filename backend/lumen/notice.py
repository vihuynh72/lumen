"""Rule-based parse of a PSPS notice. The router uses it only when the Bedrock parse fails."""

import re
from datetime import datetime

OFFSETS = {"PDT": "-07:00", "PST": "-08:00"}


def _when(text, label):
    m = re.search(rf"^{label}:\s*\w+, (\w+ \d{{1,2}}, \d{{4}}), (\d{{1,2}}:\d{{2}} [AP]M) (PDT|PST)\s*$", text, re.MULTILINE | re.IGNORECASE)
    if not m:
        raise ValueError(f"no '{label}' line")
    local = datetime.strptime(f"{m.group(1)} {m.group(2).upper()}", "%B %d, %Y %I:%M %p")
    return local.isoformat() + OFFSETS[m.group(3).upper()]


def parse_fallback(text):
    """Return the event JSON (event.schema.json) for a notice in the PG&E PSPS layout of data/seed/notice.txt."""
    event_id = re.search(r"^Event ID:\s*(\S+)", text, re.MULTILINE)
    area = re.search(r"^Area:\s*(.+?)\s*$", text, re.MULTILINE)
    if not event_id or not area:
        raise ValueError("no 'Event ID' or 'Area' line")
    head = text[:200].upper()
    notice_type = "cancel" if "CANCEL" in head else "watch" if "WATCH" in head else "warning"
    return {
        "event_id": event_id.group(1),
        "notice_type": notice_type,
        "issued_at": _when(text, "Issued"),
        "start": _when(text, "Estimated power shutoff"),
        "end": _when(text, "Estimated power restoration"),
        "area_name": area.group(1),
        "source_text": text,
    }
