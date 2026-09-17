# -*- coding: utf-8 -*-
"""
generate_social_captions.py — standalone Social Media tab caption generator.

Picks rows from the 'Social Media' tab (targetUrl + title only, same picking
contract as the Blog Caption pipeline) where FB Post and/or LinkedIn Post is
empty, fetches the live Ken Research report page for facts (this tab has no
Blog Content column to mine, unlike the Blogs tab), generates one caption per
row using the same 5 rotating variants as generate-caption.md, and writes:
  - FB Post column      -> caption with ?utm_source=fb&utm_medium=Referral&utm_campaign=Automation
  - LinkedIn Post column -> caption with ?utm_source=linkedinPost&utm_medium=Referral&utm_campaign=Automation

Both columns get the SAME variant/content, differing only in the embedded UTM link.

Usage:
  python generate_social_captions.py --limit 5          # dry test, no write
  python generate_social_captions.py --limit 5 --write   # generate + write
  python generate_social_captions.py --write             # full batch (all pending rows)
"""
import argparse, json, os, re, sys, time
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from google.oauth2 import service_account
import google.auth.transport.requests as google_requests

sys.path.insert(0, "C:/tmp")
import gen_captions as gc  # reuse variant1..5, build_signals, clean, bold_stats, IMPLICATIONS_*

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

SPREADSHEET_ID = os.environ["SOCIAL_SHEET_ID"]
SA_FILE = os.environ["GOOGLE_SERVICE_ACCOUNT_FILE"]
TAB = "Social Media"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

COL_TARGET_URL = 0
COL_TITLE = 1
COL_FB_POST = 18
COL_LI_POST = 24

UTM_FB = "?utm_source=Facebook&utm_medium=Referral&utm_campaign=Automation"
UTM_LI = "?utm_source=linkedinPost&utm_medium=Referral&utm_campaign=Automation"

GEO_WORDS = gc.GEO_WORDS

def col_letter(idx):
    result = ""
    n = idx + 1
    while n > 0:
        n, rem = divmod(n - 1, 26)
        result = chr(65 + rem) + result
    return result

def get_sheets_service():
    creds = service_account.Credentials.from_service_account_file(SA_FILE, scopes=SCOPES)
    creds.refresh(google_requests.Request())
    return creds.token

def sheets_get(token, rng):
    resp = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/{rng}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("values", [])

def sheets_batch_write(token, data):
    resp = requests.post(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values:batchUpdate",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=json.dumps({"valueInputOption": "RAW", "data": data}),
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()

def strip_tags(node):
    if node is None:
        return ""
    return re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip()

def section_text(soup, heading_text, max_chars=350):
    for h in soup.find_all(["h2", "h3"]):
        if h.get_text(strip=True) == heading_text:
            parts = []
            for sib in h.find_all_next():
                if sib.name in ("h1", "h2", "h3"):
                    break
                if sib.name == "p":
                    t = sib.get_text(" ", strip=True)
                    if t:
                        parts.append(t)
                if sum(len(p) for p in parts) > max_chars:
                    break
            return re.sub(r"\s+", " ", " ".join(parts)).strip()[:max_chars]
    return ""

def derive_country_from_url(url):
    """Ken Research URLs are '{country-slug}-{market-slug}-market', e.g.
    'south-africa-ai-in-facility-management-automation-market' or 'global-smart-fitness-devices-market'.
    Try progressively longer hyphen-joined prefixes against GEO_WORDS (longest match wins,
    so 'south-africa' beats 'south')."""
    path = re.sub(r"^https?://[^/]+/(?:industry-reports/)?", "", url).rstrip("/")
    parts = path.split("-")
    best = None
    for length in range(min(3, len(parts)), 0, -1):
        candidate = "-".join(parts[:length])
        words = candidate.split("-")
        if all(w.lower() in GEO_WORDS for w in words):
            best = " ".join(w.upper() if len(w) <= 3 else w.capitalize() for w in words)
            break
    return best or "Global"

def extract_report_facts(market_name, country, html):
    soup = BeautifulSoup(html, "html.parser")
    h1_text = strip_tags(soup.find("h1"))
    report_name_prefix = re.match(r"^(.*?\bMarket\b)", h1_text)
    page_market_name = report_name_prefix.group(1).strip() if report_name_prefix else ""
    # Page-derived name is fuller (includes country prefix); sheet's own title is often generic.
    final_market_name = page_market_name or market_name

    full_text_early = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))
    h2s = soup.find_all("h2")
    hook = strip_tags(h2s[0]) if h2s else ""
    size_fragment = None
    drivers_text = ""
    # Unit can be spelled out (million/billion/trillion) or abbreviated (Bn/Mn/Tn) —
    # both appear across different report-page template versions.
    UNIT = r"(?:million|billion|trillion|Bn|Mn|Tn)"
    # Matches the number itself directly (with optional thousands commas and decimal
    # point) plus its unit, instead of bounding on the next comma/period in the
    # sentence — those punctuation marks can appear INSIDE the number itself
    # ("USD 6,150 Mn", "USD 1.2 Bn") and truncate it if used as a stop boundary.
    NUMBER_UNIT = rf"USD\s[\d,]+(?:\.\d+)?\s?{UNIT}?"

    m = re.search(
        rf"valued at ({NUMBER_UNIT}).*?(?:growing due to|driven by|due to|grows? with)\s(.+)$",
        hook, re.IGNORECASE,
    )
    if m:
        size_fragment = m.group(1).strip()
        drivers_text = m.group(2).strip().rstrip(".")
    else:
        m2 = re.search(NUMBER_UNIT, hook, re.IGNORECASE)
        if m2:
            size_fragment = m2.group(0)
        else:
            # Older report-page template (e.g. Wayback snapshots, or "CHAPTER 1 - MARKET
            # SUMMARY" style pages) doesn't put the hook sentence in the first h2 —
            # search the whole page text instead.
            m4 = re.search(rf"valued at ({NUMBER_UNIT})", full_text_early, re.IGNORECASE)
            if m4:
                size_fragment = m4.group(1).strip()

    drivers = []
    if drivers_text:
        parts = re.split(r",\s*(?:and\s+)?|\s+and\s+", drivers_text)
        drivers = [p.strip().capitalize() for p in parts if p.strip()][:3]

    prefix = f"{page_market_name} " if page_market_name else ""
    seg_p = section_text(soup, f"{prefix}Segmentation") or section_text(soup, f"{page_market_name} Market Segmentation")
    comp_p = section_text(soup, f"{prefix}Competitive Landscape")
    outlook_p = section_text(soup, f"{prefix}Future Outlook")

    # FAQ answers: Q1 backs up market size, Q2/Q3/Q4 give extra signal material.
    faq_answers = {}
    for h3 in soup.find_all("h3"):
        qt = h3.get_text(strip=True).lower()
        if qt.startswith("what is the current value") or qt.startswith("what is the size"):
            faq_answers["size"] = section_text_from_node(h3)
        elif "driving the growth" in qt or "factors" in qt and "driv" in qt:
            faq_answers["drivers"] = section_text_from_node(h3)
        elif "regions" in qt and ("leading" in qt or "region" in qt):
            faq_answers["regions"] = section_text_from_node(h3)
        elif "product types" in qt or "main product" in qt:
            faq_answers["segments"] = section_text_from_node(h3)
    if not size_fragment and faq_answers.get("size"):
        m3 = re.search(rf"USD\s[\d.,]+\s?{UNIT}", faq_answers["size"], re.IGNORECASE)
        if m3:
            size_fragment = m3.group(0)

    # Base/forecast years — Ken Research report pages consistently list a Table of Contents
    # entry like "Market Size, 2019-2024" and "Future Size, 2025-2030"; the end of each range
    # is the base year / forecast year even when no explicit CAGR is published on the page.
    base_year = None
    forecast_year = None
    full_text = full_text_early
    mby = re.search(r"Market Size,\s*(\d{4})-(\d{4})", full_text)
    if mby:
        base_year = mby.group(2)
    mfy = re.search(r"Future Size,\s*(\d{4})-(\d{4})", full_text)
    if mfy:
        forecast_year = mfy.group(2)
    if not (base_year and forecast_year):
        # Older template: TOC lines like "Market Segmentation by Species, 2024 & 2030F"
        m5 = re.search(r"(\d{4})\s*&\s*(\d{4})F", full_text)
        if m5:
            base_year = base_year or m5.group(1)
            forecast_year = forecast_year or m5.group(2)
    if not forecast_year:
        # H1 pattern: "... Market Outlook to 2029"
        m6 = re.search(r"Outlook to (\d{4})", h1_text, re.IGNORECASE)
        if m6:
            forecast_year = m6.group(1)

    base_year_fact = None
    if size_fragment and base_year:
        base_year_fact = f"{size_fragment} in {base_year}"
        if forecast_year:
            base_year_fact += f", with outlook through {forecast_year}"
    elif size_fragment:
        base_year_fact = size_fragment  # no year found anywhere — omit rather than invent one

    # Player list (Competitive Landscape backbone)
    players = []
    for h2 in h2s:
        if "players mentioned" in h2.get_text(strip=True).lower():
            for sib in h2.find_all_next():
                if sib.name == "h2":
                    break
                if sib.name == "h3":
                    players.append(sib.get_text(strip=True))
                if len(players) >= 6:
                    break
            break

    takeaways = []
    if drivers:
        takeaways.append(f"Growth Drivers: {drivers_text[:1].upper()}{drivers_text[1:]}.")
    if players:
        takeaways.append(f"Key Players: {', '.join(players[:4])} are the leading participants shaping competitive intensity.")
    if faq_answers.get("segments"):
        takeaways.append(f"Segment Mix: {faq_answers['segments']}")
    if faq_answers.get("regions"):
        takeaways.append(f"Regional Split: {faq_answers['regions']}")
    if seg_p:
        takeaways.append(f"Market Segmentation: {seg_p}")

    resolved_country = country or derive_country_from_url_or_name(final_market_name)

    return {
        "market_name": final_market_name,
        "country": resolved_country,
        "base_year_fact": base_year_fact,
        "forecast_fact": None,
        "cagr_fact": None,
        "takeaways": takeaways,
        "drivers": drivers,
        "comp_p": comp_p,
        "analyst_p": outlook_p,
        "outlook_bullets": [outlook_p] if outlook_p else [],
        "risk_p": "",
    }

def derive_country_from_url_or_name(name):
    first = (name or "").split()[0] if name else ""
    if first.lower() in GEO_WORDS:
        return first.upper() if len(first) <= 3 else first.capitalize()
    two = " ".join((name or "").split()[:2]).lower()
    if two in ("south africa", "north america", "saudi arabia"):
        return two.title()
    return "Global"

def section_text_from_node(h, max_chars=300):
    parts = []
    for sib in h.find_all_next():
        if sib.name in ("h1", "h2", "h3"):
            break
        if sib.name == "p":
            t = sib.get_text(" ", strip=True)
            if t:
                parts.append(t)
        if sum(len(p) for p in parts) > max_chars:
            break
    return re.sub(r"\s+", " ", " ".join(parts)).strip()[:max_chars]

def derive_country_from_name(name):
    first = (name or "").split()[0] if name else ""
    return first if first.lower() in GEO_WORDS or first.isupper() else "Global"

def fetch_report_html(url):
    r = requests.get(url, timeout=25, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
    r.raise_for_status()
    return r.text

def fetch_wayback_html(url):
    """When the live Ken Research page 500s (a confirmed site-side bug on their end, not a
    scraping issue), fall back to the Wayback Machine's archived copy of the SAME report page.
    This is still genuine Ken Research report content — just their own historical snapshot —
    never a substitute/fabricated source."""
    avail = requests.get(
        f"http://archive.org/wayback/available?url={url}", timeout=15
    ).json()
    snap = avail.get("archived_snapshots", {}).get("closest", {})
    if not snap.get("available"):
        raise RuntimeError("no wayback snapshot available")
    snap_url = snap["url"]
    r = requests.get(snap_url, timeout=25, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    return r.text

def fetch_report_html_with_fallback(url):
    """Try the live page first; if Ken Research's site errors, try the Wayback Machine archive
    of that exact URL. Only raises if both fail — caller then skips the row (no generic
    fallback caption, per standing instruction: real Ken Research data only, or nothing)."""
    try:
        return fetch_report_html(url), "live"
    except Exception:
        html = fetch_wayback_html(url)  # let this raise if it also fails
        return html, "wayback"

def build_caption(facts, url_with_utm, variant_n):
    cap = gc.VARIANT_FUNCS[variant_n](facts, url_with_utm)
    lo, hi = gc.LEN_RANGES[variant_n]
    cap = gc.enforce_length(cap, lo, hi)
    return gc.clean(cap)

# Fallback template removed per standing instruction: only the 5 real fact-backed variants
# may be posted. If neither the live page nor its Wayback archive yields real data, the row
# is skipped (logged, left blank) — never a generic no-data post.

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--start-row", type=int, default=2, help="sheet row (1-indexed) to start scanning from")
    args = ap.parse_args()

    token = get_sheets_service()
    rows = sheets_get(token, f"'{TAB}'!A2:AQ")
    print(f"Total data rows: {len(rows)}")

    processed = 0
    results = []
    for i, row in enumerate(rows):
        sheet_row = i + 2  # header is row 1
        if sheet_row < args.start_row:
            continue
        target_url = (row[COL_TARGET_URL] if len(row) > COL_TARGET_URL else "").strip()
        title = (row[COL_TITLE] if len(row) > COL_TITLE else "").strip()
        fb_post = (row[COL_FB_POST] if len(row) > COL_FB_POST else "").strip()
        li_post = (row[COL_LI_POST] if len(row) > COL_LI_POST else "").strip()

        if not target_url or not title:
            continue
        need_fb = not fb_post
        need_li = not li_post
        if not (need_fb or need_li):
            continue

        variant_n = ((sheet_row - 1) % 5) + 1
        source = None
        try:
            html, source = fetch_report_html_with_fallback(target_url)
            url_country = derive_country_from_url(target_url)
            facts = extract_report_facts(title, url_country if url_country != "Global" else "", html)
        except Exception as e:
            results.append((sheet_row, variant_n, title, f"SKIPPED live+wayback both failed: {e}"))
            processed += 1
            time.sleep(0.3)
            if args.limit and processed >= args.limit:
                break
            continue

        if not facts.get("base_year_fact"):
            # Page fetched fine but no usable market-size figure could be extracted —
            # still real-data-only policy: skip rather than post without a size fact.
            results.append((sheet_row, variant_n, title, f"SKIPPED no extractable market size ({source})"))
            processed += 1
            time.sleep(0.3)
            if args.limit and processed >= args.limit:
                break
            continue

        data = []
        status_bits = [f"source={source}"]
        if need_fb:
            cap_fb = build_caption(facts, target_url + UTM_FB, variant_n)
            status_bits.append(f"FB={len(cap_fb)}chars")
            if args.write:
                data.append({"range": f"'{TAB}'!{col_letter(COL_FB_POST)}{sheet_row}", "values": [[cap_fb]]})
        if need_li:
            cap_li = build_caption(facts, target_url + UTM_LI, variant_n)
            status_bits.append(f"LI={len(cap_li)}chars")
            if args.write:
                data.append({"range": f"'{TAB}'!{col_letter(COL_LI_POST)}{sheet_row}", "values": [[cap_li]]})

        if args.write and data:
            try:
                sheets_batch_write(token, data)
                status_bits.append("WRITTEN")
            except Exception as e:
                status_bits.append(f"WRITE_ERROR {e}")

        results.append((sheet_row, variant_n, title, " ".join(status_bits)))
        processed += 1
        time.sleep(0.3)
        if args.limit and processed >= args.limit:
            break

    with open("C:/tmp/social_caption_log.txt", "w", encoding="utf-8") as f:
        for r in results:
            f.write(str(r) + "\n")

    ok = sum(1 for r in results if isinstance(r[-1], str) and ("WRITTEN" in r[-1] or (not args.write and "chars" in r[-1])))
    print(f"Processed {processed} rows, {ok} produced captions successfully.")

if __name__ == "__main__":
    main()
