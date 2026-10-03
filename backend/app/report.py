"""Small, credential-free statistics reports from the persisted account snapshot."""

import csv
from io import BytesIO, StringIO

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.colors import HexColor
from reportlab.pdfgen import canvas

from .legacy_labels import normalize_summary


def report_rows(summary: dict) -> list[tuple[str, str]]:
    summary = normalize_summary(summary)
    def number(key: str) -> str:
        return str(summary.get(key) or 0)

    def gb(key: str) -> str:
        value = summary.get(key)
        return f"{value / 1_000_000_000:.2f} GB" if value is not None else "Unavailable"

    def leader(rows: list[dict]) -> str:
        if not rows:
            return "—"
        name = str(rows[0].get('name') or "Unknown manufacturer")
        return f"{name[:32] + '...' if len(name) > 35 else name} ({rows[0].get('count', 0)})"

    devices = summary.get("devices") or []
    manufacturers = summary.get("manufacturers") or []
    return [
        ("Total assets", number("asset_count")),
        ("Photos", number("photo_count")),
        ("Videos", number("video_count")),
        ("Favorites", number("favorite_count")),
        ("Your albums", number("album_count")),
        ("Assets without album", number("unalbumed_asset_count")),
        ("Total storage", gb("total_bytes")),
        ("Photo storage", gb("photo_bytes")),
        ("Video storage", gb("video_bytes")),
        ("Assets with location", number("geotagged_count")),
        ("Photos with people", number("photos_with_people_count")),
        ("First capture", summary.get("first_date") or "—"),
        ("Last capture", summary.get("last_date") or "—"),
        ("Most frequent device", leader(devices)),
        ("Most frequent manufacturer", leader(manufacturers)),
    ]


def create_report(summary: dict, format: str) -> bytes:
    rows = report_rows(summary)
    if format == "csv":
        stream = StringIO()
        writer = csv.writer(stream)
        writer.writerow(("Statistic", "Value"))
        writer.writerows(rows)
        return ("\ufeff" + stream.getvalue()).encode("utf-8")
    if format == "pdf":
        stream = BytesIO()
        page = canvas.Canvas(stream, pagesize=(595, 842))
        page.setTitle("Immich Insights – Library")
        page.setFillColor(HexColor("#143e2a"))
        page.rect(0, 735, 595, 107, fill=1, stroke=0)
        page.setFillColor(HexColor("#ffffff"))
        page.setFont("Helvetica-Bold", 24)
        page.drawString(42, 788, "Immich Insights")
        page.setFont("Helvetica", 12)
        page.drawString(42, 760, "Your library in numbers")
        # Card-like report layout. A server-side PDF cannot copy live browser DOM
        # cards, but it can present the same cached values as independent tiles.
        for index, (label, value) in enumerate(rows):
            column, row = index % 2, index // 2
            x, y = 36 + column * 264, 690 - row * 77
            page.setFillColor(HexColor("#f1f6ef"))
            page.setStrokeColor(HexColor("#dce8da"))
            page.roundRect(x, y - 27, 253, 66, 11, fill=1, stroke=1)
            page.setFillColor(HexColor("#53675a"))
            page.setFont("Helvetica", 9)
            page.drawString(x + 13, y + 19, label[:41])
            page.setFillColor(HexColor("#174b32"))
            page.setFont("Helvetica-Bold", 14)
            page.drawString(x + 13, y - 6, value[:31])
        page.setFillColor(HexColor("#56675b"))
        page.setFont("Helvetica", 9)
        page.drawString(42, 53, "Personal statistics report · No API keys or original images included")
        page.showPage()
        page.save()
        return stream.getvalue()
    if format == "jpg":
        def image_text(value: str) -> str:
            return value.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("Ä", "Ae").replace("Ö", "Oe").replace("Ü", "Ue").replace("ß", "ss").replace("—", "-").replace("·", "-")

        image_height = max(1280, 290 + len(rows) * 75 + 75)
        image = Image.new("RGB", (1200, image_height), "#f6f8f3")
        draw = ImageDraw.Draw(image)
        font = ImageFont.load_default(size=25)
        title = ImageFont.load_default(size=55)
        draw.rectangle((0, 0, 1200, 180), fill="#143e2a")
        draw.text((60, 48), "Immich Insights", fill="white", font=title)
        draw.text((60, 121), "Your library in numbers", fill="#dcebdc", font=font)
        for index, (label, value) in enumerate(rows):
            y = 210 + index * 75
            if index % 2:
                draw.rounded_rectangle((40, y - 8, 1160, y + 62), radius=10, fill="#e9efe7")
            draw.text((65, y + 11), image_text(label), fill="#253329", font=font)
            readable = image_text(value)
            value_width = draw.textlength(readable, font=font)
            draw.text((1125 - value_width, y + 11), readable, fill="#143e2a", font=font)
        draw.text((60, image_height - 60), "Personal report - no API keys or original images", fill="#56675b", font=font)
        stream = BytesIO()
        image.save(stream, format="JPEG", quality=88, optimize=True)
        return stream.getvalue()
    raise ValueError("Unknown export format")
