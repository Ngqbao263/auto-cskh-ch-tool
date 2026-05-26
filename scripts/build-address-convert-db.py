import argparse
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import openpyxl


PREFIXES = (
    "Thành phố",
    "Thị xã",
    "Thị trấn",
    "Phường",
    "Quận",
    "Huyện",
    "Tỉnh",
    "Xã",
)


def strip_accents(value: str) -> str:
    value = unicodedata.normalize("NFD", value)
    value = "".join(ch for ch in value if unicodedata.category(ch) != "Mn")
    return value.replace("đ", "d").replace("Đ", "D")


def clean_text(value) -> str:
    text = "" if value is None else str(value).strip()
    text = re.sub(r"\s*\([^)]*\)\s*", " ", text)
    text = re.sub(r"\s*-\s*", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def clean_lookup_name(value) -> str:
    text = clean_text(value)
    key_text = strip_accents(text).lower()
    for raw_prefix in PREFIXES:
        prefix = strip_accents(raw_prefix).lower()
        if key_text == prefix:
            return ""
        if key_text.startswith(prefix + " "):
            text = text[len(raw_prefix):].strip()
            break

    return re.sub(r"\s+", " ", text).strip()


def lookup_key_part(value) -> str:
    text = strip_accents(clean_lookup_name(value)).lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def lookup_key(province: str, district: str, ward: str) -> str:
    return "|".join([
        lookup_key_part(province),
        lookup_key_part(district),
        lookup_key_part(ward),
    ])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="address-convert.xlsx")
    parser.add_argument("--output", default="data/address-convert-map.json")
    args = parser.parse_args()

    source = Path(args.source)
    output = Path(args.output)
    if not source.exists():
        raise SystemExit(f"Source workbook not found: {source}")

    workbook = openpyxl.load_workbook(source, read_only=True, data_only=True)
    sheet = workbook.worksheets[1]

    records = []
    for row in sheet.iter_rows(min_row=4, values_only=True):
        new_province, new_ward, new_ward_code, old_ward, old_ward_code, note, old_district, old_province = row[:8]
        if not (new_province and new_ward and old_ward and old_district and old_province):
            continue

        record = {
            "oldProvince": clean_lookup_name(old_province),
            "oldDistrict": clean_lookup_name(old_district),
            "oldWard": clean_lookup_name(old_ward),
            "oldWardCode": "" if old_ward_code is None else str(old_ward_code).strip(),
            "newProvince": clean_text(new_province),
            "newWard": clean_text(new_ward),
            "newWardCode": "" if new_ward_code is None else str(new_ward_code).strip(),
            "note": "" if note is None else str(note).strip(),
        }
        record["key"] = lookup_key(record["oldProvince"], record["oldDistrict"], record["oldWard"])
        records.append(record)

    grouped = defaultdict(list)
    for record in records:
        grouped[record["key"]].append(record)

    ambiguous_count = 0
    for items in grouped.values():
        distinct_targets = {(item["newProvince"], item["newWard"]) for item in items}
        if len(distinct_targets) > 1:
            ambiguous_count += 1

    payload = {
        "meta": {
            "source": str(source),
            "sheet": sheet.title,
            "recordCount": len(records),
            "uniqueKeyCount": len(grouped),
            "ambiguousKeyCount": ambiguous_count,
            "notes": dict(Counter(record["note"] for record in records)),
        },
        "records": records,
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload["meta"], ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
