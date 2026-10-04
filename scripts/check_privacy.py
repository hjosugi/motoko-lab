#!/usr/bin/env python3
"""Check that every on-chain field is classified, and that the classes hold.

docs/32_PRIVACY_AND_DATA_PROTECTION.md is only as good as its coverage: a
field added to a Candid record and left out of the classification is a field
nobody decided about. This script parses every committed `.did`, expands the
named and inline records and variant payloads, and requires each unique field
name to have an entry in `privacy/fields.json`.

The rules the inventory must satisfy:

    * no field may be classified `raw-personal`: the schemas must not require
      a raw prompt, email, IP or private source on chain;
    * a `hashed` field must say whether its preimage is high-entropy,
      user-controlled or low-entropy, and a low-entropy preimage needs a
      documented mitigation (salt, encryption, off-chain custody);
    * a `user-content` field must name the publication warnings that apply to
      it, and every warning id must exist in `privacy/warnings.json`;
    * a `sealed` field must name the custodian process that keeps the pointer
      off chain.

Usage:
    scripts/check_privacy.py .
    scripts/check_privacy.py . --self-test
    scripts/check_privacy.py . --print-fields
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ALLOWED_CLASSES = {"public", "user-content", "hashed", "sealed", "metadata"}
FORBIDDEN_CLASSES = {"raw-personal", "personal", "raw"}
ENTROPY = {"high", "user-controlled", "low"}

IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
PUNCT = set("{}:;(),")


@dataclass
class Field:
    path: str
    name: str
    type_text: str


def tokenize(text: str) -> list[str]:
    text = re.sub(r"//[^\n]*", "", text)
    tokens: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char.isspace():
            index += 1
        elif char in PUNCT:
            tokens.append(char)
            index += 1
        else:
            match = IDENT.match(text, index)
            if match:
                tokens.append(match.group(0))
                index = match.end()
            else:
                tokens.append(char)
                index += 1
    return tokens


class Parser:
    def __init__(self, tokens: list[str]):
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> str | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def take(self) -> str:
        token = self.tokens[self.pos]
        self.pos += 1
        return token

    def expect(self, token: str) -> None:
        actual = self.take()
        if actual != token:
            raise ValueError(f"expected {token!r}, got {actual!r}")

    def skip_balanced(self) -> None:
        """Skips a `{...}` or `(...)` group, consuming both ends."""
        opening = self.take()
        closing = {"{": "}", "(": ")"}[opening]
        depth = 1
        while depth and self.pos < len(self.tokens):
            token = self.take()
            if token == opening:
                depth += 1
            elif token == closing:
                depth -= 1

    def field_name(self) -> str:
        token = self.take()
        if token == '"':
            name = self.take()
            self.expect('"')
            return name
        return token

    def type_text(self) -> str:
        """Consumes one type expression and returns it as text."""
        out: list[str] = []
        while True:
            token = self.peek()
            if token is None:
                break
            if token in {",", ";", "}"}:
                break
            if token in {"{", "("}:
                # Inline record/variant/tuple: keep its text, recurse for fields.
                start = self.pos
                self.skip_balanced()
                out.append(" ".join(self.tokens[start:self.pos]))
                continue
            out.append(self.take())
            # `opt`, `vec` and the inline `record` / `variant` keywords continue
            # the type; a bare named type is complete after one identifier.
            if out[-1] in {"opt", "vec", "record", "variant"}:
                continue
            if len(out) == 1 and IDENT.fullmatch(out[0]):
                break
        return " ".join(out)

    def record_fields(self, prefix: str, out: list[Field]) -> None:
        self.expect("{")
        while self.peek() != "}":
            name = self.field_name()
            if self.peek() == ":":
                self.take()
                type_text = self.type_text()
                out.append(Field(path=f"{prefix}.{name}" if prefix else name, name=name, type_text=type_text))
                # Recurse into an inline record payload, if the type is one.
                if "record" in type_text.split() or "variant" in type_text.split():
                    self.recurse_inline(f"{prefix}.{name}" if prefix else name, type_text, out)
            else:
                # A variant tag with no payload.
                out.append(Field(path=f"{prefix}.{name}" if prefix else name, name=name, type_text=""))
            if self.peek() == ";":
                self.take()
        self.expect("}")

    def recurse_inline(self, prefix: str, type_text: str, out: list[Field]) -> None:
        """Parses the `record { ... }` or `variant { ... }` inside `type_text`."""
        tokens = tokenize(type_text)
        inner = Parser(tokens)
        while inner.peek() is not None:
            token = inner.take()
            if token in {"record", "variant"} and inner.peek() == "{":
                if token == "record":
                    inner.record_fields(prefix, out)
                else:
                    inner.variant_fields(prefix, out)

    def variant_fields(self, prefix: str, out: list[Field]) -> None:
        """Variant tags carry no data of their own; only inline record payloads
        have fields, and those are collected under the tag's path."""
        self.expect("{")
        while self.peek() != "}":
            name = self.field_name()
            if self.peek() == ":":
                self.take()
                type_text = self.type_text()
                if "record" in type_text.split():
                    self.recurse_inline(f"{prefix}.{name}" if prefix else name, type_text, out)
            if self.peek() == ";":
                self.take()
        self.expect("}")


def fields_in_did(text: str) -> list[Field]:
    tokens = tokenize(text)
    parser = Parser(tokens)
    out: list[Field] = []
    while parser.peek() is not None:
        token = parser.take()
        if token != "type":
            continue
        name = parser.take()
        parser.expect("=")
        if parser.peek() == "record":
            parser.take()
            parser.record_fields(name, out)
        elif parser.peek() == "variant":
            parser.take()
            parser.variant_fields(name, out)
        # Aliases and services contribute no fields of their own.
        while parser.peek() not in {None, ";"}:
            parser.take()
        if parser.peek() == ";":
            parser.take()
    return out


def did_files(root: Path) -> list[Path]:
    return sorted(set(root.glob("apps/*/backend/candid/*.did")) | set(root.glob("apps/*/*/candid/*.did")))


def collect_fields(root: Path) -> dict[str, set[str]]:
    """Unique field name -> the paths it appears at."""
    fields: dict[str, set[str]] = {}
    for did in did_files(root):
        app = did.relative_to(root).parts[1]
        for entry in fields_in_did(did.read_text(encoding="utf-8")):
            fields.setdefault(entry.name, set()).add(f"{app}:{entry.path}")
    return fields


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def check_inventory(root: Path) -> list[str]:
    errors: list[str] = []
    inventory = load_json(root / "privacy" / "fields.json")
    warnings = {warning["id"] for warning in load_json(root / "privacy" / "warnings.json")["warnings"]}
    entries = inventory.get("fields", {})
    present = collect_fields(root)

    missing = sorted(set(present) - set(entries))
    if missing:
        errors.append(f"fields missing from the classification: {', '.join(missing)}")
    extra = sorted(set(entries) - set(present))
    if extra:
        errors.append(f"classified fields that no longer exist: {', '.join(extra)}")

    for name, entry in sorted(entries.items()):
        classification = entry.get("class")
        if classification in FORBIDDEN_CLASSES:
            errors.append(f"{name}: class {classification!r} is forbidden; nothing may require raw personal data on chain")
            continue
        if classification not in ALLOWED_CLASSES:
            errors.append(f"{name}: unknown class {classification!r}")
            continue
        if not entry.get("note"):
            errors.append(f"{name}: every classification needs a note explaining why")
        if classification == "hashed":
            entropy = entry.get("preimageEntropy")
            if entropy not in ENTROPY:
                errors.append(f"{name}: a hashed field must name preimageEntropy (high, user-controlled or low)")
            if entropy == "low" and not entry.get("mitigation"):
                errors.append(f"{name}: a low-entropy preimage needs a documented mitigation")
        if classification == "user-content":
            applied = entry.get("warnings") or []
            if not applied:
                errors.append(f"{name}: user content must name the publication warnings that apply")
            for warning in applied:
                if warning not in warnings:
                    errors.append(f"{name}: warning {warning!r} is not in privacy/warnings.json")
        if classification == "sealed" and not entry.get("custodianProcess"):
            errors.append(f"{name}: a sealed field must name the custodian process")
    return errors


def self_test(root: Path) -> int:
    inventory = load_json(root / "privacy" / "fields.json")
    base = check_inventory(root)
    if base:
        print("self-test cannot run: the real inventory already fails", file=sys.stderr)
        for error in base:
            print(f"  {error}", file=sys.stderr)
        return 1

    def mutated(change):
        import copy

        candidate = copy.deepcopy(inventory)
        change(candidate)
        path = root / "privacy" / "fields.json"
        original = path.read_text(encoding="utf-8")
        try:
            path.write_text(json.dumps(candidate, indent=2) + "\n", encoding="utf-8")
            return check_inventory(root)
        finally:
            path.write_text(original, encoding="utf-8")

    cases = [
        ("an unclassified field is caught", lambda data: data["fields"].pop("owner")),
        ("a raw-personal class is refused", lambda data: data["fields"]["owner"].update({"class": "raw-personal"})),
        ("a low-entropy hash without mitigation is refused",
         lambda data: data["fields"]["artifactHash"].update({"preimageEntropy": "low", "mitigation": ""})),
        ("user content without a warning is refused",
         lambda data: data["fields"]["title"].update({"warnings": []})),
        ("an unknown warning id is refused",
         lambda data: data["fields"]["title"].update({"warnings": ["not-a-warning"]})),
        ("a sealed field without a custodian process is refused",
         lambda data: data["fields"]["custodian"].update({"custodianProcess": ""})),
    ]
    failures = 0
    for description, change in cases:
        errors = mutated(change)
        if errors:
            print(f"  ok  [self-test] {description}")
        else:
            failures += 1
            print(f"  FAIL [self-test] {description}: the mutation was not caught")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, nargs="?", default=Path(__file__).resolve().parents[1])
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--print-fields", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()

    if args.print_fields:
        for name, paths in sorted(collect_fields(root).items()):
            print(f"{name}\t{len(paths)}\t{sorted(paths)[0]}")
        return 0

    print("Privacy field classification")
    errors = check_inventory(root)
    if errors:
        for error in errors:
            print(f"  FAIL {error}")
        print(f"Status: FAIL ({len(errors)} problem(s))")
        return 1

    inventory = load_json(root / "privacy" / "fields.json")
    fields = collect_fields(root)
    classes: dict[str, int] = {}
    for entry in inventory["fields"].values():
        classes[entry["class"]] = classes.get(entry["class"], 0) + 1
    print(f"Fields: {len(fields)} across {len(did_files(root))} interfaces")
    for name, count in sorted(classes.items()):
        print(f"  {name}: {count}")
    print("Status: PASS")

    if args.self_test:
        return self_test(root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
